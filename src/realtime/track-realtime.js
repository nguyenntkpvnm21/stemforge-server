const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');
const Track = require('../models/Track');
const User = require('../models/User');
const { verifyAccessToken } = require('../config/jwt');
const events = require('../services/track-events.service');

const ID = /^[a-f\d]{24}$/i;
const messages = {
  INVALID_PAYLOAD: 'Expected exactly one valid trackId.',
  UNAUTHENTICATED: 'Authentication required or expired.',
  NOT_FOUND: 'Track not found.',
  RATE_LIMITED: 'Too many room requests.',
  INTERNAL_ERROR: 'Unable to process room request.',
};
function failure(code) { return { ok: false, error: { code, message: messages[code] } }; }
function fault(code) { return Object.assign(new Error(messages[code]), { code }); }

function attachTrackRealtime(server, options = {}) {
  const loadUser = options.loadUser || (id => User.findById(id).select('_id').maxTimeMS(5000).lean().exec());
  const loadTrack = options.loadTrack || ((id, userId) => Track.findOne({
    _id: id,
    ...(userId ? { $or: [{ isPublic: true }, { artistId: userId }] } : { isPublic: true }),
  }).select('_id artistId isPublic likesCount').maxTimeMS(5000).lean().exec());
  const verify = options.verifyToken || verifyAccessToken;
  const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
  const io = new Server(server, {
    cors: { origin },
    maxHttpBufferSize: 16384,
    // No connectionStateRecovery: every reconnect must authenticate and join again.
    allowRequest: (req, done) => done(null, !req.headers.origin || req.headers.origin === origin),
  });
  const rooms = new Map();
  const clients = new Map();
  let closing = false;

  function expired(client) { return client.expiresAt !== null && Date.now() >= client.expiresAt; }
  function broadcast(room, event, payload) {
    io.to(`track:${room.id}`).emit(event, payload);
  }
  function presence(room) {
    room.listenersSeq += 1;
    if (room.members.size) broadcast(room, 'listeners:count', {
      trackId: room.id, count: room.members.size, epoch: room.epoch, seq: room.listenersSeq,
    });
    else rooms.delete(room.id);
  }
  // All membership changes are synchronous with the default in-memory adapter.
  // No nested Track lock or wait for a socket queue (including during revocation).
  function leave(client) {
    const id = client.trackId;
    client.trackId = null;
    if (!id) return false;
    client.socket.leave(`track:${id}`);
    const room = rooms.get(id);
    if (room?.members.delete(client.socket.id)) presence(room);
    return true;
  }
  function terminate(client, notify = true) {
    leave(client);
    if (notify && client.socket.connected) client.socket.emit('auth:expired', { code: 'UNAUTHENTICATED' });
    client.socket.disconnect(true);
  }
  function scheduleExpiry(client) {
    if (client.expiresAt === null || !client.socket.connected) return;
    const delay = client.expiresAt - Date.now();
    if (delay <= 0) return terminate(client);
    client.timer = setTimeout(() => scheduleExpiry(client), Math.min(delay, 2147483647));
    client.timer.unref();
  }
  function snapshot(room, track) {
    return {
      trackId: room.id, listenersCount: room.members.size, likesCount: track.likesCount,
      epoch: room.epoch, listenersSeq: room.listenersSeq, likesSeq: room.likesSeq,
    };
  }
  async function join(client, id) {
    return events.coordinator.run(id, async () => {
      if (closing || !client.socket.connected) return null;
      if (expired(client)) throw fault('UNAUTHENTICATED');
      if (client.userId && !await loadUser(client.userId)) throw fault('UNAUTHENTICATED');
      const track = await loadTrack(id, client.userId);
      if (!client.socket.connected || closing) return null;
      if (expired(client)) throw fault('UNAUTHENTICATED');
      if (!track) {
        if (client.trackId === id) leave(client);
        throw fault('NOT_FOUND');
      }
      if (client.trackId !== id) leave(client);
      let room = rooms.get(id);
      if (!room) {
        room = { id, epoch: randomUUID(), listenersSeq: 0, likesSeq: 0, members: new Map() };
        rooms.set(id, room);
      }
      if (!room.members.has(client.socket.id)) {
        client.trackId = id;
        client.socket.join(`track:${id}`);
        room.members.set(client.socket.id, client);
        presence(room);
      }
      return snapshot(room, track);
    });
  }
  function revoke(id, track) {
    const room = rooms.get(id);
    if (!room) return;
    const removed = [...room.members.values()].filter(client =>
      !track || (!track.isPublic && client.userId !== String(track.artistId)) || expired(client));
    // Remove EVERY unauthorized member before emitting anything that might fail.
    for (const client of removed) {
      client.trackId = null;
      client.socket.leave(`track:${id}`);
      room.members.delete(client.socket.id);
    }
    if (!room.members.size) rooms.delete(id);
    else if (removed.length) presence(room);
    for (const client of removed) client.socket.emit('track:unavailable', { trackId: id, code: 'NOT_FOUND' });
  }
  const unbind = events.bindPublisher((event, id, data) => {
    if (event === 'visibility') return revoke(id, data);
    if (event === 'deleted') return revoke(id, null);
    const room = rooms.get(id);
    if (event === 'like' && room) {
      room.likesSeq += 1;
      broadcast(room, 'like:updated', { trackId: id, likesCount: data.likesCount, epoch: room.epoch, seq: room.likesSeq });
    }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      let userId = null;
      let expiresAt = null;
      if (token !== undefined) {
        if (typeof token !== 'string' || !token) throw fault('UNAUTHENTICATED');
        let payload;
        try { payload = verify(token); } catch { throw fault('UNAUTHENTICATED'); }
        if (typeof payload.sub !== 'string' || !ID.test(payload.sub) || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= Date.now()) {
          throw fault('UNAUTHENTICATED');
        }
        if (!await loadUser(payload.sub)) throw fault('UNAUTHENTICATED');
        userId = payload.sub.toLowerCase();
        expiresAt = payload.exp * 1000;
      }
      if (closing || (expiresAt !== null && expiresAt <= Date.now())) throw fault('UNAUTHENTICATED');
      socket.data.identity = { userId, expiresAt };
      next();
    } catch (error) {
      const code = messages[error.code] ? error.code : 'INTERNAL_ERROR';
      next(Object.assign(new Error(messages[code]), { data: { code } }));
    }
  });
  io.on('connection', socket => {
    const client = { socket, ...socket.data.identity, trackId: null, timer: null, pending: 0,
      tail: Promise.resolve(), windowStart: Date.now(), requests: 0 };
    clients.set(socket.id, client);
    socket.on('disconnect', () => {
      clearTimeout(client.timer);
      client.timer = null;
      leave(client);
      clients.delete(socket.id);
    });
    scheduleExpiry(client);
    for (const event of ['track:join', 'track:leave']) socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !ID.test(payload.trackId || '') || typeof payload.trackId !== 'string') {
        return ack(failure('INVALID_PAYLOAD'));
      }
      if (Date.now() - client.windowStart >= 10000) {
        client.windowStart = Date.now(); client.requests = 0;
      }
      if (++client.requests > 30 || client.pending >= 8) return ack(failure('RATE_LIMITED'));
      const id = payload.trackId.toLowerCase();
      client.pending += 1;
      client.tail = client.tail.then(async () => {
        if (!socket.connected || closing) return;
        if (expired(client)) throw fault('UNAUTHENTICATED');
        const data = event === 'track:join' ? await join(client, id) : {
          trackId: id, left: client.trackId === id ? leave(client) : false,
        };
        if (socket.connected && data) ack({ ok: true, data });
      }).catch(error => {
        const code = messages[error.code] ? error.code : 'INTERNAL_ERROR';
        if (socket.connected) ack(failure(code));
        if (code === 'UNAUTHENTICATED') terminate(client);
      }).finally(() => { client.pending -= 1; });
    });
  });
  return {
    io,
    inspect: () => ({ rooms: rooms.size, clients: clients.size,
      timers: [...clients.values()].filter(client => client.timer !== null).length,
      members: [...rooms.values()].reduce((sum, room) => sum + room.members.size, 0) }),
    async close() {
      closing = true;
      // Stop accepting HTTP and socket work; let active REST requests finish
      // while the publisher is still bound, then drain outstanding room lookups.
      await new Promise(resolve => io.close(resolve));
      await events.coordinator.idle();
      unbind();
    },
  };
}

module.exports = { attachTrackRealtime };
