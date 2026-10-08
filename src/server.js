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

const port = Number(process.env.PORT) || 5000;
const server = http.createServer(app);

async function startServer() {
  try {
    await connectDatabase();

    server.listen(port, '0.0.0.0', () => {
      console.log(`StemForge API is running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();