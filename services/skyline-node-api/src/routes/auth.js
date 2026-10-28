const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDB } = require('../services/db');
const { ObjectId } = require('mongodb');
const authMiddleware = require('../middleware/auth');

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return process.env.JWT_SECRET;
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id) && id.length === 24) {
    try {
      return new ObjectId(id);
    } catch (e) {
      return id;
    }
  }
  return id;
}

/**
 * POST /api/auth/register
 * Регистрация нового пользователя
 */
router.post('/register', async (req, res, next) => {
  try {
    const { username, password, name, avatar, email, verificationToken } = req.body;

    if (!username || !password || !email || !verificationToken) {
      return res.status(400).json({ error: 'Email, username, password, and verified email token are required' });
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const cleanEmail = String(email).trim().toLowerCase();

    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username must be 3–32 letters, digits, dots, underscores, or hyphens' });
    }

    if (String(password).length < 6 || String(password).length > 128) {
      return res.status(400).json({ error: 'Password must be between 6 and 128 characters long' });
    }

    const db = getDB();
    const existing = await db.collection('users').findOne({
      $or: [{ username: cleanUsername }, { email: cleanEmail }],
    });
    if (existing) {
      return res.status(409).json({ error: 'Username or email is already taken' });
    }

    const verificationTokenHash = crypto.createHash('sha256').update(String(verificationToken)).digest('hex');
    const consumedToken = await db.collection('verified_email_tokens').findOneAndDelete({
      email: cleanEmail,
      tokenHash: verificationTokenHash,
      expiresAt: { $gt: new Date() },
    });
    if (!consumedToken) {
      return res.status(400).json({ error: 'Verify your email before registering' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = {
      username: cleanUsername,
      email: cleanEmail,
      isEmailVerified: true,
      name: name ? String(name).trim() : cleanUsername,
      avatar: avatar || null,
      avatarUrl: avatar || '',
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('users').insertOne(newUser);
    const userId = String(result.insertedId);

    const secret = getJwtSecret();
    const token = jwt.sign(
      {
        userId,
        username: newUser.username,
        email: newUser.email,
        name: newUser.name,
      },
      secret,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      status: 'ok',
      token,
      user: {
        id: userId,
        email: newUser.email,
        username: newUser.username,
        name: newUser.name,
        avatar: newUser.avatar,
        avatarUrl: newUser.avatarUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Авторизация пользователя
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    const rawLogin = username || email;

    if (!rawLogin || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    const cleanLogin = String(rawLogin).trim().toLowerCase();
    const db = getDB();
    const user = await db.collection('users').findOne({
      $or: [{ username: cleanLogin }, { email: cleanLogin }],
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userId = String(user._id);
    const secret = getJwtSecret();
    const token = jwt.sign(
      {
        userId,
        username: user.username,
        email: user.email || `${user.username}@example.com`,
        name: user.name || user.username,
      },
      secret,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      status: 'ok',
      token,
      user: {
        id: userId,
        email: user.email || `${user.username}@example.com`,
        username: user.username,
        name: user.name || user.username,
        avatar: user.avatar || null,
        avatarUrl: user.avatar || user.avatarUrl || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Получение профиля текущего авторизованного пользователя
 */
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.userId || req.user.id || req.user._id;
    const db = getDB();
    const user = await db.collection('users').findOne({
      $or: [{ _id: toObjectId(userId) }, { _id: String(userId) }],
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      status: 'ok',
      id: String(user._id),
      email: user.email || `${user.username}@example.com`,
      username: user.username,
      name: user.name || user.username,
      avatar: user.avatar || null,
      avatarUrl: user.avatar || user.avatarUrl || '',
      createdAt: user.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/users
 * Поиск и список пользователей (для быстрого создания диалогов)
 */
router.get('/users', authMiddleware, async (req, res, next) => {
  try {
    const currentUserId = String(req.user.userId || req.user.id || req.user._id);
    const search = req.query.q || req.query.search || '';
    const db = getDB();

    const query = {
      _id: { $ne: toObjectId(currentUserId) },
    };

    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ username: regex }, { name: regex }];
    }

    const users = await db
      .collection('users')
      .find(query)
      .limit(30)
      .toArray();

    const formatted = users.map((u) => ({
      id: String(u._id),
      username: u.username,
      name: u.name || u.username,
      avatar: u.avatar || null,
    }));

    res.status(200).json({
      status: 'ok',
      count: formatted.length,
      users: formatted,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /users/search
 */
router.get('/search', authMiddleware, async (req, res, next) => {
  try {
    const search = String(req.query.q || req.query.search || '').trim().slice(0, 64);
    const db = getDB();
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = search ? { username: new RegExp(escapedSearch, 'i') } : {};
    const results = await db
      .collection('users')
      .find(query, { projection: { passwordHash: 0 } })
      .limit(20)
      .toArray();

    res.json(
      results.map((u) => ({
        id: String(u._id),
        username: u.username,
        avatarUrl: u.avatar || u.avatarUrl || '',
      }))
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
