const { getDB } = require('./db');
const { ObjectId } = require('mongodb');
const { updateLastMessage, recalculateLastMessage, toObjectId } = require('./chats');

/**
 * Безопасное преобразование в ObjectId MongoDB
 */
function safeObjectId(id) {
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
 * Сохранить новое сообщение в базе данных и обновить статус чата
 * @param {object} messageData - { chatId, senderId, senderName, encryptedText, type, giftId, replyTo }
 * @returns {Promise<object>} сохраненный документ сообщения
 */
async function saveMessage(messageData) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const {
    chatId,
    senderId,
    senderName,
    encryptedText,
    type = 'text',
    giftId = null,
    replyTo = null,
  } = messageData;

  const content = encryptedText !== undefined ? encryptedText : messageData.text;
  if (!chatId) throw new Error('chatId is required');
  if (!senderId) throw new Error('senderId is required');

  const senderIdStr = String(senderId);
  const chatIdStr = String(chatId);

  const newDoc = {
    chatId: chatIdStr,
    senderId: senderIdStr,
    senderName: senderName || 'Anonymous',
    encryptedText: content !== undefined && content !== null ? String(content) : '',
    type: type || 'text',
    giftId: giftId ? String(giftId) : null,
    replyTo: replyTo ? String(replyTo) : null,
    readBy: [senderIdStr],
    deliveredTo: [senderIdStr],
    deleted: false,
    isEdited: false,
    createdAt: messageData.createdAt ? new Date(messageData.createdAt) : new Date(),
  };

  const result = await db.collection('messages').insertOne(newDoc);
  const insertedId = result.insertedId;

  // Обновить lastMessage в чате
  try {
    if (typeof updateLastMessage === 'function') {
      await updateLastMessage(chatIdStr, {
        _id: insertedId,
        ...newDoc,
      });
    }
  } catch (err) {
    console.error('Failed to update chat lastMessage:', err.message);
  }

  return {
    _id: insertedId,
    ...newDoc,
  };
}

/**
 * Получить список сообщений чата с пагинацией (не удаленные)
 * @param {string} chatId
 * @param {number|object} options - limit/offset or query options
 * @returns {Promise<Array>}
 */
async function getMessages(chatId, options = 50, legacyOffset = 0) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const settings = typeof options === 'object' && options !== null
    ? options
    : { limit: options, offset: legacyOffset };
  const limit = Math.min(Math.max(Number(settings.limit) || 50, 1), 100);
  const offset = Math.max(Number(settings.offset ?? settings.skip) || 0, 0);
  const sortDirection = settings.order === 'desc' ? -1 : 1;
  const chatIdStr = String(chatId);
  const objId = safeObjectId(chatId);
  const query = {
    $or: [{ chatId: chatIdStr }, { chatId: objId }],
    deleted: { $ne: true },
  };

  if (settings.before || settings.after) {
    const createdAt = {};
    if (settings.before) {
      const before = new Date(settings.before);
      if (!Number.isNaN(before.getTime())) createdAt.$lt = before;
    }
    if (settings.after) {
      const after = new Date(settings.after);
      if (!Number.isNaN(after.getTime())) createdAt.$gt = after;
    }
    if (Object.keys(createdAt).length > 0) query.createdAt = createdAt;
  }

  return db.collection('messages')
    .find(query)
    .sort({ createdAt: sortDirection, _id: sortDirection })
    .skip(offset)
    .limit(limit)
    .toArray();
}

/**
 * Найти сообщение по ID
 * @param {string} messageId
 * @returns {Promise<object|null>}
 */
async function getMessageById(messageId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const objId = safeObjectId(messageId);
  return db.collection('messages').findOne({
    $or: [{ _id: objId }, { _id: String(messageId) }],
  });
}

/**
 * Пометить сообщение прочитанным пользователем
 * @param {string} messageId
 * @param {string} userId
 */
async function markAsRead(messageId, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const objId = safeObjectId(messageId);
  const userIdStr = String(userId);

  const result = await db.collection('messages').updateOne(
    {
      $or: [{ _id: objId }, { _id: String(messageId) }],
    },
    { $addToSet: { readBy: userIdStr } }
  );

  return result.modifiedCount > 0;
}

/**
 * Пометить сообщение доставленным пользователю
 * @param {string} messageId
 * @param {string} userId
 */
async function markAsDelivered(messageId, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const objId = safeObjectId(messageId);
  const userIdStr = String(userId);

  const result = await db.collection('messages').updateOne(
    {
      $or: [{ _id: objId }, { _id: String(messageId) }],
    },
    { $addToSet: { deliveredTo: userIdStr } }
  );

  return result.modifiedCount > 0;
}

/**
 * Удалить сообщение (soft delete)
 * @param {string} messageId
 * @param {string} userId
 * @param {boolean} isChatAdmin
 */
async function deleteMessage(messageId, userId, isChatAdmin = false) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const message = await getMessageById(messageId);
  if (!message) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }

  const isAuthor = String(message.senderId) === String(userId);
  if (!isAuthor && !isChatAdmin) {
    const err = new Error('Access denied: You can only delete your own messages or be a chat admin');
    err.status = 403;
    throw err;
  }

  const objId = safeObjectId(messageId);
  await db.collection('messages').updateOne(
    {
      $or: [{ _id: objId }, { _id: String(messageId) }],
    },
    {
      $set: {
        deleted: true,
        deletedAt: new Date(),
      },
    }
  );

  // Пересчитываем lastMessage в чате
  try {
    if (typeof recalculateLastMessage === 'function') {
      await recalculateLastMessage(message.chatId);
    }
  } catch (err) {
    console.error('Failed to recalculate chat lastMessage:', err.message);
  }

  return { success: true, messageId: String(messageId), chatId: String(message.chatId) };
}

/**
 * Получить количество непрочитанных сообщений в чате
 * @param {string} chatId
 * @param {string} userId
 */
async function getUnreadCount(chatId, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const chatIdStr = String(chatId);
  const userIdStr = String(userId);
  const objId = safeObjectId(chatId);

  return db.collection('messages').countDocuments({
    $or: [{ chatId: chatIdStr }, { chatId: objId }],
    deleted: { $ne: true },
    senderId: { $ne: userIdStr },
    readBy: { $ne: userIdStr },
  });
}

/**
 * Отредактировать текст сообщения
 * @param {string} messageId
 * @param {string} userId
 * @param {string} newEncryptedText
 */
async function updateMessage(messageId, userId, newEncryptedText) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const message = await getMessageById(messageId);
  if (!message) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }

  if (String(message.senderId) !== String(userId)) {
    const err = new Error('Access denied: You can only edit your own messages');
    err.status = 403;
    throw err;
  }

  const objId = safeObjectId(messageId);
  await db.collection('messages').updateOne(
    {
      $or: [{ _id: objId }, { _id: String(messageId) }],
    },
    {
      $set: {
        encryptedText: String(newEncryptedText),
        isEdited: true,
        editedAt: new Date(),
      },
    }
  );

  // Обновляем lastMessage если это было последнее сообщение
  try {
    if (typeof recalculateLastMessage === 'function') {
      await recalculateLastMessage(message.chatId);
    }
  } catch (err) {
    console.error('Failed to recalculate last message on update:', err.message);
  }

  return {
    ...message,
    encryptedText: String(newEncryptedText),
    isEdited: true,
    editedAt: new Date(),
  };
}

/**
 * Пометить сообщения в чате прочитанными пользователем
 * @param {string} chatId
 * @param {string} userId
 */
async function markMessagesAsRead(chatId, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const userIdStr = String(userId);
  const chatIdStr = String(chatId);
  const objId = safeObjectId(chatId);

  await db.collection('messages').updateMany(
    {
      $or: [{ chatId: chatIdStr }, { chatId: objId }],
      readBy: { $ne: userIdStr },
    },
    {
      $addToSet: { readBy: userIdStr },
    }
  );

  return { success: true, chatId: chatIdStr, userId: userIdStr };
}

module.exports = {
  saveMessage,
  getMessages,
  getMessageById,
  markAsRead,
  markAsDelivered,
  deleteMessage,
  getUnreadCount,
  updateMessage,
  markMessagesAsRead,
};