const assert = require('assert');

// Mock 'mongodb' module if not installed in node_modules
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (path) {
  if (path === 'mongodb') {
    return {
      ObjectId: class ObjectId {
        constructor(id) {
          this.id = id || Math.random().toString(16).slice(2, 26);
        }
        toString() {
          return String(this.id);
        }
        static isValid(id) {
          return typeof id === 'string' && id.length === 24;
        }
      },
      MongoClient: class MongoClient {},
    };
  }
  return origRequire.apply(this, arguments);
};

// In-memory mock MongoDB implementation to thoroughly test services and routes
function createMockDB() {
  const collections = {
    chats: [],
    messages: [],
    users: [],
  };

  let idCounter = 1;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function matches(doc, query) {
    if (!query || Object.keys(query).length === 0) return true;

    for (const key of Object.keys(query)) {
      if (key === '$or') {
        const anyMatch = query.$or.some((subQuery) => matches(doc, subQuery));
        if (!anyMatch) return false;
        continue;
      }

      const val = query[key];

      if (key === 'participants') {
        if (val && val.$all) {
          const docParts = (doc.participants || []).map(String);
          const allPresent = val.$all.every((p) => docParts.includes(String(p)));
          if (!allPresent) return false;
          if (val.$size !== undefined && docParts.length !== val.$size) return false;
          continue;
        }
        const docParts = (doc.participants || []).map(String);
        if (!docParts.includes(String(val))) return false;
        continue;
      }

      if (val && typeof val === 'object' && val.$in) {
        if (!val.$in.map(String).includes(String(doc[key]))) return false;
        continue;
      }

      if (key === '_id') {
        if (String(doc._id) !== String(val)) return false;
        continue;
      }

      if (val && typeof val === 'object' && val.$ne !== undefined) {
        if (doc[key] === val.$ne) return false;
        continue;
      }

      if (val && typeof val === 'object' && val.$gt !== undefined) {
        if (typeof doc[key] !== 'number' || doc[key] <= val.$gt) return false;
        continue;
      }

      if (val && typeof val === 'object' && val.$lt !== undefined) {
        const docVal = doc[key] instanceof Date ? doc[key] : new Date(doc[key]);
        const targetVal = val.$lt instanceof Date ? val.$lt : new Date(val.$lt);
        if (docVal >= targetVal) return false;
        continue;
      }

      if (String(doc[key]) !== String(val)) {
        return false;
      }
    }

    return true;
  }

  function getCollection(name) {
    if (!collections[name]) collections[name] = [];
    const list = collections[name];

    return {
      async findOne(query) {
        const item = list.find((doc) => matches(doc, query));
        return item ? clone(item) : null;
      },
      find(query) {
        let items = list.filter((doc) => matches(doc, query)).map(clone);

        const cursor = {
          sort(sortObj) {
            items.sort((a, b) => {
              for (const [k, direction] of Object.entries(sortObj)) {
                const aVal = a[k] instanceof Date ? a[k].getTime() : a[k];
                const bVal = b[k] instanceof Date ? b[k].getTime() : b[k];
                if (aVal < bVal) return direction === 1 ? -1 : 1;
                if (aVal > bVal) return direction === 1 ? 1 : -1;
              }
              return 0;
            });
            return cursor;
          },
          skip(num) {
            items = items.slice(num || 0);
            return cursor;
          },
          limit(num) {
            items = items.slice(0, num);
            return cursor;
          },
          async toArray() {
            return items;
          },
        };
        return cursor;
      },
      async insertOne(doc) {
        const _id = '507f1f77bcf86cd79943901' + idCounter++;
        const stored = { _id, ...clone(doc) };
        list.push(stored);
        return { insertedId: _id };
      },
      async updateOne(query, update) {
        const item = list.find((doc) => matches(doc, query));
        if (!item) return { matchedCount: 0, modifiedCount: 0 };

        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            if (k.includes('.')) {
              const [parent, child] = k.split('.');
              item[parent] = item[parent] || {};
              item[parent][child] = v;
            } else {
              item[k] = v;
            }
          }
        }
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            if (k.includes('.')) {
              const [parent, child] = k.split('.');
              item[parent] = item[parent] || {};
              item[parent][child] = (item[parent][child] || 0) + v;
            } else {
              item[k] = (item[k] || 0) + v;
            }
          }
        }
        if (update.$addToSet) {
          for (const [k, v] of Object.entries(update.$addToSet)) {
            if (v && v.$each) {
              item[k] = item[k] || [];
              v.$each.forEach((elem) => {
                if (!item[k].includes(elem)) item[k].push(elem);
              });
            } else {
              item[k] = item[k] || [];
              if (!item[k].includes(v)) item[k].push(v);
            }
          }
        }
        if (update.$pull) {
          for (const [k, v] of Object.entries(update.$pull)) {
            if (item[k]) {
              item[k] = item[k].filter((elem) => String(elem) !== String(v));
            }
          }
        }
        if (update.$unset) {
          for (const [k] of Object.entries(update.$unset)) {
            if (k.includes('.')) {
              const [parent, child] = k.split('.');
              if (item[parent]) delete item[parent][child];
            } else {
              delete item[k];
            }
          }
        }

        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(query, update) {
        const matched = list.filter((doc) => matches(doc, query));
        for (const item of matched) {
          await this.updateOne({ _id: item._id }, update);
        }
        return { matchedCount: matched.length, modifiedCount: matched.length };
      },
      async deleteOne(query) {
        const idx = list.findIndex((doc) => matches(doc, query));
        if (idx !== -1) {
          list.splice(idx, 1);
          return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
      },
      async deleteMany(query) {
        let count = 0;
        for (let i = list.length - 1; i >= 0; i--) {
          if (matches(list[i], query)) {
            list.splice(i, 1);
            count++;
          }
        }
        return { deletedCount: count };
      },
    };
  }

  return {
    collection(name) {
      return getCollection(name);
    },
    _collections: collections,
  };
}

async function runTests() {
  console.log('🧪 Starting REST Chats logic verification test suite...');

  const mockDb = createMockDB();

  // Подставляем mockDb в сервис db
  const dbModule = require('../src/services/db');
  dbModule.getDB = () => mockDb;

  // Добавляем тестовых пользователей в mock users
  await mockDb.collection('users').insertOne({
    _id: 'user_alice',
    username: 'alice',
    name: 'Алиса Смирнова',
    avatar: 'https://example.com/alice.jpg',
  });
  await mockDb.collection('users').insertOne({
    _id: 'user_bob',
    username: 'bob',
    name: 'Боб Иванов',
    avatar: 'https://example.com/bob.jpg',
  });
  await mockDb.collection('users').insertOne({
    _id: 'user_charlie',
    username: 'charlie',
    name: 'Чарли',
    avatar: null,
  });

  const chatsService = require('../src/services/chats');
  const messagesService = require('../src/services/messages');

  // ТЕСТ 1: Создание Direct-чата между Alice и Bob
  console.log('1. Тест создания Direct-чата:');
  const { chat: directChat, isNew } = await chatsService.createChat('user_alice', 'user_bob');
  assert.strictEqual(isNew, true, 'Чат должен быть новым');
  assert.strictEqual(directChat.type, 'direct');
  assert.strictEqual(directChat.participants.length, 2);
  assert.strictEqual(directChat.title, 'Боб Иванов', 'Для Алисы тайтл чата должен быть именем Боба');
  assert.strictEqual(directChat.opponent.username, 'bob');
  console.log('   ✅ Direct-чат успешно создан с обогащенными данными');

  // ТЕСТ 2: Идемпотентность — повторное создание возвращает тот же чат
  console.log('2. Тест идемпотентности (getOrCreate):');
  const secondCall = await chatsService.createChat('user_bob', 'user_alice');
  assert.strictEqual(secondCall.isNew, false, 'Повторное создание не должно дублировать чат');
  assert.strictEqual(String(secondCall.chat._id), String(directChat._id));
  assert.strictEqual(secondCall.chat.title, 'Алиса Смирнова', 'Для Боба тайтл должен быть именем Алисы');
  console.log('   ✅ Идемпотентность работает корректно, чат не дублируется');

  // ТЕСТ 3: Защита от создания чата с самим собой
  console.log('3. Тест валидации чата с самим собой:');
  let selfError = false;
  try {
    await chatsService.createChat('user_alice', 'user_alice');
  } catch (err) {
    selfError = true;
    assert.strictEqual(err.message, 'Cannot create chat with yourself');
  }
  assert.strictEqual(selfError, true);
  console.log('   ✅ Создание чата с самим собой запрещено');

  // ТЕСТ 4: Создание группового чата
  console.log('4. Тест создания группового чата:');
  const groupChat = await chatsService.createGroupChat('user_alice', {
    title: 'Рабочая беседа',
    participantIds: ['user_bob', 'user_charlie'],
  });
  assert.strictEqual(groupChat.type, 'group');
  assert.strictEqual(groupChat.title, 'Рабочая беседа');
  assert.strictEqual(groupChat.participants.length, 3);
  assert.ok(groupChat.admins.includes('user_alice'));
  console.log('   ✅ Групповой чат успешно создан с админами и участниками');

  // ТЕСТ 5: Отправка сообщений и автоматическое обновление чата
  console.log('5. Тест отправки сообщения:');
  const msg1 = await messagesService.saveMessage({
    chatId: directChat._id,
    senderId: 'user_alice',
    senderName: 'Алиса Смирнова',
    encryptedText: 'Привет, Боб!',
    type: 'text',
  });
  assert.strictEqual(msg1.encryptedText, 'Привет, Боб!');
  assert.strictEqual(msg1.chatId, directChat._id);

  // Проверяем, что в документе чата обновился lastMessage и unreadCounts
  const updatedDirectChat = await chatsService.getChatById(directChat._id, 'user_bob');
  assert.strictEqual(updatedDirectChat.lastMessage.encryptedText, 'Привет, Боб!');
  assert.strictEqual(updatedDirectChat.unreadCount, 1, 'У Боба должно быть 1 непрочитанное');

  const aliceView = await chatsService.getChatById(directChat._id, 'user_alice');
  assert.strictEqual(aliceView.unreadCount, 0, 'У Алисы (отправителя) должно быть 0 непрочитанных');
  console.log('   ✅ Сообщение сохранено, lastMessage и unreadCounts обновлены');

  // Второе сообщение от Алисы
  await messagesService.saveMessage({
    chatId: directChat._id,
    senderId: 'user_alice',
    senderName: 'Алиса Смирнова',
    encryptedText: 'Как дела?',
    type: 'text',
  });
  const updatedDirectChat2 = await chatsService.getChatById(directChat._id, 'user_bob');
  assert.strictEqual(updatedDirectChat2.unreadCount, 2, 'У Боба должно стать 2 непрочитанных');
  console.log('   ✅ Счетчик непрочитанных корректно инкрементируется');

  // ТЕСТ 6: Получение истории сообщений
  console.log('6. Тест истории сообщений:');
  const messagesList = await messagesService.getMessages(directChat._id, { limit: 10 });
  assert.strictEqual(messagesList.length, 2);
  assert.strictEqual(messagesList[0].encryptedText, 'Привет, Боб!');
  assert.strictEqual(messagesList[1].encryptedText, 'Как дела?');
  console.log('   ✅ Сообщения возвращаются в хронологическом порядке');

  // ТЕСТ 7: Отметка чата как прочитанного
  console.log('7. Тест отметки о прочтении (markAsRead):');
  await chatsService.markChatAsRead(directChat._id, 'user_bob');
  const readBobChat = await chatsService.getChatById(directChat._id, 'user_bob');
  assert.strictEqual(readBobChat.unreadCount, 0, 'Счетчик непрочитанных должен сброситься в 0');
  const totalUnreadBob = await chatsService.getTotalUnreadCount('user_bob');
  assert.strictEqual(totalUnreadBob, 0);
  console.log('   ✅ Чат успешно прочитан, unreadCount сброшен');

  // ТЕСТ 8: Редактирование сообщения
  console.log('8. Тест редактирования сообщения:');
  const editedMsg = await messagesService.updateMessage(msg1._id, 'user_alice', 'Привет, Боб! (исправлено)');
  assert.strictEqual(editedMsg.encryptedText, 'Привет, Боб! (исправлено)');
  assert.strictEqual(editedMsg.isEdited, true);
  console.log('   ✅ Сообщение успешно отредактировано');

  // ТЕСТ 9: Поиск по чатам
  console.log('9. Тест поиска по чатам:');
  const aliceChats = await chatsService.getUserChats('user_alice', { query: 'беседа' });
  assert.strictEqual(aliceChats.length, 1);
  assert.strictEqual(aliceChats[0].title, 'Рабочая беседа');

  const aliceChatsBob = await chatsService.getUserChats('user_alice', { query: 'боб' });
  assert.strictEqual(aliceChatsBob.length, 1);
  assert.strictEqual(aliceChatsBob[0].opponent.username, 'bob');
  console.log('   ✅ Поиск по группам и собеседникам работает отлично');

  // ТЕСТ 10: Управление участниками группы
  console.log('10. Тест добавления и удаления участников группы:');
  await mockDb.collection('users').insertOne({
    _id: 'user_david',
    username: 'david',
    name: 'Давид',
    avatar: null,
  });
  const afterAdd = await chatsService.addParticipantsToGroup(groupChat._id, ['user_david'], 'user_alice');
  assert.strictEqual(afterAdd.participants.length, 4);

  // Выход Давида
  const afterRemove = await chatsService.removeParticipantFromGroup(groupChat._id, 'user_david', 'user_david');
  assert.strictEqual(afterRemove.participants.length, 3);
  console.log('   ✅ Добавление и выход участников работают штатно');

  // ТЕСТ 11: Удаление сообщения и пересчет lastMessage
  console.log('11. Тест удаления сообщения и пересчета последнего сообщения:');
  const msgLatest = await messagesService.saveMessage({
    chatId: directChat._id,
    senderId: 'user_bob',
    senderName: 'Боб Иванов',
    encryptedText: 'Сообщение которое будет удалено',
  });
  let directWithLatest = await chatsService.getChatById(directChat._id);
  assert.strictEqual(directWithLatest.lastMessage.encryptedText, 'Сообщение которое будет удалено');

  await messagesService.deleteMessage(msgLatest._id, 'user_bob');
  directWithLatest = await chatsService.getChatById(directChat._id);
  assert.strictEqual(directWithLatest.lastMessage.encryptedText, 'Как дела?', 'Должно восстановиться предыдущее сообщение');
  console.log('   ✅ Удаление сообщения и пересчет lastMessage работают корректно');

  // ТЕСТ 12: Удаление чата
  console.log('12. Тест удаления чата:');
  await chatsService.deleteChat(directChat._id, 'user_alice');
  const deletedChat = await chatsService.getChatById(directChat._id);
  assert.strictEqual(deletedChat, null, 'Чат должен быть удален');
  const remainingMessages = await messagesService.getMessages(directChat._id);
  assert.strictEqual(remainingMessages.length, 0, 'Сообщения удаленного чата должны быть удалены');
  console.log('   ✅ Удаление чата и очистка сообщений работают');

  console.log('\n🎉 ALL 12 REST CHAT TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
