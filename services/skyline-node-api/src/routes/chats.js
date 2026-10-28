const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const {
  getUserChats,
  createChat,
  createGroupChat,
  getChatById,
  updateChat,
  addParticipantsToGroup,
  removeParticipantFromGroup,
  deleteChat,
  markChatAsRead,
  getTotalUnreadCount,
} = require('../services/chats');
const messagesRoutes = require('./messages');

// Защита всех эндпоинтов чатов через JWT-аутентификацию
router.use(authMiddleware);

/**
 * Хелпер для извлечения ID текущего пользователя из req.user
 */
function getReqUserId(req) {
  return String(req.user.userId || req.user.id || req.user._id);
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
 * GET /api/chats/unread/total
 * Получить суммарное количество непрочитанных сообщений во всех чатах
 */
router.get('/unread/total', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const total = await getTotalUnreadCount(userId);

    res.status(200).json({
      status: 'ok',
      unreadCount: total,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/chats
 * Получить список всех чатов текущего авторизованного пользователя
 * Query параметры:
 * - query / q: фильтрация по названию или собеседнику
 * - limit: количество возвращаемых чатов (по умолчанию 50)
 * - offset / skip: пропуск элементов
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const options = {
      query: req.query.query || req.query.q || req.query.search,
      limit: req.query.limit,
      offset: req.query.offset || req.query.skip,
    };

    const chats = await getUserChats(userId, options);

    res.status(200).json({
      status: 'ok',
      count: chats.length,
      chats,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/chats
 * Создать новый диалог (direct) или групповой чат (group)
 * Тело запроса:
 * 1. Direct: { participantId } или { recipientId }
 * 2. Group: { type: 'group', title: '...', avatar?: '...', participantIds: [...] }
 */
router.post('/', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const { type, title, avatar, participantIds } = req.body;
    const directParticipantId = req.body.participantId || req.body.recipientId || req.body.targetUserId;

    // Создание группового чата
    if (type === 'group' || (Array.isArray(participantIds) && participantIds.length > 1)) {
      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Group title is required' });
      }

      const groupChat = await createGroupChat(userId, {
        title,
        avatar,
        participantIds: Array.isArray(participantIds) ? participantIds : [],
      });

      // Оповещаем добавленных пользователей через сокет
      const io = getSocketIO();
      if (io && groupChat.participants) {
        groupChat.participants.forEach((pId) => {
          io.to(`user:${pId}`).emit('chat_created', groupChat);
        });
      }

      return res.status(201).json({
        status: 'ok',
        chat: groupChat,
      });
    }

    // Создание прямого (direct) чата
    if (!directParticipantId) {
      return res.status(400).json({ error: 'participantId or recipientId is required for direct chat' });
    }

    if (String(directParticipantId) === String(userId)) {
      return res.status(400).json({ error: 'Cannot create chat with yourself' });
    }

    const { chat, isNew } = await createChat(userId, directParticipantId, {
      extraData: req.body.extraData,
    });

    if (isNew) {
      const io = getSocketIO();
      if (io) {
        io.to(`user:${userId}`).emit('chat_created', chat);
        io.to(`user:${directParticipantId}`).emit('chat_created', chat);
      }
    }

    return res.status(isNew ? 201 : 200).json({
      status: 'ok',
      isNew,
      chat,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/chats/:id
 * Получить детальную информацию о конкретном чате
 */
router.get('/:id', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const chat = await getChatById(req.params.id, userId);

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const isMember = (chat.participants || []).map(String).includes(userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this chat' });
    }

    res.status(200).json({
      status: 'ok',
      chat,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/chats/:id (или PUT /api/chats/:id)
 * Обновить метаданные чата (название, аватар)
 */
const updateChatHandler = async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const updatedChat = await updateChat(req.params.id, req.body, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${req.params.id}`).emit('chat_updated', updatedChat);
      (updatedChat.participants || []).forEach((participantId) => {
        io.to(`user:${participantId}`).emit('chat_updated', updatedChat);
      });
    }

    res.status(200).json({
      status: 'ok',
      chat: updatedChat,
    });
  } catch (err) {
    next(err);
  }
};
router.patch('/:id', updateChatHandler);
router.put('/:id', updateChatHandler);

/**
 * POST /api/chats/:id/read (или PATCH /api/chats/:id/read)
 * Отметить все сообщения чата прочитанными для текущего пользователя
 */
const markReadHandler = async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const result = await markChatAsRead(req.params.id, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${req.params.id}`).emit('messages_read', {
        chatId: req.params.id,
        userId,
      });
      io.to(`user:${userId}`).emit('unread_updated', {
        chatId: req.params.id,
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
};
router.post('/:id/read', markReadHandler);
router.patch('/:id/read', markReadHandler);

/**
 * POST /api/chats/:id/participants
 * Добавить участников в групповой чат
 */
router.post('/:id/participants', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const { participantId, participantIds } = req.body;
    const toAdd = participantIds || participantId;

    if (!toAdd || (Array.isArray(toAdd) && toAdd.length === 0)) {
      return res.status(400).json({ error: 'participantId or participantIds is required' });
    }

    const updatedChat = await addParticipantsToGroup(req.params.id, toAdd, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${req.params.id}`).emit('chat_updated', updatedChat);
    }

    res.status(200).json({
      status: 'ok',
      chat: updatedChat,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/chats/:id/participants/:participantId
 * Удалить участника из группового чата или выйти самому
 */
router.delete('/:id/participants/:participantId', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const targetUserId = req.params.participantId;

    const result = await removeParticipantFromGroup(req.params.id, targetUserId, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${req.params.id}`).emit('participant_left', {
        chatId: req.params.id,
        userId: targetUserId,
      });
      io.to(`user:${targetUserId}`).emit('chat_deleted', {
        chatId: req.params.id,
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
 * DELETE /api/chats/:id
 * Удалить чат (и все его сообщения)
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = getReqUserId(req);
    const result = await deleteChat(req.params.id, userId);

    const io = getSocketIO();
    if (io) {
      io.to(`chat:${req.params.id}`).emit('chat_deleted', {
        chatId: req.params.id,
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

// Перенаправление маршрутов сообщений внутри чата: /api/chats/:id/messages
router.use('/:id/messages', (req, res, next) => {
  req.chatId = req.params.id;
  next();
}, messagesRoutes);

module.exports = router;
