const assert = require('assert');
const http = require('http');

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

// Простой in-memory Mock DB
const collections = { chats: [], messages: [], users: [] };
let counter = 1;

function matches(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const key of Object.keys(query)) {
    if (key === '$or') {
      if (!query.$or.some((sub) => matches(doc, sub))) return false;
      continue;
    }
    const val = query[key];
    if (val && typeof val === 'object' && val.$in) {
      if (!val.$in.map(String).includes(String(doc[key]))) return false;
      continue;
    }
    if (key === 'participants') {
      if (val && val.$all) {
        const parts = (doc.participants || []).map(String);
        if (!val.$all.every((p) => parts.includes(String(p)))) return false;
        if (val.$size !== undefined && parts.length !== val.$size) return false;
        continue;
      }
      if (!(doc.participants || []).map(String).includes(String(val))) return false;
      continue;
    }
    if (key === '_id') {
      if (String(doc._id) !== String(val)) return false;
      continue;
    }
    if (key === 'chatId') {
      if (String(doc.chatId) !== String(val)) return false;
      continue;
    }
    if (val && typeof val === 'object' && val.$ne !== undefined) {
      if (doc[key] === val.$ne) return false;
      continue;
    }
    if (String(doc[key]) !== String(val)) return false;
  }
  return true;
}

const mockDb = {
  collection(name) {
    if (!collections[name]) collections[name] = [];
    const list = collections[name];
    return {
      async findOne(query) {
        return list.find((d) => matches(d, query)) || null;
      },
      find(query) {
        let items = list.filter((d) => matches(d, query));
        const cursor = {
          sort() { return cursor; },
          skip() { return cursor; },
          limit() { return cursor; },
          async toArray() { return items; },
        };
        return cursor;
      },
      async insertOne(doc) {
        const _id = '607f1f77bcf86cd79943900' + counter++;
        const item = { _id, ...doc };
        list.push(item);
        return { insertedId: _id };
      },
      async updateOne(query, update) {
        const item = list.find((d) => matches(d, query));
        if (!item) return { matchedCount: 0 };
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            if (k.includes('.')) {
              const [p, c] = k.split('.');
              item[p] = item[p] || {};
              item[p][c] = v;
            } else item[k] = v;
          }
        }
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) {
            if (k.includes('.')) {
              const [p, c] = k.split('.');
              item[p] = item[p] || {};
              item[p][c] = (item[p][c] || 0) + v;
            } else item[k] = (item[k] || 0) + v;
          }
        }
        return { matchedCount: 1 };
      },
      async updateMany(query, update) {
        const matched = list.filter((d) => matches(d, query));
        for (const item of matched) {
          await this.updateOne({ _id: item._id }, update);
        }
        return { matchedCount: matched.length };
      },
      async deleteOne(query) {
        const idx = list.findIndex((d) => matches(d, query));
        if (idx !== -1) {
          list.splice(idx, 1);
          return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
      },
      async deleteMany(query) {
        let c = 0;
        for (let i = list.length - 1; i >= 0; i--) {
          if (matches(list[i], query)) {
            list.splice(i, 1);
            c++;
          }
        }
        return { deletedCount: c };
      },
    };
  },
};

const dbModule = require('../src/services/db');
dbModule.getDB = () => mockDb;

const createApp = require('../src/app');

// Вспомогательная функция для HTTP-запросов к Express-приложению
function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runRouteTests() {
  console.log('🧪 Starting HTTP REST Routes integration test...');

  const jwt = require('jsonwebtoken');
  const secret = 'test-secret';
  process.env.JWT_SECRET = secret;

  const aliceToken = jwt.sign({ userId: 'alice123', username: 'alice' }, secret);
  const bobToken = jwt.sign({ userId: 'bob456', username: 'bob' }, secret);
  const eveToken = jwt.sign({ userId: 'eve789', username: 'eve' }, secret);

  const authAlice = { Authorization: `Bearer ${aliceToken}` };
  const authBob = { Authorization: `Bearer ${bobToken}` };
  const authEve = { Authorization: `Bearer ${eveToken}` };

  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    // 1. Health check
    const health = await makeRequest(server, { path: '/health' });
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.status, 'ok');
    console.log('   ✅ GET /health returns 200 ok');

    // 2. 401 Unauthorized check without token
    const unauth = await makeRequest(server, { path: '/api/chats' });
    assert.strictEqual(unauth.status, 401);
    console.log('   ✅ GET /api/chats returns 401 without auth token');

    // 3. GET /api/chats for Alice (initially empty)
    const emptyChats = await makeRequest(server, { path: '/api/chats', headers: authAlice });
    assert.strictEqual(emptyChats.status, 200);
    assert.strictEqual(emptyChats.body.chats.length, 0);
    console.log('   ✅ GET /api/chats returns empty list initially');

    // 4. POST /api/chats — create direct chat with Bob
    const createChatRes = await makeRequest(
      server,
      { path: '/api/chats', method: 'POST', headers: authAlice },
      { participantId: 'bob456' }
    );
    assert.strictEqual(createChatRes.status, 201);
    const chatId = createChatRes.body.chat._id;
    assert.ok(chatId, 'chatId should exist');
    console.log('   ✅ POST /api/chats created direct chat, id:', chatId);

    // 5. POST /api/chats — idempotency (returns 200 with existing chat)
    const idempotentRes = await makeRequest(
      server,
      { path: '/api/chats', method: 'POST', headers: authBob },
      { participantId: 'alice123' }
    );
    assert.strictEqual(idempotentRes.status, 200);
    assert.strictEqual(idempotentRes.body.chat._id, chatId);
    assert.strictEqual(idempotentRes.body.isNew, false);
    console.log('   ✅ POST /api/chats idempotent check passed');

    // 6. POST /api/chats/:id/messages — Alice sends a message
    const sendMsgRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/messages`, method: 'POST', headers: authAlice },
      { text: 'skyline-e2e:v3:encrypted-hello' }
    );
    assert.strictEqual(sendMsgRes.status, 201);
    assert.strictEqual(sendMsgRes.body.message.encryptedText, 'skyline-e2e:v3:encrypted-hello');
    const messageId = sendMsgRes.body.messageId;
    console.log('   ✅ POST /api/chats/:id/messages sent message successfully');

    // 7. GET /api/chats/:id/messages — Bob retrieves messages
    const getMsgsRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/messages`, method: 'GET', headers: authBob }
    );
    assert.strictEqual(getMsgsRes.status, 200);
    assert.strictEqual(getMsgsRes.body.messages.length, 1);
    assert.strictEqual(getMsgsRes.body.messages[0].encryptedText, 'skyline-e2e:v3:encrypted-hello');
    console.log('   ✅ GET /api/chats/:id/messages retrieved messages');

    // 8. 403 Forbidden check — Eve tries to read Alice and Bob messages
    const forbiddenRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/messages`, method: 'GET', headers: authEve }
    );
    assert.strictEqual(forbiddenRes.status, 403);
    console.log('   ✅ GET /api/chats/:id/messages 403 Forbidden for non-member Eve');

    // 9. PATCH /api/chats/:id/messages/:messageId — Alice edits her message
    const editRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/messages/${messageId}`, method: 'PATCH', headers: authAlice },
      { text: 'skyline-e2e:v3:encrypted-edited' }
    );
    assert.strictEqual(editRes.status, 200);
    assert.strictEqual(editRes.body.message.encryptedText, 'skyline-e2e:v3:encrypted-edited');
    assert.strictEqual(editRes.body.message.isEdited, true);
    console.log('   ✅ PATCH /api/chats/:id/messages/:messageId edited message');

    // 10. POST /api/chats/:id/read — Bob marks chat as read
    const readRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/read`, method: 'POST', headers: authBob }
    );
    assert.strictEqual(readRes.status, 200);
    assert.strictEqual(readRes.body.success, true);
    console.log('   ✅ POST /api/chats/:id/read marked as read');

    // 11. POST /api/chats — create group chat
    const createGroupRes = await makeRequest(
      server,
      { path: '/api/chats', method: 'POST', headers: authAlice },
      { type: 'group', title: 'Команда проекта', participantIds: ['bob456', 'eve789'] }
    );
    assert.strictEqual(createGroupRes.status, 201);
    const groupChatId = createGroupRes.body.chat._id;
    assert.strictEqual(createGroupRes.body.chat.title, 'Команда проекта');
    console.log('   ✅ POST /api/chats created group chat');

    // 12. PATCH /api/chats/:id — update group title
    const patchGroupRes = await makeRequest(
      server,
      { path: `/api/chats/${groupChatId}`, method: 'PATCH', headers: authAlice },
      { title: 'Супер Команда' }
    );
    assert.strictEqual(patchGroupRes.status, 200);
    assert.strictEqual(patchGroupRes.body.chat.title, 'Супер Команда');
    console.log('   ✅ PATCH /api/chats/:id updated group title');

    // 13. DELETE /api/chats/:id/messages/:messageId — delete message
    const delMsgRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}/messages/${messageId}`, method: 'DELETE', headers: authAlice }
    );
    assert.strictEqual(delMsgRes.status, 200);
    assert.strictEqual(delMsgRes.body.success, true);
    console.log('   ✅ DELETE /api/chats/:id/messages/:messageId deleted message');

    // 14. DELETE /api/chats/:id — delete chat
    const delChatRes = await makeRequest(
      server,
      { path: `/api/chats/${chatId}`, method: 'DELETE', headers: authAlice }
    );
    assert.strictEqual(delChatRes.status, 200);
    assert.strictEqual(delChatRes.body.success, true);
    console.log('   ✅ DELETE /api/chats/:id deleted chat');

    console.log('\n🎉 ALL HTTP REST ROUTE TESTS PASSED SUCCESSFULLY! 🚀');
  } finally {
    server.close();
  }
}

runRouteTests().catch((err) => {
  console.error('❌ Route test failed:', err);
  process.exit(1);
});
