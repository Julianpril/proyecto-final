// Configuración del coordinator
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 4000,
  jwtSecret: process.env.JWT_SECRET,
};

// Sin JWT_SECRET no se pueden validar tokens
if (!config.jwtSecret) {
  console.error('[CONFIG] JWT_SECRET no definido en .env');
  process.exit(1);
}

module.exports = config;
