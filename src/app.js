const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
);

app.use(express.json());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Check whether the API is running
 *     description: Returns the service status. Does not actively check external services.
 *     responses:
 *       '200':
 *         description: The API is running.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - status
 *                 - service
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 service:
 *                   type: string
 *                   example: stemforge-server
 */
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