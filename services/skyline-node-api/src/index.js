require('dotenv').config();
const http = require('http');
const createApp = require('./app');
const { initSocket } = require('./socket');
const { connectDB } = require('./services/db');

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';   // ← ВАЖНО: слушать все интерфейсы (для Railway)

async function start() {
  try {
    await connectDB();
    console.log('✅ MongoDB connected');

    const app = createApp();
    const server = http.createServer(app);

    initSocket(server);

    server.listen(PORT, HOST, () => {
      console.log(`✅ Backend running on http://${HOST}:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start backend:', err);
    process.exit(1);
  }
}

start();