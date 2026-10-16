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
      {
        name: 'Auth',
        description: 'Registration, login, and current account',
      },
      {
        name: 'Tracks',
        description: 'Track browsing and metadata',
      },
      {
  name: 'Uploads',
  description: 'Authenticated audio uploads',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste the access token received after registration or login.',
        },
      },
      schemas: {
        User: {
          type: 'object',
          required: [
            '_id',
            'username',
            'email',
            'role',
            'avatarUrl',
            'createdAt',
            'updatedAt',
          ],
          properties: {
            _id: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            username: {
              type: 'string',
              example: 'nguyen_test',
            },
            email: {
              type: 'string',
              format: 'email',
              example: 'nguyen.test@example.com',
            },
            role: {
              type: 'string',
              enum: ['user', 'admin'],
              example: 'user',
            },
            avatarUrl: {
              type: 'string',
              nullable: true,
              example: null,
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        AuthResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['user', 'accessToken'],
              properties: {
                user: {
                  $ref: '#/components/schemas/User',
                },
                accessToken: {
                  type: 'string',
                  description: 'JWT access token valid for one hour.',
                },
              },
            },
          },
        },
        UserResponse: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['user'],
              properties: {
                user: {
                  $ref: '#/components/schemas/User',
                },
              },
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['message'],
          properties: {
            message: {
              type: 'string',
              example: 'Invalid email or password.',
            },
          },
        },
      },
    },
  },
  apis: [
    path.resolve(__dirname, '../**/*.js').replace(/\\/g, '/'),
  ],
});

module.exports = swaggerSpec;