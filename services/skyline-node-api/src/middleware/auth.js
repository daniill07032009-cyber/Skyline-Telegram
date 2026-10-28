const jwt = require('jsonwebtoken');

/**
 * JWT Authentication Middleware
 * 1. Извлекает заголовок Authorization из запроса.
 * 2. Проверяет, что он начинается с 'Bearer '.
 * 3. Извлекает токен, проверяет через jwt.verify(token, process.env.JWT_SECRET).
 * 4. Если токен валиден — записывает расшифрованные данные в req.user и передаёт управление дальше (next()).
 * 5. Если токена нет или он невалиден — возвращает 401 с сообщением.
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Token missing' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Authentication service is not configured' });
  }

  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

module.exports = authMiddleware;
