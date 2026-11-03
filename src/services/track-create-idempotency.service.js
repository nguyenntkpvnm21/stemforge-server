const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Receipt = require('../models/TrackCreateIdempotency');
const Track = require('../models/Track');
const responses = require('./track-response.service');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const TRANSACTION_MS = 10000;
const LOOKUP_MS = 2000;
const INVALID_KEY_CHARACTER = /[^A-Za-z0-9._:-]/;
const MESSAGES = Object.freeze({
  invalid: "Idempotency-Key must be a single 16-128 character value using letters, digits, '.', '_', ':' or '-'.",
  mismatch: 'Idempotency-Key was already used with a different Track payload.',
  busy: 'Track creation for this key is still being resolved. Retry with the same key and payload.',
  unknown: 'Unable to confirm Track creation. Retry with the same Idempotency-Key and payload.',
});

class IdempotencyError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.name = 'IdempotencyError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
const unknown = () => new IdempotencyError(503, MESSAGES.unknown, 1);

function parseKey(req) {
  const raw = req.rawHeaders || [];
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index].toLowerCase() === 'idempotency-key') count += 1;
  }
  const value = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
  if (count === 0 && value === undefined) return undefined;
  if (count > 1 || typeof value !== 'string' || value.length < 16 || value.length > 128 ||
      INVALID_KEY_CHARACTER.test(value)) {
    throw new IdempotencyError(400, MESSAGES.invalid);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const payloadHash = payload => digest('track-create:v1\n' + canonical(payload));

function errorChain(error) {
  const chain = [];
  for (let item = error; item && chain.length < 6 && !chain.includes(item); item = item.cause) chain.push(item);
  return chain;
}
function hasLabel(error, label) {
  return errorChain(error).some(item => item.hasErrorLabel?.(label) || item.errorLabels?.includes(label));
}
function ledgerDuplicate(error) {
  if (error.code !== 11000) return false;
  if (error.keyPattern) {
    return Object.keys(error.keyPattern).length === 2 &&
      error.keyPattern.ownerId === 1 && error.keyPattern.keyHash === 1;
  }
  return /index:\s+unique_owner_track_create_key\s+dup key:/.test(error.message || '');
}
class ReceiptChanged extends Error {}

function createService({
  receiptModel = Receipt, trackModel = Track, connection = mongoose.connection,
  responseService = responses, clock = () => new Date(),
} = {}) {
  const lookup = filter => receiptModel.findOne(filter).read('primary').readConcern('majority')
    .setOptions({ timeoutMS: LOOKUP_MS }).lean().exec();

  function inspect(row, filter, requestHash) {
    if (!row) return null;
    const expiresAt = new Date(row.expiresAt);
    const completedAt = new Date(row.completedAt);
    const data = row.responseBody?.data;
    if (row.hashVersion !== 1 || !Number.isFinite(expiresAt.getTime()) ||
        !Number.isFinite(completedAt.getTime()) || expiresAt <= completedAt ||
        !/^[a-f0-9]{64}$/.test(row.requestHash) || String(row.ownerId) !== String(filter.ownerId) ||
        row.keyHash !== filter.keyHash || String(data?._id) !== String(row.trackId) ||
        String(data?.artistId) !== String(filter.ownerId) || !Array.isArray(data?.stems)) throw unknown();
    if (expiresAt <= clock()) return null;
    if (row.requestHash !== requestHash) throw new IdempotencyError(409, MESSAGES.mismatch);
    return { body: row.responseBody, expiresAt, replayed: true };
  }

  return async function create({ ownerId, key, payload }) {
    const filter = { ownerId, keyHash: digest(key) };
    const requestHash = payloadHash(payload);
    let row;
    try { row = await lookup(filter); } catch { throw unknown(); }
    const replay = inspect(row, filter, requestHash);
    if (replay) return replay;
    try {
      return await connection.transaction(async session => {
        const previous = await receiptModel.findOne(filter).session(session).lean().exec();
        const existing = inspect(previous, filter, requestHash);
        if (existing) return existing;
        const [track] = await trackModel.create([{
          ...payload, artistId: ownerId, likesCount: 0,
        }], { session });
        const [data] = await responseService.enrichTracks([track], ownerId, session);
        // Match Express JSON serialization, including ObjectIds and dates. The
        // enrichment service already restricts artist to its public allowlist.
        const body = JSON.parse(JSON.stringify({ data }));
        const completedAt = clock();
        const expiresAt = new Date(completedAt.getTime() + RETENTION_MS);
        const receipt = { ...filter, requestHash, hashVersion: 1, trackId: track._id,
          responseBody: body, completedAt, expiresAt };
        if (previous) {
          const updated = await receiptModel.updateOne({
            ...filter, _id: previous._id, expiresAt: previous.expiresAt,
          }, { $set: { requestHash, hashVersion: 1, trackId: track._id,
            responseBody: body, completedAt, expiresAt } },
          { session, upsert: false, runValidators: true }).exec();
          if (updated.matchedCount !== 1) throw new ReceiptChanged();
        } else {
          await receiptModel.create([receipt], { session });
        }
        return { body, expiresAt, replayed: false };
      }, { readPreference: 'primary', readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }, timeoutMS: TRANSACTION_MS });
    } catch (error) {
      if (error instanceof IdempotencyError || error.name === 'ValidationError') throw error;
      // A duplicate on a different index is an unrelated application/DB error.
      const duplicateError = errorChain(error).find(item => item.code === 11000);
      if (duplicateError && !ledgerDuplicate(duplicateError)) throw error;
      const uncertain = hasLabel(error, 'UnknownTransactionCommitResult');
      const contended = !uncertain && (ledgerDuplicate(duplicateError || error) || error instanceof ReceiptChanged ||
        hasLabel(error, 'TransientTransactionError') || error.code === 112);
      const databaseError = errorChain(error).some(item => /^Mongo/.test(item.name || ''));
      if (!uncertain && !contended && !databaseError) throw error;
      // Never re-run the mutation or remove a key after an uncertain commit.
      let resolved;
      try { resolved = await lookup(filter); } catch { throw unknown(); }
      const receipt = inspect(resolved, filter, requestHash);
      if (receipt) return receipt;
      if (contended) throw new IdempotencyError(409, MESSAGES.busy, 1);
      throw unknown();
    }
  };
}

module.exports = {
  parseKey, payloadHash, canonical, digest, ledgerDuplicate, hasLabel, createService,
  createTrackWithKey: createService(), IdempotencyError, MESSAGES,
  RETENTION_MS, TRANSACTION_MS, LOOKUP_MS,
};
