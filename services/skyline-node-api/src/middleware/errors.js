/**
 * Global Error Handling Middleware:
 * Express узнаёт middleware ошибок по наличию 4 аргументов: (err, req, res, next).
 * Логирует ошибку в консоль и возвращает JSON с полем error и статусом 500 (или err.status).
 */
const errorMiddleware = (err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error'
  });
};

module.exports = errorMiddleware;
