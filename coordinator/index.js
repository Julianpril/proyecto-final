// Punto de entrada del Coordinator
const http = require('http');
const express = require('express');
const config = require('./src/config');
const { setupWebSocket } = require('./src/websocket');
const { getPlayerList, getPlayerCount } = require('./src/playerStore');

const app = express();
app.use(express.json());

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'coordinator',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Endpoint de estado (jugadores conectados)
app.get('/status', (req, res) => {
  res.json({
    connectedPlayers: getPlayerCount(),
    players: getPlayerList(),
    timestamp: new Date().toISOString(),
  });
});

// Crear servidor HTTP manualmente para interceptar el upgrade de WebSocket
const server = http.createServer(app);
setupWebSocket(server);

server.listen(config.port, () => {
  console.log(`COORDINATOR activo en puerto ${config.port}`);
  console.log(`WebSocket: ws://localhost:${config.port}?token=<JWT>`);
  console.log(`Health:    http://localhost:${config.port}/health`);
  console.log(`Status:    http://localhost:${config.port}/status`);
});
