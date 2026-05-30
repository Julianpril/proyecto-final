/**
 * coordinator/index.js — Fase 3: Mesh P2P + Agar.io + Chat (Track 2.6) + Spectator (Track 2.5)
 *
 * Arquitectura:
 * ─────────────
 * • Doble servidor WebSocket en el mismo puerto:
 *   - /connect  → jugadores autenticados (JWT)
 *   - /peer     → comunicación entre coordinadores (mesh P2P)
 *   - /spectate → espectadores sin autenticación (solo lectura)
 *
 * • Mecánica Agar.io:
 *   - Radio dinámico: BASE_RADIUS + sqrt(score) * GROWTH_FACTOR
 *   - Un jugador come a otro si es ≥ 15% más grande y los centros se solapan
 *   - Al ser comido: respawn en posición aleatoria con score = 0
 *
 * • Chat distribuido (Track 2.6):
 *   - Mensajes validados (longitud, caracteres de control, rate limit 1/s)
 *   - Historial en memoria (últimos 50 mensajes)
 *   - Replicación al mesh; deduplicación por ID para evitar bucles
 *
 * • Spectator mode (Track 2.5):
 *   - Sin autenticación; recibe state, chat y kill-feed
 *   - Máx. 50 espectadores por coordinador
 *   - Mensajes entrantes de espectadores se ignoran silenciosamente
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const jwt       = require('jsonwebtoken');
const { URL }   = require('url');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════════

const PORT             = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET       = process.env.JWT_SECRET;
const COORDINATOR_ID   = process.env.COORDINATOR_ID || `coord-${PORT}`;
const PUBLIC_URL       = process.env.PUBLIC_URL || `ws://localhost:${PORT}`;
const PEER_URL         = process.env.PEER_URL || `ws://localhost:${PORT}/peer`;
const AUTH_URLS_RAW    = process.env.AUTH_URLS || process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const AUTH_URLS        = AUTH_URLS_RAW.split(',').map(s => s.trim()).filter(Boolean);

// Constantes de juego (Agar.io)
const TICK_RATE      = 20;
const PLAYER_SPEED   = 200;
const BASE_RADIUS    = 16;       // Radio mínimo (score = 0)
const MAX_RADIUS     = 75;       // Radio máximo
const GROWTH_FACTOR  = 1.5;      // Crecimiento por raíz del score
const MIN_EAT_RATIO  = 1.15;     // Necesitas ser 15% más grande para comer
const WORLD_WIDTH    = 1600;
const WORLD_HEIGHT   = 900;
const TICK_MS        = 1000 / TICK_RATE;

const MAX_ORBS       = 30;
const ORB_RADIUS     = 8;
const ORB_RESPAWN_MS = 5000;

// Chat (Track 2.6)
const CHAT_MAX_LEN      = 200;
const CHAT_HISTORY_SIZE = 50;
const CHAT_RATE_MS      = 1000;  // mínimo 1 segundo entre mensajes

// Spectator (Track 2.5)
const MAX_SPECTATORS = 50;

// Intervalos del Mesh
const HEARTBEAT_INTERVAL_MS      = 2000;
const PEER_DISCOVERY_INTERVAL_MS = 3000;

if (!JWT_SECRET) {
  console.error('[CONFIG] JWT_SECRET no definido en .env');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════════════

/** Todos los jugadores del mundo (locales + remotos) */
const players = new Map();

/** Orbes del mundo (ID → datos) */
const orbs = new Map();

/** Puntuaciones globales (userId → score) */
const scores = new Map();

/** Conexiones WS activas a peers del Mesh */
const peerConnections = new Map();

/** Metadatos de peers conocidos */
const knownPeers = new Map();

// ── Chat ──
const chatHistory  = [];          // últimos CHAT_HISTORY_SIZE mensajes
let   chatMsgCtr   = 0;           // contador local para IDs únicos
const chatRateLimits = new Map(); // userId → timestamp último mensaje
const seenChatIds    = new Set(); // IDs de mensajes ya procesados (dedup)

// ── Spectators ──
const spectators = new Set();

// ═══════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════════════════════════════════════

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeAxis(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.sign(n) : 0;
}

function createSpawnPosition() {
  return {
    x: BASE_RADIUS + Math.random() * (WORLD_WIDTH  - BASE_RADIUS * 2),
    y: BASE_RADIUS + Math.random() * (WORLD_HEIGHT - BASE_RADIUS * 2),
  };
}

function sendJson(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function countLocalPlayers() {
  let n = 0;
  for (const p of players.values()) {
    if (p.local && p.socket && p.socket.readyState === WebSocket.OPEN) n++;
  }
  return n;
}

/** Radio del jugador basado en su puntuación (mecánica Agar.io) */
function getRadius(score) {
  return Math.min(MAX_RADIUS, BASE_RADIUS + Math.sqrt(Math.max(0, score)) * GROWTH_FACTOR);
}

// ═══════════════════════════════════════════════════════════════════════
//  BROADCAST A CLIENTES (jugadores + espectadores)
// ═══════════════════════════════════════════════════════════════════════

function broadcastToLocalPlayers(rawMsg) {
  for (const p of players.values()) {
    if (p.local && p.socket && p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(rawMsg);
    }
  }
}

function broadcastToSpectators(rawMsg) {
  for (const ws of spectators) {
    if (ws.readyState === WebSocket.OPEN) ws.send(rawMsg);
  }
}

function broadcastToAll(rawMsg) {
  broadcastToLocalPlayers(rawMsg);
  broadcastToSpectators(rawMsg);
}

// ═══════════════════════════════════════════════════════════════════════
//  ORBES Y PUNTUACIÓN
// ═══════════════════════════════════════════════════════════════════════

let nextOrbId = 1;

function spawnOrb() {
  const id = nextOrbId++;
  const types = [
    { type: 'gold',    points: 10, color: '#FFD700', prob: 0.7 },
    { type: 'diamond', points: 30, color: '#00FFFF', prob: 0.2 },
    { type: 'ruby',    points: 50, color: '#FF3366', prob: 0.1 },
  ];
  const r = Math.random();
  let acc = 0;
  let orbType = types[0];
  for (const t of types) { acc += t.prob; if (r <= acc) { orbType = t; break; } }
  const pos = createSpawnPosition();
  orbs.set(id, { id, x: pos.x, y: pos.y, type: orbType.type, points: orbType.points, color: orbType.color });
}

function initOrbs() {
  for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
}

function orbsSnapshot() {
  return Array.from(orbs.values()).map(o => ({
    id: o.id, x: o.x, y: o.y, type: o.type, points: o.points, color: o.color,
  }));
}

function scoresSnapshot() {
  const list = [];
  for (const [userId, score] of scores) {
    const p = players.get(userId);
    if (p) list.push({ userId, username: p.username, score });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

function checkOrbCollisions() {
  for (const [orbId, orb] of orbs) {
    for (const [userId, player] of players) {
      if (!player.local) continue;
      const playerRadius  = getRadius(scores.get(userId) || 0);
      const collectDist   = playerRadius + ORB_RADIUS;
      if (Math.hypot(player.x - orb.x, player.y - orb.y) > collectDist) continue;

      const prev     = scores.get(userId) || 0;
      const newScore = prev + orb.points;
      scores.set(userId, newScore);
      orbs.delete(orbId);

      broadcastToAll(JSON.stringify({
        type: 'orb_collected',
        orbId,
        collector: { userId, username: player.username },
        orbType: orb.type,
        points: orb.points,
        newScore,
      }));

      broadcastToPeers({ type: 'score_replicate', origin: COORDINATOR_ID, userId, score: newScore });
      setTimeout(spawnOrb, ORB_RESPAWN_MS);
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  COLISIONES ENTRE JUGADORES (mecánica Agar.io)
// ═══════════════════════════════════════════════════════════════════════

const RESPAWN_INVINCIBILITY_MS = 3000;

function respawnPlayer(userId, player) {
  const pos = createSpawnPosition();
  player.x = pos.x;
  player.y = pos.y;
  player.respawnedAt = Date.now();
  scores.set(userId, 0);
}

function checkPlayerCollisions() {
  for (const [idA, pA] of players) {
    if (!pA.local) continue;              // Solo el coordinador del asesino procesa la muerte
    const scoreA = scores.get(idA) || 0;
    const radA   = getRadius(scoreA);

    for (const [idB, pB] of players) {
      if (idA === idB) continue;

      // Invincibility window after respawn — can't be eaten for 3s
      if (pB.respawnedAt && (Date.now() - pB.respawnedAt) < RESPAWN_INVINCIBILITY_MS) continue;

      const scoreB = scores.get(idB) || 0;
      const radB   = getRadius(scoreB);

      if (radA <= radB * MIN_EAT_RATIO) continue;  // A no es suficientemente grande
      if (Math.hypot(pA.x - pB.x, pA.y - pB.y) > radA) continue;

      // ─── A come a B ───
      const gain      = Math.max(10, Math.floor(scoreB * 0.5));
      const newScoreA = scoreA + gain;
      scores.set(idA, newScoreA);

      const killMsg = JSON.stringify({
        type: 'player_killed',
        killer: { userId: idA, username: pA.username },
        victim: { userId: idB, username: pB.username },
      });
      broadcastToAll(killMsg);

      broadcastToPeers({
        type: 'kill_replicate',
        origin: COORDINATOR_ID,
        killerId: idA, killerUsername: pA.username, killerScore: newScoreA,
        victimId: idB, victimUsername: pB.username,
      });
      broadcastToPeers({ type: 'score_replicate', origin: COORDINATOR_ID, userId: idA, score: newScoreA });

      if (pB.local) {
        respawnPlayer(idB, pB);
        sendJson(pB.socket, { type: 'you_died', killedBy: pA.username });
      } else {
        scores.set(idB, 0);
        pB.respawnedAt = Date.now();  // marca invulnerabilidad en remoto también
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  CHAT DISTRIBUIDO (Track 2.6)
// ═══════════════════════════════════════════════════════════════════════

function addChatMessage(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_SIZE) chatHistory.shift();
}

function broadcastChatToAll(msg) {
  broadcastToAll(JSON.stringify({ type: 'chat', msg }));
}

function handleChatMessage(userId, text) {
  const now     = Date.now();
  const lastMsg = chatRateLimits.get(userId) || 0;
  if (now - lastMsg < CHAT_RATE_MS) return;      // Rate limit
  chatRateLimits.set(userId, now);

  if (typeof text !== 'string') return;
  text = text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;

  const player = players.get(userId);
  const msgId  = `${COORDINATOR_ID}-${++chatMsgCtr}`;
  const msg    = {
    id: msgId,
    userId,
    username: player ? player.username : 'Unknown',
    text,
    ts: now,
  };

  seenChatIds.add(msgId);
  addChatMessage(msg);
  broadcastChatToAll(msg);
  broadcastToPeers({ type: 'chat_replicate', origin: COORDINATOR_ID, msg });
}

// ═══════════════════════════════════════════════════════════════════════
//  AUTENTICACIÓN DE JUGADORES (WebSocket upgrade /connect)
// ═══════════════════════════════════════════════════════════════════════

function verifyUpgradeToken(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== '/connect') throw new Error('Ruta WebSocket inválida');
  const token = requestUrl.searchParams.get('token');
  if (!token) throw new Error('Token no proporcionado');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded || !decoded.userId || !decoded.username) throw new Error('Token JWT inválido');
  return { userId: decoded.userId, username: decoded.username };
}

function rejectUpgrade(socket, code = 401, msg = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// ═══════════════════════════════════════════════════════════════════════
//  GESTIÓN DE JUGADORES
// ═══════════════════════════════════════════════════════════════════════

function upsertLocalPlayer(userId, username, socket) {
  const prev = players.get(userId);
  if (prev && prev.local && prev.socket && prev.socket !== socket && prev.socket.readyState === WebSocket.OPEN) {
    prev.socket.close(4000, 'Nueva conexión desde otro cliente');
  }
  const spawn = createSpawnPosition();
  players.set(userId, {
    x: spawn.x, y: spawn.y,
    intent: { x: 0, y: 0 },
    extras: {},
    username, socket, local: true,
    connectedAt: Date.now(),
  });
  if (!scores.has(userId)) scores.set(userId, 0);
  return players.get(userId);
}

function removeLocalPlayer(userId, socket) {
  const cur = players.get(userId);
  if (!cur || !cur.local) return;
  if (socket && cur.socket !== socket) return;
  players.delete(userId);
  scores.delete(userId);
}

function upsertRemotePlayer(userId, username, x, y) {
  const existing = players.get(userId);
  if (existing && existing.local) return;
  players.set(userId, {
    x: x || 0, y: y || 0,
    intent: { x: 0, y: 0 },
    extras: {},
    username, socket: null, local: false,
    connectedAt: Date.now(),
  });
}

function removeRemotePlayer(userId) {
  const cur = players.get(userId);
  if (!cur || cur.local) return;
  players.delete(userId);
  scores.delete(userId);
}

// ═══════════════════════════════════════════════════════════════════════
//  SNAPSHOT Y BROADCAST DE ESTADO
// ═══════════════════════════════════════════════════════════════════════

function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    x: p.x, y: p.y,
    intent: { ...p.intent },
    extras: p.extras,
    username: p.username,
    connectedAt: new Date(p.connectedAt).toISOString(),
    radius: getRadius(scores.get(userId) || 0),  // Radio dinámico Agar.io
  }));
}

function broadcastStateToAll(now) {
  const message = JSON.stringify({
    type: 'state', t: now,
    players: snapshot(),
    orbs: orbsSnapshot(),
    scores: scoresSnapshot(),
  });
  broadcastToAll(message);
}

// ═══════════════════════════════════════════════════════════════════════
//  MESH: BROADCAST A PEERS
// ═══════════════════════════════════════════════════════════════════════

function broadcastToPeers(message) {
  const raw = JSON.stringify(message);
  for (const ws of peerConnections.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SERVIDOR HTTP + WS
// ═══════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

const server       = http.createServer(app);
const wssPublic    = new WebSocketServer({ noServer: true });
const wssPeer      = new WebSocketServer({ noServer: true });
const wssSpectator = new WebSocketServer({ noServer: true });

// ── HTTP endpoints ──

app.get('/health', (_req, res) => res.json({
  status: 'ok', service: 'coordinator', coordinatorId: COORDINATOR_ID,
  uptime: process.uptime(), timestamp: new Date().toISOString(),
}));

app.get('/status', (_req, res) => res.json({
  coordinatorId: COORDINATOR_ID,
  localPlayers: countLocalPlayers(),
  totalPlayers: players.size,
  spectators: spectators.size,
  peers: Array.from(peerConnections.keys()),
  players: snapshot(),
  chatHistory: chatHistory.slice(-10),
  timestamp: new Date().toISOString(),
}));

// ── Enrutador de WebSocket ──

server.on('upgrade', (req, socket, head) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (pathname === '/connect') {
      const user = verifyUpgradeToken(req);
      wssPublic.handleUpgrade(req, socket, head, (ws) => {
        wssPublic.emit('connection', ws, req, user);
      });

    } else if (pathname === '/peer') {
      wssPeer.handleUpgrade(req, socket, head, (ws) => {
        wssPeer.emit('connection', ws, req);
      });

    } else if (pathname === '/spectate') {
      if (spectators.size >= MAX_SPECTATORS) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      wssSpectator.handleUpgrade(req, socket, head, (ws) => {
        wssSpectator.emit('connection', ws, req);
      });

    } else {
      socket.destroy();
    }
  } catch (err) {
    console.error(`[WS] Upgrade rechazado: ${err.message}`);
    rejectUpgrade(socket);
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  JUGADORES (/connect)
// ═══════════════════════════════════════════════════════════════════════

wssPublic.on('connection', (ws, _req, user) => {
  const { userId, username } = user;
  const currentPlayer = upsertLocalPlayer(userId, username, ws);
  console.log(`[PUBLIC-WS] ✅ Jugador: "${username}" (${userId})`);

  sendJson(ws, {
    type: 'welcome',
    you: {
      userId, username,
      x: currentPlayer.x, y: currentPlayer.y,
      intent: { ...currentPlayer.intent },
      extras: { ...currentPlayer.extras },
      connectedAt: new Date(currentPlayer.connectedAt).toISOString(),
    },
    world: {
      width: WORLD_WIDTH, height: WORLD_HEIGHT,
      playerRadius: BASE_RADIUS, tickRate: TICK_RATE,
    },
    chatHistory: chatHistory.slice(-20),
  });

  broadcastToPeers({ type: 'player_joined', origin: COORDINATOR_ID, userId, username, x: currentPlayer.x, y: currentPlayer.y });

  ws.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }

    const player = players.get(userId);
    if (!player || !player.local) return;

    if (payload.type === 'intent') {
      const candidate   = payload.intent || payload.direction || payload.dir || payload;
      const nextIntent  = (candidate && candidate.dir) ? candidate.dir : candidate;
      const ix = sanitizeAxis(nextIntent && nextIntent.x);
      const iy = sanitizeAxis(nextIntent && nextIntent.y);
      player.intent = { x: ix, y: iy };
      broadcastToPeers({ type: 'intent_replicate', origin: COORDINATOR_ID, userId, intent: { x: ix, y: iy } });
      return;
    }

    if (isPlainObject(payload) && payload.type === 'extras_update') {
      const extras = payload.extras;
      if (!isPlainObject(extras)) return;
      const serialized = JSON.stringify(extras);
      if (serialized.length > 1024) return;
      player.extras = JSON.parse(serialized);
      broadcastToPeers({ type: 'extras_replicate', origin: COORDINATOR_ID, userId, extras: player.extras });
      return;
    }

    if (payload.type === 'chat_message') {
      handleChatMessage(userId, payload.text);
    }
  });

  ws.on('close', () => {
    console.log(`[PUBLIC-WS] ❌ Jugador desconectado: "${username}" (${userId})`);
    removeLocalPlayer(userId, ws);
    chatRateLimits.delete(userId);
    broadcastToPeers({ type: 'player_left', origin: COORDINATOR_ID, userId });
  });

  ws.on('error', (err) => console.error(`[PUBLIC-WS] Error de ${username}:`, err.message));
});

// ═══════════════════════════════════════════════════════════════════════
//  ESPECTADORES (/spectate) — Track 2.5
// ═══════════════════════════════════════════════════════════════════════

wssSpectator.on('connection', (ws) => {
  spectators.add(ws);
  console.log(`[SPECTATOR] 👁️  Espectador conectado. Total: ${spectators.size}`);

  sendJson(ws, {
    type: 'spectator_welcome',
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: BASE_RADIUS, tickRate: TICK_RATE },
    chatHistory: chatHistory.slice(-20),
  });

  ws.on('message', () => {});  // Ignorar silenciosamente

  ws.on('close', () => {
    spectators.delete(ws);
    console.log(`[SPECTATOR] 👁️  Espectador desconectado. Total: ${spectators.size}`);
  });

  ws.on('error', (err) => {
    console.error('[SPECTATOR] Error:', err.message);
    spectators.delete(ws);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  MESH: MENSAJES ENTRANTES DE PEERS
// ═══════════════════════════════════════════════════════════════════════

function handlePeerMessage(data, senderCoordinatorId) {
  let msg;
  try {
    msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch { return; }

  if (msg.origin === COORDINATOR_ID) return;  // Anti-bucle

  switch (msg.type) {

    case 'player_joined':
      console.log(`[MESH] 🟢 Remoto: "${msg.username}" (${msg.userId}) vía ${senderCoordinatorId}`);
      upsertRemotePlayer(msg.userId, msg.username, msg.x, msg.y);
      break;

    case 'player_left':
      console.log(`[MESH] 🔴 Remoto desconectado: (${msg.userId}) vía ${senderCoordinatorId}`);
      removeRemotePlayer(msg.userId);
      break;

    case 'intent_replicate': {
      const p = players.get(msg.userId);
      if (p && !p.local && msg.intent) {
        p.intent = { x: sanitizeAxis(msg.intent.x), y: sanitizeAxis(msg.intent.y) };
      }
      break;
    }

    case 'extras_replicate': {
      const p = players.get(msg.userId);
      if (p && !p.local && isPlainObject(msg.extras)) {
        const s = JSON.stringify(msg.extras);
        if (s.length <= 1024) p.extras = JSON.parse(s);
      }
      break;
    }

    case 'score_replicate':
      if (typeof msg.score === 'number') scores.set(msg.userId, msg.score);
      break;

    case 'kill_replicate': {
      // Actualizar puntuación del asesino
      if (typeof msg.killerScore === 'number') scores.set(msg.killerId, msg.killerScore);

      // Notificar a clientes locales
      broadcastToAll(JSON.stringify({
        type: 'player_killed',
        killer: { userId: msg.killerId, username: msg.killerUsername },
        victim: { userId: msg.victimId, username: msg.victimUsername },
      }));

      // Si la víctima está en ESTE coordinador → respawn
      const victim = players.get(msg.victimId);
      if (victim && victim.local) {
        respawnPlayer(msg.victimId, victim);  // sets respawnedAt
        sendJson(victim.socket, { type: 'you_died', killedBy: msg.killerUsername || 'alguien' });
      } else if (victim) {
        scores.set(msg.victimId, 0);
        victim.respawnedAt = Date.now();
      }
      break;
    }

    case 'chat_replicate': {
      const chatMsg = msg.msg;
      if (!chatMsg || !chatMsg.id || seenChatIds.has(chatMsg.id)) break;
      seenChatIds.add(chatMsg.id);
      // Podar el Set si crece demasiado
      if (seenChatIds.size > 2000) {
        const iter = seenChatIds.values();
        for (let i = 0; i < 500; i++) seenChatIds.delete(iter.next().value);
      }
      addChatMessage(chatMsg);
      broadcastChatToAll(chatMsg);
      break;
    }

    default:
      break;
  }
}

function sendLocalPlayersToSocket(ws) {
  for (const [userId, player] of players) {
    if (player.local) {
      sendJson(ws, { type: 'player_joined', origin: COORDINATOR_ID, userId, username: player.username, x: player.x, y: player.y });
    }
  }
}

// ── Conexiones ENTRANTES de peers ──

wssPeer.on('connection', (ws) => {
  let remoteCoordinatorId = null;

  ws.on('message', (data) => {
    if (!remoteCoordinatorId) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
      catch { ws.close(); return; }

      if (msg.type !== 'hello' || !msg.coordinatorId) {
        console.warn('[MESH] Conexión entrante sin handshake, cerrando.');
        ws.close(); return;
      }

      remoteCoordinatorId = msg.coordinatorId;
      console.log(`[MESH] 🤝 Handshake entrante de: ${remoteCoordinatorId}`);

      if (remoteCoordinatorId > COORDINATOR_ID && peerConnections.has(remoteCoordinatorId)) {
        console.log(`[MESH] ⚠️  Duplicado con ${remoteCoordinatorId}, cerrando entrante.`);
        ws.close(); return;
      }

      peerConnections.set(remoteCoordinatorId, ws);
      console.log(`[MESH] ✅ Peer (entrante): ${remoteCoordinatorId}. Total: ${peerConnections.size}`);
      sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID });
      sendLocalPlayersToSocket(ws);
      return;
    }

    handlePeerMessage(data, remoteCoordinatorId);
  });

  ws.on('close', () => {
    if (remoteCoordinatorId) {
      console.log(`[MESH] ❌ Peer desconectado (entrante): ${remoteCoordinatorId}`);
      if (peerConnections.get(remoteCoordinatorId) === ws) peerConnections.delete(remoteCoordinatorId);
    }
  });

  ws.on('error', (err) => console.error(`[MESH] Error en peer ${remoteCoordinatorId || '?'}:`, err.message));
});

// ── Conexiones SALIENTES a peers ──

function connectToPeer(peerId, peerUrlStr) {
  if (peerConnections.has(peerId)) return;
  console.log(`[MESH] 📡 Conectando a: ${peerId} en ${peerUrlStr}`);
  const ws = new WebSocket(peerUrlStr);
  let handshakeComplete = false;

  ws.on('open', () => sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID }));

  ws.on('message', (data) => {
    if (!handshakeComplete) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
      if (msg.type === 'hello') {
        handshakeComplete = true;
        peerConnections.set(peerId, ws);
        console.log(`[MESH] ✅ Peer (saliente): ${peerId}. Total: ${peerConnections.size}`);
        sendLocalPlayersToSocket(ws);
      }
      return;
    }
    handlePeerMessage(data, peerId);
  });

  ws.on('close', () => {
    console.log(`[MESH] ❌ Peer desconectado (saliente): ${peerId}`);
    if (peerConnections.get(peerId) === ws) peerConnections.delete(peerId);
    handshakeComplete = false;
  });

  ws.on('error', (err) => console.error(`[MESH] Error conectando a ${peerId}:`, err.message));
}

async function discoverPeers() {
  for (const authUrl of AUTH_URLS) {
    try {
      const res = await fetch(`${authUrl}/coordinator-peers`);
      if (!res.ok) {
        // If 503 not_leader, try to find the leader
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          if (body.leaderUrl) {
            const r2 = await fetch(`${body.leaderUrl}/coordinator-peers`).catch(() => null);
            if (r2 && r2.ok) {
              const data = await r2.json();
              _processPeers(data.peers || []);
              return;
            }
          }
        }
        continue;
      }
      const data = await res.json();
      _processPeers(data.peers || []);
      return;
    } catch (_) {}
  }
  console.warn('[MESH] Error en descubrimiento de peers: sin auth disponible');
}

function _processPeers(peers) {
  for (const peer of peers) {
    if (peer.coordinatorId === COORDINATOR_ID) continue;
    knownPeers.set(peer.coordinatorId, { publicUrl: peer.publicUrl, peerUrl: peer.peerUrl });
    if (peerConnections.has(peer.coordinatorId)) continue;
    if (COORDINATOR_ID < peer.coordinatorId) connectToPeer(peer.coordinatorId, peer.peerUrl);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  HEARTBEAT AL AUTH SERVICE
// ═══════════════════════════════════════════════════════════════════════

let _knownLeaderUrl = null;

async function sendHeartbeat() {
  const body = JSON.stringify({
    coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL,
    connectedPlayers: countLocalPlayers(), uptime: process.uptime(),
  });
  const headers = { 'Content-Type': 'application/json' };

  // Try known leader first, then fall through the list
  const targets = _knownLeaderUrl
    ? [_knownLeaderUrl, ...AUTH_URLS.filter(u => u !== _knownLeaderUrl)]
    : AUTH_URLS;

  for (const authUrl of targets) {
    try {
      const res = await fetch(`${authUrl}/heartbeat`, { method: 'POST', headers, body });
      if (res.ok) { _knownLeaderUrl = authUrl; return; }
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        if (data.leaderUrl) {
          const r2 = await fetch(`${data.leaderUrl}/heartbeat`, { method: 'POST', headers, body }).catch(() => null);
          if (r2 && r2.ok) { _knownLeaderUrl = data.leaderUrl; return; }
        }
      }
    } catch (_) {}
  }
  console.warn('[HEARTBEAT] Sin auth leader disponible');
}

// ═══════════════════════════════════════════════════════════════════════
//  GAME LOOP (20 Hz)
// ═══════════════════════════════════════════════════════════════════════

let lastTickAt = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTickAt) / 1000;
  lastTickAt = now;

  // Física de movimiento (todos los jugadores)
  for (const [userId, player] of players) {
    const { x: ix, y: iy } = player.intent;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      const radius = getRadius(scores.get(userId) || 0);
      player.x = Math.max(radius, Math.min(WORLD_WIDTH  - radius, player.x + (ix / mag) * PLAYER_SPEED * dt));
      player.y = Math.max(radius, Math.min(WORLD_HEIGHT - radius, player.y + (iy / mag) * PLAYER_SPEED * dt));
    }
  }

  checkOrbCollisions();
  checkPlayerCollisions();
  broadcastStateToAll(now);
}

// ═══════════════════════════════════════════════════════════════════════
//  ARRANQUE
// ═══════════════════════════════════════════════════════════════════════

setInterval(tick, TICK_MS);
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
setInterval(discoverPeers, PEER_DISCOVERY_INTERVAL_MS);
initOrbs();

server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  COORDINATOR [${COORDINATOR_ID}] — Agar.io + Chat + Spectator`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`Jugadores:   ${PUBLIC_URL}/connect?token=<JWT>`);
  console.log(`Espectador:  ${PUBLIC_URL}/spectate`);
  console.log(`Peer Mesh:   ${PEER_URL}`);
  console.log(`Health:      http://localhost:${PORT}/health`);
  console.log(`Auth:        ${AUTH_URLS.join(', ')}`);
  console.log(`═══════════════════════════════════════════════════════`);
});
