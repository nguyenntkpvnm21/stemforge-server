const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

const swaggerSpec = swaggerJsdoc({
  failOnErrors: true,
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'StemForge API',
      version: '1.0.0',
      description: 'API documentation for the StemForge application.',
    },
    servers: [
      {
        url: '/',
        description: 'Current server',
      },
    ],
    tags: [
      {
        name: 'Health',
        description: 'Service health checks',
      },
    ],
  },
  apis: [
    path.resolve(__dirname, '../**/*.js').replace(/\\/g, '/'),
  ],
});

module.exports = swaggerSpec;