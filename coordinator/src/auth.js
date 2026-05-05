// Módulo de autenticación JWT
const jwt = require('jsonwebtoken');
const { URL } = require('url');
const config = require('./config');

// Extrae y verifica el token JWT del query param de la petición upgrade
function verifyUpgradeToken(req) {
  const fullUrl = new URL(req.url, `http://${req.headers.host}`);
  const token = fullUrl.searchParams.get('token');

  if (!token) {
    throw new Error('Token no proporcionado en la conexión WebSocket');
  }

  const decoded = jwt.verify(token, config.jwtSecret);

  if (!decoded.userId || !decoded.username) {
    throw new Error('Token JWT sin campos requeridos (userId, username)');
  }

  return {
    userId: decoded.userId,
    username: decoded.username,
  };
}

module.exports = { verifyUpgradeToken };
