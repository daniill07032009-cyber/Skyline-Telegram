const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { containsProfanity } = require('./services/moderation'); // <-- ИМПОРТ ФИЛЬТРА
const {
  saveMessage,
  getMessageById,
  markAsRead,
  markAsDelivered,
  deleteMessage,
} = require('./services/messages');
const { getChatById, markChatAsRead } = require('./services/chats');

let io = null;

const onlineUsers = new Map();

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: [
        ...(process.env.FRONTEND_URL || 'https://pipipipipi.3utilities.com').split(',').map((origin) => origin.trim().replace(/\/$/, '')),
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ],
      methods: ['GET', 'POST'],
    },
  });

  // JWT-аутентификация при подключении
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return next(new Error('No token provided'));
    }

    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) return next(new Error('JWT_SECRET is not configured'));
      const decoded = jwt.verify(token, secret);
      const userId = decoded.userId || decoded.id || decoded._id;
      if (!userId) return next(new Error('Invalid token'));

      socket.userId = String(userId);
      socket.username = decoded.username || decoded.name || 'Anonymous';
      next();
    } catch (err) {
      console.error('❌ Socket authentication failed:', err.message);
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.userId} (${socket.username})`);

    // Отслеживание онлайн-статуса
    if (!onlineUsers.has(socket.userId)) {
      onlineUsers.set(socket.userId, new Set());
      io.emit('user_online', {
        userId: socket.userId,
        username: socket.username,
      });
    }
    onlineUsers.get(socket.userId).add(socket.id);

    // Личная комната пользователя для персональных событий
    socket.join(`user:${socket.userId}`);

    // Присоединиться к комнате чата
    socket.on('join_chat', async ({ chatId } = {}, callback) => {
      if (!chatId) {
        if (callback) callback({ status: 'error', error: 'chatId is required' });
        return;
      }
      try {
        const chat = await getChatById(chatId);
        const isMember = chat && (chat.participants || []).map(String).includes(socket.userId);
        if (!isMember) {
          if (callback) callback({ status: 'error', error: 'Access denied: not a member of this chat' });
          return;
        }
        socket.join(`chat:${chatId}`);
        if (callback) callback({ status: 'ok', chatId: String(chatId) });
      } catch (err) {
        console.error('❌ join_chat error:', err);
        if (callback) callback({ status: 'error', error: 'Unable to join chat' });
      }
    });

    // Выйти из комнаты чата
    socket.on('leave_chat', ({ chatId }) => {
      if (!chatId) return;
      socket.leave(`chat:${chatId}`);
      console.log(`User ${socket.userId} left chat ${chatId}`);
    });

    // Отправка сообщения
    socket.on('send_message', async (data, callback) => {
      try {
        const {
          chatId,
          encryptedText,
          text,
          type = 'text',
          giftId = null,
          replyTo = null,
        } = data || {};

        const content = encryptedText !== undefined ? encryptedText : text;
        if (!chatId || (content === undefined || content === null || content === '')) {
          if (callback) {
            callback({ status: 'error', error: 'chatId and encryptedText/text required' });
          }
          return;
        }

        // --- ПРОВЕРКА НА МАТ ---
        const contentText = String(content);
        if (contentText.length > 1_000_000) {
          if (callback) callback({ status: 'error', error: 'Message is too large' });
          return;
        }

        if (!contentText.startsWith('skyline-e2e:v4:')
          && !contentText.startsWith('skyline-e2e:v3:')
          && !contentText.startsWith('oursocial-e2e:v2:')) {
          if (callback) callback({ status: 'error', error: 'Messages must use the supported end-to-end encrypted format' });
          return;
        }

        const messageType = ['text', 'image', 'gift'].includes(type) ? type : null;
        if (!messageType) {
          if (callback) callback({ status: 'error', error: 'Unsupported message type' });
          return;
        }

        const isEncryptedEnvelope = contentText.startsWith('skyline-e2e:v3:') || contentText.startsWith('oursocial-e2e:v2:');
        if (content && !isEncryptedEnvelope && containsProfanity(contentText)) {
          console.log(`❌ Сообщение отклонено (мат) от ${socket.userId}`);
          if (callback) callback({ status: 'error', error: 'Сообщение содержит нецензурную лексику' });
          return;
        }
        // -----------------------

        let chat;
        try {
          chat = await getChatById(chatId);
          const isMember = chat && (chat.participants || []).map(String).includes(socket.userId);
          if (!isMember) {
            if (callback) callback({ status: 'error', error: 'Access denied: not a member of this chat' });
            return;
          }
        } catch (e) {
          console.error('❌ send_message membership check failed:', e);
          if (callback) callback({ status: 'error', error: 'Unable to verify chat membership' });
          return;
        }

        const message = {
          chatId: String(chatId),
          senderId: socket.userId,
          senderName: socket.username,
          encryptedText: String(content),
          type: messageType,
          giftId: giftId ? String(giftId) : null,
          replyTo: replyTo ? String(replyTo) : null,
          createdAt: new Date(),
        };

        const savedMessage = await saveMessage(message);
        const messageId = savedMessage._id;

        const broadcastMessage = {
          ...savedMessage,
        };

        // Отправить всем в комнате чата, включая отправителя
        io.to(`chat:${chatId}`).emit('receive_message', broadcastMessage);

        // Оповестить участников об обновлении списка чатов
        if (chat && chat.participants) {
          chat.participants.forEach((pId) => {
            io.to(`user:${pId}`).emit('chat_updated', {
              chatId: String(chatId),
              lastMessage: broadcastMessage,
              updatedAt: broadcastMessage.createdAt,
            });
          });
        }

        if (callback) callback({ status: 'ok', messageId: String(messageId), message: broadcastMessage });
      } catch (err) {
        console.error('❌ send_message error:', err);
        if (callback) callback({ status: 'error', error: err.message });
      }
    });

    // Отметка сообщения как прочитанного
    socket.on('mark_read', async ({ messageId }) => {
      try {
        if (!messageId) return;
        const message = await getMessageById(messageId);
        if (!message) return;
        const chat = await getChatById(message.chatId);
        if (!chat || !(chat.participants || []).map(String).includes(socket.userId)) return;
        const ok = await markAsRead(messageId, socket.userId);
        if (ok) {
          io.to(`chat:${message.chatId}`).emit('message_read', { messageId, userId: socket.userId });
        }
      } catch (err) {
        console.error('❌ mark_read error:', err);
      }
    });

    // Отметка чата как прочитанного (пакетно)
    socket.on('mark_as_read', async ({ chatId }, callback) => {
      try {
        if (!chatId) return;
        const chat = await getChatById(chatId);
        if (!chat || !(chat.participants || []).map(String).includes(socket.userId)) {
          if (callback) callback({ status: 'error', error: 'Access denied: not a member of this chat' });
          return;
        }
        if (typeof markChatAsRead === 'function') {
          await markChatAsRead(chatId, socket.userId);
        }

        io.to(`chat:${chatId}`).emit('messages_read', {
          chatId,
          userId: socket.userId,
        });

        io.to(`user:${socket.userId}`).emit('unread_updated', {
          chatId,
          unreadCount: 0,
        });

        if (callback) callback({ status: 'ok', chatId });
      } catch (err) {
        if (callback) callback({ status: 'error', error: err.message });
      }
    });

    // Отметка сообщения как доставленного
    socket.on('mark_delivered', async ({ messageId }) => {
      try {
        if (!messageId) return;
        const message = await getMessageById(messageId);
        if (!message) return;
        const chat = await getChatById(message.chatId);
        if (!chat || !(chat.participants || []).map(String).includes(socket.userId)) return;
        const ok = await markAsDelivered(messageId, socket.userId);
        if (ok) {
          io.to(`chat:${message.chatId}`).emit('message_delivered', { messageId, userId: socket.userId });
        }
      } catch (err) {
        console.error('❌ mark_delivered error:', err);
      }
    });

    // Удаление сообщения
    socket.on('delete_message', async ({ messageId }) => {
      try {
        if (!messageId) return;
        const message = await getMessageById(messageId);
        if (!message) return;
        const ok = await deleteMessage(messageId, socket.userId);
        if (ok) {
          io.to(`chat:${message.chatId}`).emit('message_deleted', {
            messageId,
            chatId: String(message.chatId),
            userId: socket.userId,
          });
        }
      } catch (err) {
        console.error('❌ delete_message error:', err);
      }
    });

    // Индикатор набора текста
    socket.on('typing', ({ chatId }) => {
      if (!chatId || !socket.rooms.has(`chat:${chatId}`)) return;
      socket.to(`chat:${chatId}`).emit('user_typing', {
        userId: socket.userId,
        username: socket.username,
        chatId,
      });
    });

    // Отключение
    socket.on('disconnect', () => {
      console.log(`❌ User disconnected: ${socket.userId}`);

      const sockets = onlineUsers.get(socket.userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(socket.userId);
          io.emit('user_offline', { userId: socket.userId });
        }
      }
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

function getOnlineUsers() {
  return Array.from(onlineUsers.keys());
}

module.exports = { initSocket, getIO, getOnlineUsers };
