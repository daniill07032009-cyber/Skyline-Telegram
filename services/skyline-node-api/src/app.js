const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const chatsRoutes = require('./routes/chats');
const messagesRoutes = require('./routes/messages');
const keysRoutes = require('./routes/keys');
const errorMiddleware = require('./middleware/errors');

function createApp() {
  const app = express();

  const allowedOrigins = new Set([
    ...(process.env.FRONTEND_URL || 'https://pipipipipi.3utilities.com').split(',').map((origin) => origin.trim().replace(/\/$/, '')),
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  app.use(cors({ origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  } }));

  // 2. JSON-парсер — чтобы принимать JSON в теле запросов
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 3. Health-check эндпоинт /health (проверка, что сервер жив)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'node-backend' });
  });

  // 4. Подключение маршрутов
  app.use('/api/auth', authRoutes);
  app.use('/auth', authRoutes);
  app.use('/api/keys', keysRoutes);
  app.use('/keys', keysRoutes);
  app.use('/api/chats', chatsRoutes);
  app.use('/chats', chatsRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/messages', messagesRoutes);
  app.use('/users', authRoutes);

  // 5. 404-обработчик для несуществующих путей
  app.use((req, res, next) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // 6. Middleware обработки ошибок — идёт последним
  app.use(errorMiddleware);

  return app;
}

module.exports = createApp;
