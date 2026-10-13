const express = require('express');
const {
  register,
  login,
  getMe,
} = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth.middleware');
const authRateLimiter = require('../middlewares/auth-rate-limit.middleware');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');

  if (process.env.PROXY_DEBUG === 'true') {
    console.info(
      'Auth proxy diagnostic:',
      JSON.stringify({
        trustProxyHops: req.app.get('trust proxy'),
        clientIp: req.ip,
        proxyIps: req.ips,
        socketIp: req.socket.remoteAddress,
        forwardedFor: req.get('x-forwarded-for') || null,
      })
    );
  }

  next();
});

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new account
 *     description: Creates a user account and returns an access token. The server assigns the user role.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 50
 *                 example: nguyen_test
 *               email:
 *                 type: string
 *                 format: email
 *                 maxLength: 254
 *                 example: nguyen.test@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 writeOnly: true
 *                 minLength: 8
 *                 description: At least 8 characters and at most 72 UTF-8 bytes. Spaces are preserved.
 *     responses:
 *       '201':
 *         description: Account created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       '400':
 *         description: Invalid registration data or malformed JSON request body.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '409':
 *         description: Email is already registered.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '413':
 *         description: The JSON request body exceeds the parser size limit.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '429':
 *         description: The shared limit of 20 registration and login requests per IP within 15 minutes has been exceeded.
 *         headers:
 *           Retry-After:
 *             description: Seconds to wait before retrying.
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Registration failed because of a server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/register', authRateLimiter, register);

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in to an existing account
 *     description: Returns account information and an access token valid for one hour.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 maxLength: 254
 *                 example: nguyen.test@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 writeOnly: true
 *                 minLength: 8
 *                 description: At least 8 characters and at most 72 UTF-8 bytes. Spaces are preserved.
 *     responses:
 *       '200':
 *         description: Login successful.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       '400':
 *         description: Invalid login data or malformed JSON request body.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Invalid email or password.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '413':
 *         description: The JSON request body exceeds the parser size limit.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '429':
 *         description: The shared limit of 20 registration and login requests per IP within 15 minutes has been exceeded.
 *         headers:
 *           Retry-After:
 *             description: Seconds to wait before retrying.
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Login failed because of a server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/login', authRateLimiter, login);

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the current account
 *     description: Requires a valid access token and an existing account.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Current account information.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserResponse'
 *       '401':
 *         description: Access token is missing, invalid, or expired, or the account no longer exists.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Authentication failed because of a server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/me', authenticate, getMe);

module.exports = router;