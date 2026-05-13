require('dotenv').config();

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const TICK_RATE = 20;
const PLAYER_SPEED = 200;
const PLAYER_RADIUS = 16;
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;
const TICK_MS = 1000 / TICK_RATE;

if (!JWT_SECRET) {
  console.error('[CONFIG] JWT_SECRET no definido en .env');
  process.exit(1);
}

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const players = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeAxis(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.sign(numeric);
}

function createSpawnPosition() {
  const minX = PLAYER_RADIUS;
  const maxX = Math.max(PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
  const minY = PLAYER_RADIUS;
  const maxY = Math.max(PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);

  return {
    x: minX + Math.random() * Math.max(0, maxX - minX),
    y: minY + Math.random() * Math.max(0, maxY - minY),
  };
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function verifyUpgradeToken(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname !== '/connect') {
    throw new Error('Ruta WebSocket inválida');
  }

  const token = requestUrl.searchParams.get('token');

  if (!token) {
    throw new Error('Token no proporcionado');
  }

  const decoded = jwt.verify(token, JWT_SECRET);

  if (!decoded || !decoded.userId || !decoded.username) {
    throw new Error('Token JWT sin userId/username');
  }

  return {
    userId: decoded.userId,
    username: decoded.username,
  };
}

function rejectUpgrade(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function upsertPlayer(userId, username, socket) {
  const previous = players.get(userId);

  if (previous && previous.socket && previous.socket !== socket && previous.socket.readyState === WebSocket.OPEN) {
    previous.socket.close(4000, 'Nueva conexión desde otro cliente');
  }

  const spawn = createSpawnPosition();

  players.set(userId, {
    x: spawn.x,
    y: spawn.y,
    intent: { x: 0, y: 0 },
    extras: {},
    username,
    socket,
    connectedAt: Date.now(),
  });
}

function removePlayer(userId, socket) {
  const current = players.get(userId);

  if (!current) {
    return;
  }

  if (socket && current.socket !== socket) {
    return;
  }

  players.delete(userId);
}

function snapshot() {
  return Array.from(players.entries()).map(([userId, player]) => ({
    userId,
    x: player.x,
    y: player.y,
    intent: { ...player.intent },
    extras: player.extras,
    username: player.username,
    connectedAt: new Date(player.connectedAt).toISOString(),
  }));
}

function broadcastState(now) {
  const message = JSON.stringify({
    type: 'state',
    t: now,
    players: snapshot(),
  });

  for (const player of players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(message);
    }
  }
}

let lastTickAt = Date.now();

function tick() {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000;
  lastTickAt = now;

  for (const player of players.values()) {
    const { x: intentX, y: intentY } = player.intent;
    const magnitude = Math.hypot(intentX, intentY);

    let velocityX = 0;
    let velocityY = 0;

    if (magnitude > 0) {
      // Teorema de Pitágoras: Math.hypot calcula la magnitud del vector de intención.
      // Al normalizar el vector evitamos que el movimiento diagonal sea más rápido.
      velocityX = (intentX / magnitude) * PLAYER_SPEED;
      velocityY = (intentY / magnitude) * PLAYER_SPEED;
    }

    player.x = Math.max(
      PLAYER_RADIUS,
      Math.min(WORLD_WIDTH - PLAYER_RADIUS, player.x + velocityX * dt)
    );
    player.y = Math.max(
      PLAYER_RADIUS,
      Math.min(WORLD_HEIGHT - PLAYER_RADIUS, player.y + velocityY * dt)
    );
  }

  broadcastState(now);
}

// Validación de autoridad: el servidor siempre calcula la posición final.
wss.on('connection', (ws, req, user) => {
  const { userId, username } = user;

  upsertPlayer(userId, username, ws);
  const currentPlayer = players.get(userId);

  sendJson(ws, {
    type: 'welcome',
    you: {
      userId,
      username,
      x: currentPlayer.x,
      y: currentPlayer.y,
      intent: { ...currentPlayer.intent },
      extras: { ...currentPlayer.extras },
      connectedAt: new Date(currentPlayer.connectedAt).toISOString(),
    },
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate: TICK_RATE,
    },
  });

  ws.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let payload;

    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return;
    }

    const currentPlayer = players.get(userId);

    if (!currentPlayer) {
      return;
    }

    if (payload && payload.type === 'intent') {
      // Accept several client formats:
      // 1) { type:'intent', intent:{ x, y } }
      // 2) { type:'intent', intent:{ dir:{ x, y } } } (PDF skeleton style)
      // 3) { type:'intent', dir:{ x, y } } / { type:'intent', direction:{ x, y } }
      const candidate = payload.intent || payload.direction || payload.dir || payload;
      const nextIntent = (candidate && candidate.dir) ? candidate.dir : candidate;

      const sanitizedX = sanitizeAxis(nextIntent && nextIntent.x);
      const sanitizedY = sanitizeAxis(nextIntent && nextIntent.y);

      currentPlayer.intent = {
        x: sanitizedX,
        y: sanitizedY,
      };

      return;
    }

    if (isPlainObject(payload) && payload.type === 'extras_update') {
      const extras = payload.extras;

      if (!isPlainObject(extras)) {
        return;
      }

      const serialized = JSON.stringify(extras);

      if (serialized.length > 1024) {
        return;
      }

      currentPlayer.extras = JSON.parse(serialized);
    }
  });

  ws.on('close', () => {
    removePlayer(userId, ws);
  });

  ws.on('error', (error) => {
    console.error(`[WS] Error de ${username}:`, error.message);
  });
});

server.on('upgrade', (req, socket, head) => {
  try {
    const user = verifyUpgradeToken(req);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  } catch (error) {
    // Rechazo de autenticación antes de emitir la conexión WebSocket.
    console.error(`[WS] Upgrade rechazado (4001): ${error.message}`);
    rejectUpgrade(socket);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'coordinator',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    connectedPlayers: players.size,
    players: snapshot(),
    timestamp: new Date().toISOString(),
  });
});

setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`COORDINATOR activo en puerto ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`Health:    http://localhost:${PORT}/health`);
  console.log(`Status:    http://localhost:${PORT}/status`);
});
