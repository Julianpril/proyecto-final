/**
 * coordinator/index.js — Fase 3: Coordinator con Mesh P2P
 *
 * Arquitectura:
 * ─────────────
 * • Doble servidor WebSocket:
 *   - publicUrl (PORT)      → exclusivo para jugadores locales
 *   - peerUrl  (PEER_PORT)  → exclusivo para comunicación entre coordinadores
 *
 * • Estado Global:
 *   El mapa `players` contiene a TODOS los jugadores del mundo:
 *   - Locales:  tienen `local: true` y un `socket` WebSocket activo.
 *   - Remotos:  tienen `local: false` y `socket: null`, actualizados vía Mesh.
 *
 * • Prevención de Bucles (Origin):
 *   Todo mensaje propagado en el Mesh incluye el campo `origin` con el
 *   coordinatorId que originó el evento. Si un nodo recibe un mensaje
 *   cuyo `origin` es su propio coordinatorId, lo descarta inmediatamente.
 *
 * • Resolución de Conflictos de Conexión (Orden Lexicográfico):
 *   Para evitar conexiones bidireccionales duplicadas entre dos nodos,
 *   solo el coordinador con ID lexicográficamente MENOR inicia la
 *   conexión hacia el MAYOR. Si un peer con ID mayor intenta conectar
 *   y ya existe una conexión, se cierra la nueva inmediatamente.
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const jwt       = require('jsonwebtoken');
const { URL }   = require('url');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN (variables de entorno)
// ═══════════════════════════════════════════════════════════════════════

const PORT             = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET       = process.env.JWT_SECRET;
const COORDINATOR_ID   = process.env.COORDINATOR_ID || `coord-${PORT}`;
const PUBLIC_URL       = process.env.PUBLIC_URL || `ws://localhost:${PORT}`;
const PEER_URL         = process.env.PEER_URL || `ws://localhost:${PORT}/peer`;
const AUTH_SERVICE_URL  = process.env.AUTH_SERVICE_URL || 'http://localhost:4000';

// Constantes del juego
const TICK_RATE      = 20;
const PLAYER_SPEED   = 200;
const PLAYER_RADIUS  = 16;
const WORLD_WIDTH    = 1600;
const WORLD_HEIGHT   = 900;
const TICK_MS        = 1000 / TICK_RATE;

const MAX_ORBS             = 30;
const ORB_RADIUS           = 8;
const ORB_RESPAWN_MS       = 5000;
const ORB_COLLECT_DISTANCE = PLAYER_RADIUS + ORB_RADIUS;

// Intervalos del Mesh
const HEARTBEAT_INTERVAL_MS      = 2000;  // Heartbeat al Auth Service cada 2s
const PEER_DISCOVERY_INTERVAL_MS = 3000;  // Descubrimiento de peers cada 3s

if (!JWT_SECRET) {
  console.error('[CONFIG] JWT_SECRET no definido en .env');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mapa global de TODOS los jugadores (locales + remotos).
 *
 * Key:   userId (number | string)
 * Value: {
 *   x: number,               — posición X en el mundo
 *   y: number,               — posición Y en el mundo
 *   intent: { x, y },        — dirección de movimiento (-1, 0, 1)
 *   extras: object,           — datos adicionales (color, etc.)
 *   username: string,
 *   socket: WebSocket | null, — null para jugadores remotos
 *   local: boolean,           — true = conectado a ESTE coordinador
 *   connectedAt: number       — timestamp de conexión
 * }
 */
const players = new Map();

/** Mapa de orbes locales (ID -> datos del orbe) */
const orbs = new Map();

/** Mapa de puntuaciones globales (userId -> score) */
const scores = new Map();

/**
 * Mapa de conexiones WebSocket activas a peers del Mesh.
 * Key:   coordinatorId (string)
 * Value: WebSocket
 */
const peerConnections = new Map();

/**
 * Información de peers conocidos para referencia.
 * Key:   coordinatorId (string)
 * Value: { publicUrl, peerUrl }
 */
const knownPeers = new Map();

// ═══════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════════════════════════════════════

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeAxis(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
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
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/** Cuenta solo los jugadores locales con socket activo */
function countLocalPlayers() {
  let count = 0;
  for (const player of players.values()) {
    if (player.local && player.socket && player.socket.readyState === WebSocket.OPEN) {
      count++;
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════
//  ORBES Y PUNTUACIÓN
// ═══════════════════════════════════════════════════════════════════════

let nextOrbId = 1;

function spawnOrb() {
  const id = nextOrbId++;
  const types = [
    { type: 'gold', points: 10, color: '#FFD700', prob: 0.7 },
    { type: 'diamond', points: 30, color: '#00FFFF', prob: 0.2 },
    { type: 'ruby', points: 50, color: '#FF3366', prob: 0.1 },
  ];
  const r = Math.random();
  let acc = 0;
  let orbType = types[0];
  for (const t of types) {
    acc += t.prob;
    if (r <= acc) { orbType = t; break; }
  }
  const pos = createSpawnPosition();
  orbs.set(id, {
    id, x: pos.x, y: pos.y,
    type: orbType.type, points: orbType.points, color: orbType.color,
  });
}

function initOrbs() {
  for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
}

function orbsSnapshot() {
  return Array.from(orbs.values()).map(o => ({
    id: o.id, x: o.x, y: o.y, type: o.type, points: o.points, color: o.color
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
      if (!player.local) continue; // Solo verificamos colisiones de nuestros clientes locales

      const dx = player.x - orb.x;
      const dy = player.y - orb.y;
      if (Math.hypot(dx, dy) <= ORB_COLLECT_DISTANCE) {
        const prev = scores.get(userId) || 0;
        const newScore = prev + orb.points;
        scores.set(userId, newScore);
        orbs.delete(orbId);

        // Notificar recolección a clientes locales
        const msg = JSON.stringify({
          type: 'orb_collected',
          orbId,
          collector: { userId, username: player.username },
          orbType: orb.type,
          points: orb.points,
          newScore
        });
        for (const p of players.values()) {
          if (p.local && p.socket && p.socket.readyState === 1) {
            p.socket.send(msg);
          }
        }

        // Replicar puntaje al Mesh para sincronizar el ranking global
        broadcastToPeers({
          type: 'score_replicate',
          origin: COORDINATOR_ID,
          userId,
          score: newScore
        });

        setTimeout(spawnOrb, ORB_RESPAWN_MS);
        break; // Rompe el loop de jugadores para este orbe
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  AUTENTICACIÓN DE JUGADORES (WebSocket upgrade en publicUrl)
// ═══════════════════════════════════════════════════════════════════════

function verifyUpgradeToken(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== '/connect') {
    throw new Error('Ruta WebSocket inválida');
  }
  const token = requestUrl.searchParams.get('token');
  if (!token) throw new Error('Token no proporcionado');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded || !decoded.userId || !decoded.username) {
    throw new Error('Token JWT sin userId/username');
  }
  return { userId: decoded.userId, username: decoded.username };
}

function rejectUpgrade(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

// ═══════════════════════════════════════════════════════════════════════
//  GESTIÓN DE JUGADORES (local + remoto)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Registra o actualiza un jugador LOCAL (conectado a este coordinador).
 * Si ya existía como local con otro socket, cierra el socket anterior.
 */
function upsertLocalPlayer(userId, username, socket) {
  const previous = players.get(userId);
  if (previous && previous.local && previous.socket &&
      previous.socket !== socket && previous.socket.readyState === WebSocket.OPEN) {
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
    local: true,
    connectedAt: Date.now(),
  });
  if (!scores.has(userId)) scores.set(userId, 0);
  return players.get(userId);
}

/**
 * Elimina un jugador LOCAL. Verifica que el socket coincida para
 * no eliminar accidentalmente si hubo una reconexión rápida.
 */
function removeLocalPlayer(userId, socket) {
  const current = players.get(userId);
  if (!current) return;
  if (!current.local) return;
  if (socket && current.socket !== socket) return;
  players.delete(userId);
  scores.delete(userId);
}

/**
 * Registra o actualiza un jugador REMOTO (conectado a otro coordinador).
 * Si ya es un jugador local, NO se sobrescribe (el local tiene prioridad).
 */
function upsertRemotePlayer(userId, username, x, y) {
  const existing = players.get(userId);
  if (existing && existing.local) return;
  players.set(userId, {
    x: x || 0,
    y: y || 0,
    intent: { x: 0, y: 0 },
    extras: {},
    username,
    socket: null,
    local: false,
    connectedAt: Date.now(),
  });
}

/**
 * Elimina un jugador REMOTO. No toca jugadores locales.
 */
function removeRemotePlayer(userId) {
  const current = players.get(userId);
  if (!current) return;
  if (current.local) return;
  players.delete(userId);
  scores.delete(userId);
}

// ═══════════════════════════════════════════════════════════════════════
//  SNAPSHOT Y BROADCAST
// ═══════════════════════════════════════════════════════════════════════

/** Genera un snapshot del estado global (todos los jugadores). */
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

/**
 * Broadcast del state SOLO a clientes locales (publicUrl).
 * REGLA ESTRICTA: Nunca se envía el state a otros coordinadores del Mesh.
 */
function broadcastStateToLocalClients(now) {
  const message = JSON.stringify({
    type: 'state',
    t: now,
    players: snapshot(),
    orbs: orbsSnapshot(),
    scores: scoresSnapshot(),
  });
  for (const player of players.values()) {
    if (player.local && player.socket && player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  MESH: BROADCAST A PEERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Envía un mensaje a TODOS los peers conectados en el Mesh.
 * El campo `origin` ya debe estar incluido en el mensaje.
 */
function broadcastToPeers(message) {
  const raw = JSON.stringify(message);
  for (const [peerId, ws] of peerConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SERVIDOR UNIFICADO — Puerto PORT (Jugadores y Mesh)
// ═══════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
const server = http.createServer(app);

const wssPublic = new WebSocketServer({ noServer: true });
const wssPeer = new WebSocketServer({ noServer: true });

// ── Endpoints HTTP públicos ──

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'coordinator',
    coordinatorId: COORDINATOR_ID,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (_req, res) => {
  res.json({
    coordinatorId: COORDINATOR_ID,
    localPlayers: countLocalPlayers(),
    totalPlayers: players.size,
    peers: Array.from(peerConnections.keys()),
    players: snapshot(),
    timestamp: new Date().toISOString(),
  });
});

// ── Enrutador de WebSocket (Upgrade) ──

server.on('upgrade', (req, socket, head) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (pathname === '/connect') {
      // Conexión de un cliente (jugador)
      const user = verifyUpgradeToken(req);
      wssPublic.handleUpgrade(req, socket, head, (ws) => {
        wssPublic.emit('connection', ws, req, user);
      });
    } else if (pathname === '/peer') {
      // Conexión de otro coordinador (Mesh P2P)
      wssPeer.handleUpgrade(req, socket, head, (ws) => {
        wssPeer.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  } catch (error) {
    console.error(`[WS] Upgrade rechazado: ${error.message}`);
    rejectUpgrade(socket);
  }
});

// ── Manejo de conexiones de jugadores ──

wssPublic.on('connection', (ws, _req, user) => {
  const { userId, username } = user;
  const currentPlayer = upsertLocalPlayer(userId, username, ws);
  console.log(`[PUBLIC-WS] ✅ Jugador conectado: "${username}" (${userId})`);

  // Enviar welcome al jugador
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

  // ── Replicar al Mesh: nuevo jugador local se conectó ──
  broadcastToPeers({
    type: 'player_joined',
    origin: COORDINATOR_ID,
    userId,
    username,
    x: currentPlayer.x,
    y: currentPlayer.y,
  });

  // ── Mensajes del jugador ──
  ws.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }

    const player = players.get(userId);
    if (!player || !player.local) return;

    // Intent (movimiento)
    if (payload && payload.type === 'intent') {
      const candidate = payload.intent || payload.direction || payload.dir || payload;
      const nextIntent = (candidate && candidate.dir) ? candidate.dir : candidate;
      const sanitizedX = sanitizeAxis(nextIntent && nextIntent.x);
      const sanitizedY = sanitizeAxis(nextIntent && nextIntent.y);
      player.intent = { x: sanitizedX, y: sanitizedY };

      // Replicar intent al Mesh
      broadcastToPeers({
        type: 'intent_replicate',
        origin: COORDINATOR_ID,
        userId,
        intent: { x: sanitizedX, y: sanitizedY },
      });
      return;
    }

    // Extras update (color, etc.)
    if (isPlainObject(payload) && payload.type === 'extras_update') {
      const extras = payload.extras;
      if (!isPlainObject(extras)) return;
      const serialized = JSON.stringify(extras);
      if (serialized.length > 1024) return;
      player.extras = JSON.parse(serialized);

      // Replicar extras al Mesh
      broadcastToPeers({
        type: 'extras_replicate',
        origin: COORDINATOR_ID,
        userId,
        extras: player.extras,
      });
    }
  });

  // ── Desconexión del jugador ──
  ws.on('close', () => {
    console.log(`[PUBLIC-WS] ❌ Jugador desconectado: "${username}" (${userId})`);
    removeLocalPlayer(userId, ws);

    // Replicar desconexión al Mesh
    broadcastToPeers({
      type: 'player_left',
      origin: COORDINATOR_ID,
      userId,
    });
  });

  ws.on('error', (error) => {
    console.error(`[PUBLIC-WS] Error de ${username}:`, error.message);
  });
});

// ── Procesamiento de mensajes del Mesh ──

/**
 * Procesa un mensaje recibido desde un peer del Mesh.
 * Actualiza el estado global (jugadores remotos) pero
 * NO retransmite al Mesh (evita propagación infinita).
 */
function handlePeerMessage(data, senderCoordinatorId) {
  let msg;
  try {
    msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch { return; }

  // ══════════════════════════════════════════════════════════════════
  //  PREVENCIÓN DE BUCLES:
  //  Si el `origin` del mensaje es nuestro propio coordinatorId,
  //  lo descartamos inmediatamente. Esto previene que un mensaje
  //  que nosotros originamos nos sea devuelto por otro nodo.
  // ══════════════════════════════════════════════════════════════════
  if (msg.origin === COORDINATOR_ID) return;

  switch (msg.type) {
    case 'player_joined': {
      console.log(`[MESH] 🟢 Jugador remoto conectado: "${msg.username}" (${msg.userId}) vía ${senderCoordinatorId}`);
      upsertRemotePlayer(msg.userId, msg.username, msg.x, msg.y);
      break;
    }

    case 'player_left': {
      console.log(`[MESH] 🔴 Jugador remoto desconectado: (${msg.userId}) vía ${senderCoordinatorId}`);
      removeRemotePlayer(msg.userId);
      break;
    }

    case 'intent_replicate': {
      const player = players.get(msg.userId);
      if (player && !player.local && msg.intent) {
        player.intent = {
          x: sanitizeAxis(msg.intent.x),
          y: sanitizeAxis(msg.intent.y),
        };
      }
      break;
    }

    case 'extras_replicate': {
      const player = players.get(msg.userId);
      if (player && !player.local && isPlainObject(msg.extras)) {
        const serialized = JSON.stringify(msg.extras);
        if (serialized.length <= 1024) {
          player.extras = JSON.parse(serialized);
        }
      }
      break;
    }

    case 'score_replicate': {
      if (typeof msg.score === 'number') {
        scores.set(msg.userId, msg.score);
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Envía a un peer el estado actual de todos nuestros jugadores locales.
 * Se usa al establecer una nueva conexión para sincronizar estado inicial.
 */
function sendLocalPlayersToSocket(ws) {
  for (const [userId, player] of players) {
    if (player.local) {
      sendJson(ws, {
        type: 'player_joined',
        origin: COORDINATOR_ID,
        userId,
        username: player.username,
        x: player.x,
        y: player.y,
      });
    }
  }
}

// ── Conexiones ENTRANTES de peers ──

wssPeer.on('connection', (ws, _req) => {
  let remoteCoordinatorId = null;

  ws.on('message', (data) => {
    // Fase 1: esperamos el handshake "hello" para identificar al peer
    if (!remoteCoordinatorId) {
      let msg;
      try {
        msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      } catch {
        ws.close();
        return;
      }

      if (msg.type !== 'hello' || !msg.coordinatorId) {
        console.warn('[MESH] Conexión entrante sin handshake válido, cerrando.');
        ws.close();
        return;
      }

      remoteCoordinatorId = msg.coordinatorId;
      console.log(`[MESH] 🤝 Handshake entrante de: ${remoteCoordinatorId}`);

      // ════════════════════════════════════════════════════════════════
      //  RESOLUCIÓN DE CONFLICTOS (Orden Lexicográfico):
      //
      //  Regla: Solo el coordinator con ID lexicográficamente MENOR
      //  inicia la conexión hacia el MAYOR.
      //
      //  Si recibimos una conexión de un peer con ID MAYOR al nuestro
      //  Y ya tenemos una conexión activa hacia él, cerramos la nueva
      //  conexión para evitar duplicados bidireccionales.
      //
      //  Ejemplo: Si somos "coord-a" y llega "coord-b" (mayor),
      //  pero ya tenemos una conexión saliente a "coord-b",
      //  la nueva entrante es redundante → se cierra.
      // ════════════════════════════════════════════════════════════════
      if (remoteCoordinatorId > COORDINATOR_ID && peerConnections.has(remoteCoordinatorId)) {
        console.log(`[MESH] ⚠️  Duplicado detectado con ${remoteCoordinatorId} (ID mayor), cerrando entrante.`);
        ws.close();
        return;
      }

      // Registrar la conexión entrante
      peerConnections.set(remoteCoordinatorId, ws);
      console.log(`[MESH] ✅ Peer conectado (entrante): ${remoteCoordinatorId}. Total peers: ${peerConnections.size}`);

      // Responder con nuestro hello
      sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID });

      // Sincronizar: enviar nuestros jugadores locales al nuevo peer
      sendLocalPlayersToSocket(ws);
      return;
    }

    // Fase 2: mensajes normales del Mesh (post-handshake)
    handlePeerMessage(data, remoteCoordinatorId);
  });

  ws.on('close', () => {
    if (remoteCoordinatorId) {
      console.log(`[MESH] ❌ Peer desconectado (entrante): ${remoteCoordinatorId}`);
      if (peerConnections.get(remoteCoordinatorId) === ws) {
        peerConnections.delete(remoteCoordinatorId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[MESH] Error en peer ${remoteCoordinatorId || 'desconocido'}:`, err.message);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  CONEXIONES SALIENTES A PEERS (Descubrimiento)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Conecta a un peer descubierto vía el directorio del Auth Service.
 *
 * REGLA DE ORDEN LEXICOGRÁFICO:
 * Esta función solo debe llamarse cuando COORDINATOR_ID < peerId,
 * es decir, nosotros somos el "menor" e iniciamos hacia el "mayor".
 */
function connectToPeer(peerId, peerUrlStr) {
  if (peerConnections.has(peerId)) return;

  console.log(`[MESH] 📡 Conectando a peer: ${peerId} en ${peerUrlStr}`);
  const ws = new WebSocket(peerUrlStr);
  let handshakeComplete = false;

  ws.on('open', () => {
    // Enviar handshake hello
    sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID });
  });

  ws.on('message', (data) => {
    if (!handshakeComplete) {
      let msg;
      try {
        msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      } catch { return; }

      if (msg.type === 'hello') {
        handshakeComplete = true;
        peerConnections.set(peerId, ws);
        console.log(`[MESH] ✅ Peer conectado (saliente): ${peerId}. Total peers: ${peerConnections.size}`);

        // Sincronizar: enviar nuestros jugadores locales al nuevo peer
        sendLocalPlayersToSocket(ws);
      }
      return;
    }

    // Mensajes normales del Mesh (post-handshake)
    handlePeerMessage(data, peerId);
  });

  ws.on('close', () => {
    console.log(`[MESH] ❌ Peer desconectado (saliente): ${peerId}`);
    if (peerConnections.get(peerId) === ws) {
      peerConnections.delete(peerId);
    }
    handshakeComplete = false;
  });

  ws.on('error', (err) => {
    console.error(`[MESH] Error conectando a ${peerId}:`, err.message);
  });
}

/**
 * Descubrimiento periódico de peers.
 * Hace GET al Auth Service en /peers para obtener la lista de coordinadores vivos.
 *
 * Lógica de conexión:
 *  1. Ignorar nuestro propio coordinatorId.
 *  2. Si ya estamos conectados al peer, no hacer nada.
 *  3. Solo iniciar conexión si COORDINATOR_ID < peer.coordinatorId
 *     (nosotros somos el "menor", el "mayor" recibe).
 */
async function discoverPeers() {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/peers`);
    if (!response.ok) {
      console.warn(`[MESH] Error obteniendo peers: HTTP ${response.status}`);
      return;
    }
    const data = await response.json();
    // El Auth Service devuelve { peers: [...] }
    const peers = Array.isArray(data) ? data : (data.peers || []);

    for (const peer of peers) {
      if (peer.coordinatorId === COORDINATOR_ID) continue;

      knownPeers.set(peer.coordinatorId, {
        publicUrl: peer.publicUrl,
        peerUrl: peer.peerUrl,
      });

      if (peerConnections.has(peer.coordinatorId)) continue;

      // ── REGLA DE ORDEN LEXICOGRÁFICO ──
      // Solo el menor inicia conexión hacia el mayor.
      if (COORDINATOR_ID < peer.coordinatorId) {
        connectToPeer(peer.coordinatorId, peer.peerUrl);
      }
    }
  } catch (error) {
    console.warn(`[MESH] Error en descubrimiento de peers:`, error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  HEARTBEAT AL AUTH SERVICE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Envía un heartbeat al Auth Service cada HEARTBEAT_INTERVAL_MS.
 * Registra/actualiza este coordinator en el directorio de nodos vivos.
 *
 * Body: { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime }
 * connectedPlayers cuenta solo los sockets locales activos.
 */
async function sendHeartbeat() {
  try {
    const body = {
      coordinatorId: COORDINATOR_ID,
      publicUrl: PUBLIC_URL,
      peerUrl: PEER_URL,
      connectedPlayers: countLocalPlayers(),
      uptime: process.uptime(),
    };
    const response = await fetch(`${AUTH_SERVICE_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[HEARTBEAT] Error: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(`[HEARTBEAT] Error enviando heartbeat:`, error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  GAME LOOP (20 Hz)
// ═══════════════════════════════════════════════════════════════════════

let lastTickAt = Date.now();

/**
 * Tick del juego ejecutado a 20 Hz.
 *
 * REGLA: La física y los movimientos (intents) se aplican a TODOS
 * los jugadores del mapa (locales Y remotos).
 *
 * REGLA ESTRICTA: Al final del tick, el state se envía ÚNICAMENTE
 * a los clientes conectados al servidor local (publicUrl). Nunca
 * se envía el state a otros coordinadores del Mesh.
 */
function tick() {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000;
  lastTickAt = now;

  // Aplicar física a TODOS los jugadores (locales + remotos)
  for (const player of players.values()) {
    const { x: intentX, y: intentY } = player.intent;
    const magnitude = Math.hypot(intentX, intentY);
    let velocityX = 0;
    let velocityY = 0;
    if (magnitude > 0) {
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

  // Comprobar si algún jugador local chocó con un orbe local
  checkOrbCollisions();

  // Broadcast state SOLO a clientes locales (publicUrl)
  broadcastStateToLocalClients(now);
}

// ═══════════════════════════════════════════════════════════════════════
//  ARRANQUE DEL SERVIDOR
// ═══════════════════════════════════════════════════════════════════════

// Iniciar game loop a 20 Hz
setInterval(tick, TICK_MS);

// Iniciar heartbeat al Auth Service cada 2 segundos
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

// Iniciar descubrimiento de peers cada 3 segundos
setInterval(discoverPeers, PEER_DISCOVERY_INTERVAL_MS);

// Generar los primeros orbes locales
initOrbs();

// Levantar servidor unificado (jugadores y Mesh) en PORT
server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  COORDINATOR [${COORDINATOR_ID}] — Fase 3 Mesh P2P`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`Public WS:  ${PUBLIC_URL}/connect?token=<JWT>`);
  console.log(`Peer WS:    ${PEER_URL}`);
  console.log(`Health:     http://localhost:${PORT}/health`);
  console.log(`Auth:       ${AUTH_SERVICE_URL}`);
  console.log(`═══════════════════════════════════════════════════════`);
});
