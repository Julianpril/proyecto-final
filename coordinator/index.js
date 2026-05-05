// Coordinator - Servidor WebSocket con autenticación JWT
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { URL } = require('url');
require('dotenv').config();

// Validar que JWT_SECRET esté definido
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = parseInt(process.env.PORT, 10) || 5000;

if (!JWT_SECRET) {
  console.error('JWT_SECRET no definido en .env');
  process.exit(1);
}

// Estado en memoria: Map<userId, { username, socket, connectedAt }>
const players = new Map();

// ── Express ──
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'coordinator', uptime: process.uptime() });
});

app.get('/status', (req, res) => {
  const list = [];
  for (const [userId, data] of players) {
    list.push({ userId, username: data.username, connectedAt: data.connectedAt });
  }
  res.json({ connectedPlayers: players.size, players: list });
});

// ── Servidor HTTP ──
const server = http.createServer(app);

// WebSocket sin puerto propio, usa el upgrade del HTTP server
const wss = new WebSocketServer({ noServer: true });

// ── Interceptar upgrade: validar JWT ANTES de aceptar la conexión ──
server.on('upgrade', (req, socket, head) => {
  try {
    // Extraer token del query param ?token=XXX
    const fullUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = fullUrl.searchParams.get('token');

    if (!token) {
      throw new Error('Token no proporcionado');
    }

    // Verificar firma y expiración del JWT
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.userId || !decoded.username) {
      throw new Error('Token sin campos requeridos');
    }

    // Token válido → completar handshake WebSocket
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, decoded);
    });
  } catch (error) {
    console.error(`[AUTH] Conexión rechazada: ${error.message}`);
    // Rechazar con código 4001 según especificación
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// ── Broadcast: enviar lista de jugadores a todos los clientes ──
function broadcast() {
  const playerList = [];
  for (const [userId, data] of players) {
    playerList.push({ userId, username: data.username });
  }

  const message = JSON.stringify({
    type: 'players_update',
    players: playerList,
  });

  for (const [userId, { socket }] of players) {
    if (socket.readyState === 1) { // WebSocket.OPEN
      socket.send(message);
    }
  }

  console.log(`[BROADCAST] Enviado a ${players.size} cliente(s)`);
}

// ── Manejar conexiones autenticadas ──
wss.on('connection', (ws, req, user) => {
  const { userId, username } = user;
  console.log(`[WS] Conectado: "${username}" (${userId})`);

  // Si el usuario ya tiene conexión activa, cerrar la anterior
  if (players.has(userId)) {
    const prev = players.get(userId);
    console.log(`[WS] "${username}" ya conectado, cerrando sesión anterior`);
    prev.socket.close(4001, 'Nueva conexión desde otro cliente');
  }

  // Guardar en el Map
  players.set(userId, {
    username,
    socket: ws,
    connectedAt: new Date().toISOString(),
  });

  // Broadcast al conectar
  broadcast();

  // Evento close: eliminar del Map y broadcast
  ws.on('close', (code) => {
    console.log(`[WS] Desconectado: "${username}" (${userId}) - Código: ${code}`);
    players.delete(userId);
    broadcast();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error de "${username}":`, err.message);
  });

  ws.on('message', (data) => {
    console.log(`[WS] Mensaje de "${username}": ${data}`);
  });
});

// ── Iniciar servidor ──
server.listen(PORT, () => {
  console.log(`COORDINATOR activo en puerto ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}?token=<JWT>`);
  console.log(`Health:    http://localhost:${PORT}/health`);
  console.log(`Status:    http://localhost:${PORT}/status`);
});
