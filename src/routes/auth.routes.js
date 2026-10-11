const express = require('express');
const {
  register,
  login,
  getMe,
} = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth.middleware');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticate, getMe);

module.exports = router;