require('dotenv').config();

const dns = require('node:dns');

if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  dns.setServers(servers);
}

const http = require('node:http');
const app = require('./app');
const connectDatabase = require('./config/database');
const TrackLike = require('./models/TrackLike');
const mongoose = require('mongoose');
const { attachTrackRealtime } = require('./realtime/track-realtime');

const port = Number(process.env.PORT) || 5000;
const server = http.createServer(app);
let realtime;
let stopping = false;

async function stopServer() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  try {
    if (realtime) await realtime.close();
    else if (server.listening) await new Promise(resolve => server.close(resolve));
  } finally {
    await mongoose.disconnect();
    clearTimeout(deadline);
  }
}

async function startServer() {
  try {
    await connectDatabase();
    if (stopping) return;
    await TrackLike.init();
    if (stopping) return;
    realtime = attachTrackRealtime(server);

    console.log('TrackLike indexes ready.');

    server.listen(port, '0.0.0.0', () => {
      console.log(`StemForge API is running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

process.once('SIGTERM', stopServer);
process.once('SIGINT', stopServer);
startServer();
