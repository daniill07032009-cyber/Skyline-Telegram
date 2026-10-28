const express = require('express');
const router = express.Router({ mergeParams: true });
const authMiddleware = require('../middleware/auth');
const { containsProfanity } = require('../services/moderation'); // <-- ИМПОРТ ФИЛЬТРА
const {
  getMessages,
  saveMessage,
  getMessageById,
  updateMessage,
  deleteMessage,
  markMessagesAsRead,
} = require('../services/messages');
const { getChatById, markChatAsRead } = require('../services/chats');

// Защита всех эндпоинтов сообщений через JWT-аутентификацию
router.use(authMiddleware);

/**
 * Хелпер для извлечения ID текущего пользователя из req.user
 */
function getReqUserId(req) {
  return String(req.user.userId || req.user.id || req.user._id);
}

function isEncryptedEnvelope(value) {
  const text = String(value);
  return text.startsWith('skyline-e2e:v4:') || text.startsWith('skyline-e2e:v3:') || text.startsWith('oursocial-e2e:v2:');
}

/**
 * Безопасное получение инстанса Socket.IO (если инициализирован)
 */
function getSocketIO() {
  try {
    const { getIO } = require('../socket');
    return getIO();
  } catch (e) {
    return null;
  }
}

/**
 * Проверка принадлежности пользователя к чату
 */
async function verifyChatMembership(chatId, userId) {
  const chat = await getChatById(chatId);
  if (!chat) {
    const err = new Error('Chat not found');
    err.status = 404;
    throw err;
  }

  const userIdStr = String(userId);
  const isMember = (chat.participants || []).map(String).includes(userIdStr);
  if (!isMember) {
    const err = new Error('Access denied: You are not a member of this chat');
    err.status = 403;
    throw err;
  }

  return chat;
}

/**
 * GET /api/chats/:id/messages (или /api/messages/:chatId)
 * Получение истории сообщений чата
 */
async function getChatMessagesHandler(req, res, next) {
  try {
    const chatId = req.chatId || req.params.id || req.params.chatId || req.query.chatId;

    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    const userId = getReqUserId(req);
    await verifyChatMembership(chatId, userId);

    const options = {
      limit: req.query.limit,
      before: req.query.before,
      after: req.query.after,
      skip: req.query.skip || req.query.offset,
      order: req.query.order || 'asc',
    };

    const messages = await getMessages(String(chatId), options);

    res.status(200).json({
      status: 'ok',
      chatId: String(chatId),
      count: messages.length,
      messages,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/', getChatMessagesHandler);
router.get('/:chatId', getChatMessagesHandler);

/**
 * POST /api/chats/:id/messages (или /api/messages/:chatId)
 * REST отправка сообщения в чат
 */
async function postMessageHandler(req, res, next) {
  try {
    const chatId = req.chatId || req.params.id || req.params.chatId || req.body.chatId;

    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    const userId = getReqUserId(req);
    const chat = await verifyChatMembership(chatId, userId);

    const encryptedText =
      req.body.encryptedText || req.body.text || req.body.content || req.body.message;

    if (!encryptedText && encryptedText !== '') {
      return res.status(400).json({ error: 'encryptedText or text is required' });
    }
    if (!isEncryptedEnvelope(encryptedText)) {
      return res.status(400).json({ error: 'Messages must use the supported end-to-end encrypted format' });
    }

    // --- ПРОВЕРКА НА МАТ ---
    if (encryptedText && !isEncryptedEnvelope(encryptedText) && containsProfanity(encryptedText)) {
      return res.status(400).json({ error: 'Сообщение содержит нецензурную лексику' });
    }
    // -----------------------

    const type = req.body.type || 'text';
    const giftId = req.body.giftId || null;
    const replyTo = req.body.replyTo || null;
    const senderName = req.user.username || req.user.name || 'Anonymous';

    const messageData = {
      chatId: String(chatId),
      senderId: String(userId),
      senderName,
      encryptedText: String(encryptedText),
      type,
      giftId,
      replyTo,
    };

    const savedMessage = await saveMessage(messageData);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${chatId}`).emit('receive_message', savedMessage);
      (chat.participants || []).forEach((pId) => {
        io.to(`user:${pId}`).emit('chat_updated', {
          chatId: String(chatId),
          lastMessage: savedMessage,
          updatedAt: savedMessage.createdAt,
        });
      });
    }

    res.status(201).json({
      status: 'ok',
      messageId: savedMessage._id,
      message: savedMessage,
    });
  } catch (err) {
    next(err);
  }
}

router.post('/', postMessageHandler);
router.post('/:chatId', postMessageHandler);

/**
 * PATCH /api/chats/:id/messages/:messageId
 */
router.patch('/:messageId', async (req, res, next) => {
  try {
    const messageId = req.params.messageId;
    const userId = getReqUserId(req);
    const newText = req.body.encryptedText || req.body.text || req.body.content;

    if (!newText && newText !== '') {
      return res.status(400).json({ error: 'encryptedText or text is required' });
    }
    if (!isEncryptedEnvelope(newText)) {
      return res.status(400).json({ error: 'Messages must use the supported end-to-end encrypted format' });
    }

    // --- ПРОВЕРКА НА МАТ ПРИ РЕДАКТИРОВАНИИ ---
    if (newText && !isEncryptedEnvelope(newText) && containsProfanity(newText)) {
      return res.status(400).json({ error: 'Сообщение содержит нецензурную лексику' });
    }
    // ------------------------------------------

    const updated = await updateMessage(messageId, userId, newText);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${updated.chatId}`).emit('message_edited', updated);
    }

    res.status(200).json({
      status: 'ok',
      message: updated,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/chats/:id/messages/:messageId
 */
router.delete('/:messageId', async (req, res, next) => {
  try {
    const messageId = req.params.messageId;
    const userId = getReqUserId(req);

    const existing = await getMessageById(messageId);
    if (!existing) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const chat = await getChatById(existing.chatId);
    const admins = (chat && chat.admins) ? chat.admins.map(String) : [];
    const isChatAdmin = admins.includes(userId) || (chat && String(chat.creatorId) === userId);

    const result = await deleteMessage(messageId, userId, isChatAdmin);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${existing.chatId}`).emit('message_deleted', {
        messageId,
        chatId: existing.chatId,
      });
    }

    res.status(200).json({
      status: 'ok',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /read
 */
router.post('/read', async (req, res, next) => {
  try {
    const chatId = req.chatId || req.params.id || req.body.chatId;
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    const userId = getReqUserId(req);
    await verifyChatMembership(chatId, userId);

    const result = await markChatAsRead(chatId, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${chatId}`).emit('messages_read', {
        chatId,
        userId,
      });
      io.to(`user:${userId}`).emit('unread_updated', {
        chatId,
        unreadCount: 0,
      });
    }

    res.status(200).json({
      status: 'ok',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
