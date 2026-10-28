const { getDB } = require('./db');
const { ObjectId } = require('mongodb');

/**
 * Безопасное преобразование в ObjectId MongoDB
 */
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
 * Получить данные пользователей по массиву их ID (если коллекция users существует в БД)
 * @param {Array<string>} userIds
 * @returns {Promise<Map<string, object>>}
 */
async function getUsersMap(userIds = []) {
  const usersMap = new Map();
  if (!userIds || userIds.length === 0) return usersMap;

  try {
    const db = getDB();
    if (!db) return usersMap;

    const stringIds = userIds.map(String);
    const objectIds = userIds.map(toObjectId).filter((id) => id instanceof ObjectId);

    const query = {
      $or: [
        { _id: { $in: objectIds } },
        { _id: { $in: stringIds } },
        { id: { $in: stringIds } },
        { userId: { $in: stringIds } },
      ],
    };

    const users = await db.collection('users').find(query).toArray();
    users.forEach((u) => {
      const key = String(u._id || u.id || u.userId);
      usersMap.set(key, {
        id: key,
        username: u.username || u.name || 'Пользователь',
        name: u.name || u.username || 'Пользователь',
        avatar: u.avatar || u.avatarUrl || null,
        isOnline: Boolean(u.isOnline),
      });
    });
  } catch (err) {
    // Если коллекция users отсутствует или пуста, продолжаем без падения
  }

  return usersMap;
}

/**
 * Обогащает документ чата метаданными для текущего пользователя:
 * - opponent (собеседник в direct-чате)
 * - title и avatar (динамические для direct-чатов, если не заданы явно)
 * - unreadCount для текущего пользователя
 * - participantDetails (список профилей участников)
 */
async function enrichChat(chat, currentUserId, usersMap = null) {
  if (!chat) return null;

  const currentIdStr = String(currentUserId);
  const participants = (chat.participants || []).map(String);

  if (!usersMap) {
    usersMap = await getUsersMap(participants);
  }

  const participantDetails = participants.map((id) => {
    return (
      usersMap.get(id) || {
        id,
        username: `user_${id.slice(-4)}`,
        name: `Пользователь ${id.slice(-4)}`,
        avatar: null,
      }
    );
  });

  const unreadCount =
    (chat.unreadCounts && typeof chat.unreadCounts[currentIdStr] === 'number')
      ? chat.unreadCounts[currentIdStr]
      : 0;

  let title = chat.title || '';
  let avatar = chat.avatar || null;
  let opponent = null;

  if (chat.type === 'direct') {
    const opponentId = participants.find((id) => id !== currentIdStr) || currentIdStr;
    opponent = usersMap.get(opponentId) || {
      id: opponentId,
      username: `user_${opponentId.slice(-4)}`,
      name: `Пользователь ${opponentId.slice(-4)}`,
      avatar: null,
    };
    if (!title) {
      title = opponent.name || opponent.username;
    }
    if (!avatar) {
      avatar = opponent.avatar;
    }
  } else if (!title) {
    title = 'Групповой чат';
  }

  return {
    ...chat,
    _id: String(chat._id),
    title,
    avatar,
    opponent,
    participantDetails,
    unreadCount,
    admins: (chat.admins || []).map(String),
    creatorId: chat.creatorId ? String(chat.creatorId) : null,
  };
}

/**
 * Получить список всех чатов конкретного пользователя с фильтрацией и обогащением
 * @param {string} userId - ID пользователя
 * @param {object} options - { query, limit, skip }
 * @returns {Promise<Array>} список чатов
 */
async function getUserChats(userId, options = {}) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const idStr = String(userId);
  const objId = toObjectId(userId);

  const orConditions = [{ participants: idStr }];
  if (objId && objId !== idStr) {
    orConditions.push({ participants: objId });
  }

  const filter = { $or: orConditions };

  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 100);
  const skip = Math.max(parseInt(options.skip || options.offset, 10) || 0, 0);

  const rawChats = await db
    .collection('chats')
    .find(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  if (rawChats.length === 0) {
    return [];
  }

  // Собираем всех участников всех чатов для пакетной выборки пользователей
  const allParticipantIds = new Set();
  rawChats.forEach((c) => {
    (c.participants || []).forEach((p) => allParticipantIds.add(String(p)));
  });

  const usersMap = await getUsersMap(Array.from(allParticipantIds));

  let enrichedChats = await Promise.all(
    rawChats.map((chat) => enrichChat(chat, idStr, usersMap))
  );

  // Фильтрация по поисковому запросу (по названию или имени собеседника)
  if (options.query) {
    const q = String(options.query).toLowerCase().trim();
    enrichedChats = enrichedChats.filter((chat) => {
      const matchTitle = chat.title && chat.title.toLowerCase().includes(q);
      const matchOpponent =
        chat.opponent &&
        ((chat.opponent.name && chat.opponent.name.toLowerCase().includes(q)) ||
          (chat.opponent.username && chat.opponent.username.toLowerCase().includes(q)));
      return matchTitle || matchOpponent;
    });
  }

  return enrichedChats;
}

/**
 * Создать новый личный (direct) чат или вернуть существующий между двумя пользователями
 * @param {string} userId - ID создателя
 * @param {string} participantId - ID собеседника
 * @param {object} extraData - дополнительные поля
 * @returns {Promise<{ chat: object, isNew: boolean }>}
 */
async function createChat(userId, participantId, extraData = {}) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const p1 = String(userId);
  const p2 = String(participantId);

  if (p1 === p2) {
    throw new Error('Cannot create chat with yourself');
  }

  // Проверяем, существует ли уже прямой диалог между этими двумя пользователями
  const existingChat = await db.collection('chats').findOne({
    type: 'direct',
    participants: { $all: [p1, p2], $size: 2 },
  });

  if (existingChat) {
    const enriched = await enrichChat(existingChat, p1);
    return { chat: enriched, isNew: false };
  }

  const unreadCounts = {
    [p1]: 0,
    [p2]: 0,
  };

  const newChat = {
    type: 'direct',
    participants: [p1, p2],
    unreadCounts,
    lastMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extraData,
  };

  const result = await db.collection('chats').insertOne(newChat);
  const createdDoc = { _id: result.insertedId, ...newChat };
  const enriched = await enrichChat(createdDoc, p1);

  return { chat: enriched, isNew: true };
}

/**
 * Создать групповой чат
 * @param {string} creatorId - ID создателя группы
 * @param {object} params - { title, avatar, participantIds }
 * @returns {Promise<object>} созданный чат
 */
async function createGroupChat(creatorId, { title, avatar = null, participantIds = [] }) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const creatorStr = String(creatorId);

  const cleanTitle = (title || '').trim();
  if (!cleanTitle) {
    throw new Error('Group chat title is required');
  }

  // Исключаем дубликаты и создателя из participantIds, затем добавляем создателя
  const set = new Set([creatorStr]);
  participantIds.forEach((id) => {
    if (id) set.add(String(id));
  });

  const participants = Array.from(set);
  const unreadCounts = {};
  participants.forEach((p) => {
    unreadCounts[p] = 0;
  });

  const newChat = {
    type: 'group',
    title: cleanTitle,
    avatar: avatar || null,
    creatorId: creatorStr,
    admins: [creatorStr],
    participants,
    unreadCounts,
    lastMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection('chats').insertOne(newChat);
  const createdDoc = { _id: result.insertedId, ...newChat };

  return enrichChat(createdDoc, creatorStr);
}

/**
 * Найти чат по его идентификатору
 * @param {string} chatId
 * @param {string|null} currentUserId - если передан, возвращает обогащенный объект
 * @returns {Promise<object|null>}
 */
async function getChatById(chatId, currentUserId = null) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const objId = toObjectId(chatId);

  const chat = await db.collection('chats').findOne({
    $or: [
      { _id: objId },
      { _id: String(chatId) },
    ],
  });

  if (!chat) return null;

  if (currentUserId) {
    return enrichChat(chat, currentUserId);
  }

  return chat;
}

/**
 * Обновить метаданные чата (название, аватар)
 * @param {string} chatId
 * @param {object} updateData - { title, avatar }
 * @param {string} userId - ID пользователя, инициировавшего обновление
 */
async function updateChat(chatId, updateData, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

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

  const allowedFields = {};
  if (typeof updateData.title === 'string' && updateData.title.trim()) {
    allowedFields.title = updateData.title.trim();
  }
  if (updateData.avatar !== undefined) {
    allowedFields.avatar = updateData.avatar || null;
  }

  if (Object.keys(allowedFields).length === 0) {
    return enrichChat(chat, userIdStr);
  }

  allowedFields.updatedAt = new Date();

  const objId = toObjectId(chatId);
  await db.collection('chats').updateOne(
    {
      $or: [{ _id: objId }, { _id: String(chatId) }],
    },
    { $set: allowedFields }
  );

  const updatedChat = await getChatById(chatId);
  return enrichChat(updatedChat, userIdStr);
}

/**
 * Добавить участников в групповой чат
 * @param {string} chatId
 * @param {Array<string>|string} newParticipants - ID участников
 * @param {string} requesterId - ID пользователя, добавляющего участников
 */
async function addParticipantsToGroup(chatId, newParticipants, requesterId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const chat = await getChatById(chatId);
  if (!chat) {
    const err = new Error('Chat not found');
    err.status = 404;
    throw err;
  }

  if (chat.type !== 'group') {
    const err = new Error('Cannot add participants to a direct chat');
    err.status = 400;
    throw err;
  }

  const reqIdStr = String(requesterId);
  const isMember = (chat.participants || []).map(String).includes(reqIdStr);
  if (!isMember) {
    const err = new Error('Access denied: You are not a member of this chat');
    err.status = 403;
    throw err;
  }

  const idsToAdd = (Array.isArray(newParticipants) ? newParticipants : [newParticipants])
    .map(String)
    .filter(Boolean);

  if (idsToAdd.length === 0) {
    return enrichChat(chat, reqIdStr);
  }

  const objId = toObjectId(chatId);
  const updateQuery = {
    $addToSet: {
      participants: { $each: idsToAdd },
    },
    $set: {
      updatedAt: new Date(),
    },
  };

  // Инициализируем unreadCounts для новых пользователей
  idsToAdd.forEach((id) => {
    updateQuery.$set[`unreadCounts.${id}`] = 0;
  });

  await db.collection('chats').updateOne(
    { $or: [{ _id: objId }, { _id: String(chatId) }] },
    updateQuery
  );

  const updatedChat = await getChatById(chatId);
  return enrichChat(updatedChat, reqIdStr);
}

/**
 * Удалить участника или выйти из группового чата
 * @param {string} chatId
 * @param {string} participantIdToRemove - ID удаляемого участника
 * @param {string} requesterId - ID пользователя, инициировавшего удаление
 */
async function removeParticipantFromGroup(chatId, participantIdToRemove, requesterId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const chat = await getChatById(chatId);
  if (!chat) {
    const err = new Error('Chat not found');
    err.status = 404;
    throw err;
  }

  if (chat.type !== 'group') {
    const err = new Error('Cannot remove participants from a direct chat');
    err.status = 400;
    throw err;
  }

  const reqIdStr = String(requesterId);
  const targetIdStr = String(participantIdToRemove);
  const isMember = (chat.participants || []).map(String).includes(reqIdStr);
  if (!isMember) {
    const err = new Error('Access denied: You are not a member of this chat');
    err.status = 403;
    throw err;
  }

  const admins = (chat.admins || []).map(String);
  const isAdmin = admins.includes(reqIdStr) || String(chat.creatorId) === reqIdStr;
  const isSelf = reqIdStr === targetIdStr;

  // Удалять может либо сам участник (выход), либо админ группы (кик)
  if (!isSelf && !isAdmin) {
    const err = new Error('Access denied: Only group admins can kick participants');
    err.status = 403;
    throw err;
  }

  const objId = toObjectId(chatId);

  await db.collection('chats').updateOne(
    { $or: [{ _id: objId }, { _id: String(chatId) }] },
    {
      $pull: {
        participants: targetIdStr,
        admins: targetIdStr,
      },
      $unset: {
        [`unreadCounts.${targetIdStr}`]: '',
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );

  const updatedChat = await getChatById(chatId);

  // Если участников не осталось, удаляем чат целиком
  if (updatedChat && (!updatedChat.participants || updatedChat.participants.length === 0)) {
    await deleteChat(chatId, reqIdStr, true);
    return { deleted: true };
  }

  return enrichChat(updatedChat, reqIdStr);
}

/**
 * Удалить чат и все его сообщения
 * @param {string} chatId
 * @param {string} userId - ID запрашивающего
 * @param {boolean} force - принудительное удаление (например, если пустой)
 */
async function deleteChat(chatId, userId, force = false) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const chat = await getChatById(chatId);
  if (!chat) {
    const err = new Error('Chat not found');
    err.status = 404;
    throw err;
  }

  const userIdStr = String(userId);
  const participants = (chat.participants || []).map(String);
  const isMember = participants.includes(userIdStr);

  if (!force && !isMember) {
    const err = new Error('Access denied: You are not a member of this chat');
    err.status = 403;
    throw err;
  }

  // Для групповых чатов удаление доступно только создателю или админу
  if (!force && chat.type === 'group') {
    const admins = (chat.admins || []).map(String);
    const isCreator = String(chat.creatorId) === userIdStr;
    const isAdmin = admins.includes(userIdStr);

    if (!isCreator && !isAdmin) {
      const err = new Error('Access denied: Only group admins or creator can delete the group');
      err.status = 403;
      throw err;
    }
  }

  const objId = toObjectId(chatId);
  const query = { $or: [{ _id: objId }, { _id: String(chatId) }] };

  // Удаляем сам чат
  await db.collection('chats').deleteOne(query);

  // Удаляем все сообщения этого чата
  await db.collection('messages').deleteMany({
    $or: [{ chatId: String(chatId) }, { chatId: objId }],
  });

  return { success: true, chatId: String(chatId) };
}

/**
 * Отметить все сообщения чата как прочитанные текущим пользователем
 * @param {string} chatId
 * @param {string} userId
 */
async function markChatAsRead(chatId, userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const userIdStr = String(userId);
  const objId = toObjectId(chatId);

  // 1. Сбрасываем счетчик непрочитанных в документе чата
  await db.collection('chats').updateOne(
    { $or: [{ _id: objId }, { _id: String(chatId) }] },
    {
      $set: {
        [`unreadCounts.${userIdStr}`]: 0,
      },
    }
  );

  // 2. Добавляем пользователя в readBy всех сообщений этого чата
  await db.collection('messages').updateMany(
    {
      $or: [{ chatId: String(chatId) }, { chatId: objId }],
      readBy: { $ne: userIdStr },
    },
    {
      $addToSet: { readBy: userIdStr },
    }
  );

  return { success: true, chatId: String(chatId), userId: userIdStr };
}

/**
 * Получить общее количество непрочитанных сообщений во всех чатах пользователя
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getTotalUnreadCount(userId) {
  const db = getDB();
  if (!db) throw new Error('DB not connected');

  const userIdStr = String(userId);

  const chats = await db
    .collection('chats')
    .find({
      participants: userIdStr,
      [`unreadCounts.${userIdStr}`]: { $gt: 0 },
    })
    .toArray();

  return chats.reduce((sum, c) => {
    const count = (c.unreadCounts && c.unreadCounts[userIdStr]) || 0;
    return sum + count;
  }, 0);
}

/**
 * Обновить информацию о последнем сообщении в чате и инкрементировать счетчики непрочитанных
 * @param {string} chatId
 * @param {object} message
 */
async function updateLastMessage(chatId, message) {
  try {
    const db = getDB();
    if (!db) return;

    const chat = await getChatById(chatId);
    if (!chat) return;

    const senderStr = String(message.senderId);
    const incFields = {};

    // Инкрементируем счетчик непрочитанных для всех участников, кроме отправителя
    (chat.participants || []).forEach((p) => {
      const pStr = String(p);
      if (pStr !== senderStr) {
        incFields[`unreadCounts.${pStr}`] = 1;
      }
    });

    const updateQuery = {
      $set: {
        lastMessage: {
          messageId: message._id ? String(message._id) : null,
          senderId: senderStr,
          senderName: message.senderName || 'Anonymous',
          encryptedText: message.encryptedText || message.text || '',
          type: message.type || 'text',
          giftId: message.giftId || null,
          createdAt: message.createdAt || new Date(),
        },
        updatedAt: new Date(),
      },
    };

    if (Object.keys(incFields).length > 0) {
      updateQuery.$inc = incFields;
    }

    const objId = toObjectId(chatId);
    await db.collection('chats').updateOne(
      { $or: [{ _id: objId }, { _id: String(chatId) }] },
      updateQuery
    );
  } catch (err) {
    console.error('Failed to update chat lastMessage:', err.message);
  }
}

/**
 * Пересчитать последнее сообщение в чате (например, после удаления сообщения)
 * @param {string} chatId
 */
async function recalculateLastMessage(chatId) {
  try {
    const db = getDB();
    if (!db) return;

    const objId = toObjectId(chatId);

    const latest = await db
      .collection('messages')
      .find({
        $or: [
          { chatId: String(chatId), deleted: { $ne: true } },
          { chatId: objId, deleted: { $ne: true } },
        ],
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .toArray();

    const lastMsgDoc = latest[0] || null;

    const lastMessageValue = lastMsgDoc
      ? {
          messageId: String(lastMsgDoc._id),
          senderId: String(lastMsgDoc.senderId),
          senderName: lastMsgDoc.senderName || 'Anonymous',
          encryptedText: lastMsgDoc.encryptedText || lastMsgDoc.text || '',
          type: lastMsgDoc.type || 'text',
          giftId: lastMsgDoc.giftId || null,
          createdAt: lastMsgDoc.createdAt,
        }
      : null;

    await db.collection('chats').updateOne(
      { $or: [{ _id: objId }, { _id: String(chatId) }] },
      {
        $set: {
          lastMessage: lastMessageValue,
          updatedAt: lastMsgDoc ? lastMsgDoc.createdAt : new Date(),
        },
      }
    );
  } catch (err) {
    console.error('Failed to recalculate lastMessage:', err.message);
  }
}

module.exports = {
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
  updateLastMessage,
  recalculateLastMessage,
  toObjectId,
};
