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

// === Orbs config ===
const MAX_ORBS = 8;
const ORB_RADIUS = 12;
const ORB_COLLECT_DISTANCE = PLAYER_RADIUS + ORB_RADIUS + 4;
const ORB_RESPAWN_MS = 3000;
const ORB_TYPES = [
  { type: 'gold',    points: 1, color: '#FFD700', probability: 0.60 },
  { type: 'diamond', points: 3, color: '#00FFFF', probability: 0.25 },
  { type: 'ruby',    points: 5, color: '#FF3366', probability: 0.15 },
];

const orbs = new Map();
let nextOrbId = 1;
const scores = new Map();

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

// Solo deja pasar -1, 0 o 1. Si mandan basura, se ignora
function sanitizeAxis(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.sign(numeric);
}

function createSpawnPosition(radius) {
  radius = radius || PLAYER_RADIUS;
  const minX = radius;
  const maxX = Math.max(radius, WORLD_WIDTH - radius);
  const minY = radius;
  const maxY = Math.max(radius, WORLD_HEIGHT - radius);

  return {
    x: minX + Math.random() * Math.max(0, maxX - minX),
    y: minY + Math.random() * Math.max(0, maxY - minY),
  };
}

// === Orb management ===
function pickOrbType() {
  const r = Math.random();
  let cumulative = 0;
  for (const t of ORB_TYPES) {
    cumulative += t.probability;
    if (r <= cumulative) return t;
  }
  return ORB_TYPES[0];
}

function spawnOrb() {
  if (orbs.size >= MAX_ORBS) return;
  const pos = createSpawnPosition(ORB_RADIUS);
  const orbType = pickOrbType();
  const id = nextOrbId++;
  orbs.set(id, {
    id,
    x: pos.x,
    y: pos.y,
    type: orbType.type,
    points: orbType.points,
    color: orbType.color,
    spawnedAt: Date.now(),
  });
}

function initOrbs() {
  for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
}

function orbsSnapshot() {
  return Array.from(orbs.values()).map(o => ({
    id: o.id, x: o.x, y: o.y,
    type: o.type, points: o.points, color: o.color,
  }));
}

function scoresSnapshot() {
  const list = [];
  for (const [userId, score] of scores.entries()) {
    const p = players.get(userId);
    if (p) list.push({ userId, username: p.username, score });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

function checkOrbCollisions() {
  for (const [orbId, orb] of orbs) {
    for (const [userId, player] of players) {
      const dx = player.x - orb.x;
      const dy = player.y - orb.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= ORB_COLLECT_DISTANCE) {
        // Collect!
        const prev = scores.get(userId) || 0;
        scores.set(userId, prev + orb.points);
        orbs.delete(orbId);

        // Notify all players
        const msg = JSON.stringify({
          type: 'orb_collected',
          orbId,
          collector: { userId, username: player.username },
          orbType: orb.type,
          points: orb.points,
          newScore: prev + orb.points,
        });
        for (const p of players.values()) {
          if (p.socket.readyState === WebSocket.OPEN) p.socket.send(msg);
        }

        // Schedule respawn
        setTimeout(() => spawnOrb(), ORB_RESPAWN_MS);
        break;
      }
    }
  }
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

  // Initialize score for this player if not already tracked
  if (!scores.has(userId)) scores.set(userId, 0);
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
  scores.delete(userId);
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
    orbs: orbsSnapshot(),
    scores: scoresSnapshot(),
  });

  for (const player of players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(message);
    }
  }
}

let lastTickAt = Date.now();

// Game loop: se ejecuta 20 veces por segundo
function tick() {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000; // tiempo desde el ultimo tick
  lastTickAt = now;

  for (const player of players.values()) {
    const { x: intentX, y: intentY } = player.intent;
    const magnitude = Math.hypot(intentX, intentY);

    let velocityX = 0;
    let velocityY = 0;

    if (magnitude > 0) {
      // Normalizar para que moverse en diagonal no sea mas rapido
      velocityX = (intentX / magnitude) * PLAYER_SPEED;
      velocityY = (intentY / magnitude) * PLAYER_SPEED;
    }

    // No dejar que se salga del mapa
    player.x = Math.max(
      PLAYER_RADIUS,
      Math.min(WORLD_WIDTH - PLAYER_RADIUS, player.x + velocityX * dt)
    );
    player.y = Math.max(
      PLAYER_RADIUS,
      Math.min(WORLD_HEIGHT - PLAYER_RADIUS, player.y + velocityY * dt)
    );
  }

  // Detectar colisiones con orbs
  checkOrbCollisions();

  // Mandar el estado actualizado a todos los clientes
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
      orbRadius: ORB_RADIUS,
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

    // El cliente manda hacia donde quiere moverse, no su posicion
    if (payload && payload.type === 'intent') {
      const candidate = payload.intent || payload.direction || payload.dir || payload;
      const nextIntent = (candidate && candidate.dir) ? candidate.dir : candidate;

      // Limpiar los valores para que solo sean -1, 0 o 1
      const sanitizedX = sanitizeAxis(nextIntent && nextIntent.x);
      const sanitizedY = sanitizeAxis(nextIntent && nextIntent.y);

      currentPlayer.intent = {
        x: sanitizedX,
        y: sanitizedY,
      };

      return;
    }

    // Extras: datos adicionales como el color del jugador
    if (isPlainObject(payload) && payload.type === 'extras_update') {
      const extras = payload.extras;

      if (!isPlainObject(extras)) {
        return;
      }

      // Limitar tamaño para que no manden datos enormes
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

initOrbs();
setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`COORDINATOR activo en puerto ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`Health:    http://localhost:${PORT}/health`);
  console.log(`Status:    http://localhost:${PORT}/status`);
});
