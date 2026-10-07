const express = require('express');
const cors = require('cors');

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'stemforge-server',
  });
});

app.use((req, res) => {
  res.status(404).json({
    message: 'Route not found',
  });
});

module.exports = app;