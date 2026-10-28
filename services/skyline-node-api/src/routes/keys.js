const express = require('express');
const router = express.Router();
const { getDB } = require('../services/db');
const authMiddleware = require('../middleware/auth');

/**
 * POST /keys/upload or /api/keys/upload
 * Загрузка публичного ключа пользователя
 */
router.post('/upload', authMiddleware, async (req, res, next) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ error: 'publicKey is required' });
    }

    const userId = String(req.user.userId || req.user.id || req.user._id);
    const db = getDB();

    await db.collection('keys').updateOne(
      { userId },
      {
        $set: {
          userId,
          publicKey: typeof publicKey === 'string' ? publicKey : JSON.stringify(publicKey),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    res.json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /keys/me or /api/keys/me
 * Получить свой публичный ключ
 */
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const userId = String(req.user.userId || req.user.id || req.user._id);
    const db = getDB();
    const doc = await db.collection('keys').findOne({ userId });

    if (!doc) {
      return res.status(404).json({ error: 'Key not found' });
    }

    res.json({
      userId: doc.userId,
      publicKey: doc.publicKey,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /keys/exchange or /api/keys/exchange
 * Обмен публичными ключами между собеседниками
 */
router.post('/exchange', authMiddleware, async (req, res, next) => {
  try {
    const currentUserId = String(req.user.userId || req.user.id || req.user._id);
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId is required' });
    }

    const db = getDB();
    const myKey = await db.collection('keys').findOne({ userId: currentUserId });
    const targetKey = await db.collection('keys').findOne({ userId: String(targetUserId) });

    if (!myKey) {
      return res.status(404).json({ error: 'Your key not found. Upload it first.' });
    }
    if (!targetKey) {
      return res.status(404).json({ error: 'Target user has no public key' });
    }

    res.json({
      myKey: myKey.publicKey,
      targetKey: targetKey.publicKey,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /keys/:userId or /api/keys/:userId
 * Получить публичный ключ пользователя по ID
 */
router.get('/:userId', async (req, res, next) => {
  try {
    const userId = String(req.params.userId);
    const db = getDB();
    const doc = await db.collection('keys').findOne({ userId });

    if (!doc) {
      return res.status(404).json({ error: 'Key not found' });
    }

    res.json({
      userId: doc.userId,
      publicKey: doc.publicKey,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
