require('dotenv').config();

const http = require('node:http');
const app = require('./app');

const port = Number(process.env.PORT) || 5000;
const server = http.createServer(app);

server.listen(port, '0.0.0.0', () => {
  console.log(`StemForge API is running on port ${port}`);
});