const bcrypt = require('bcrypt');
const User = require('../models/User');
const { createAccessToken } = require('../config/jwt');

async function register(req, res) {
  try {
    const { username, email, password } = req.body || {};

    if (
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string'
    ) {
      return res.status(400).json({
        message: 'username, email, and password must be strings.',
      });
    }

    const normalizedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();

    if (
      normalizedUsername.length < 2 ||
      normalizedUsername.length > 50
    ) {
      return res.status(400).json({
        message: 'Username must contain between 2 and 50 characters.',
      });
    }

    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return res.status(400).json({
        message: 'Provide a valid email address.',
      });
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return res.status(400).json({
        message: 'Password must contain at least 8 characters and at most 72 UTF-8 bytes.',
      });
    }

    await User.init();

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      username: normalizedUsername,
      email: normalizedEmail,
      passwordHash,
      role: 'user',
    });

    const accessToken = createAccessToken(user._id);

    return res.status(201).json({
      data: {
        user: user.toJSON(),
        accessToken,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'Email is already registered.',
      });
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Invalid registration data.',
      });
    }

    console.error('Registration failed:', error.name, error.code || '');

    return res.status(500).json({
      message: 'Unable to register. Please try again later.',
    });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== 'string' ||
      typeof password !== 'string'
    ) {
      return res.status(400).json({
        message: 'email and password must be strings.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return res.status(400).json({
        message: 'Provide a valid email address.',
      });
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return res.status(400).json({
        message: 'Password must contain at least 8 characters and at most 72 UTF-8 bytes.',
      });
    }

    const user = await User.findOne({
      email: normalizedEmail,
    }).select('+passwordHash');

    if (!user) {
      return res.status(401).json({
        message: 'Invalid email or password.',
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        message: 'Invalid email or password.',
      });
    }

    const accessToken = createAccessToken(user._id);

    return res.status(200).json({
      data: {
        user: user.toJSON(),
        accessToken,
      },
    });
  } catch (error) {
    console.error('Login failed:', error.name, error.code || '');

    return res.status(500).json({
      message: 'Unable to log in. Please try again later.',
    });
  }
}

function getMe(req, res) {
  return res.status(200).json({
    data: {
      user: req.user.toJSON(),
    },
  });
}

module.exports = { register, login, getMe };