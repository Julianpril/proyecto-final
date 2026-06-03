require('dotenv').config();

const http    = require('http');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

//configuración del servidor

const PORT           = parseInt(process.env.PORT, 10) || 5000;
const JWT_SECRET     = process.env.JWT_SECRET;
const COORDINATOR_ID = process.env.COORDINATOR_ID || `coord-${PORT}`;
const PUBLIC_URL     = process.env.PUBLIC_URL || `ws://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL   || `ws://localhost:${PORT}/peer`;
const AUTH_URLS_RAW  = process.env.AUTH_URLS  || process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const AUTH_URLS      = AUTH_URLS_RAW.split(',').map(s => s.trim()).filter(Boolean);

const TICK_RATE     = 20;
const PLAYER_SPEED  = 200;
const BASE_RADIUS   = 16;
const MAX_RADIUS    = 75;
const GROWTH_FACTOR = 1.5;
const MIN_EAT_RATIO = 1.15;
const WORLD_WIDTH   = 1600;
const WORLD_HEIGHT  = 900;
const TICK_MS       = 1000 / TICK_RATE;

const MAX_ORBS       = 30;
const ORB_RADIUS     = 8;
const ORB_RESPAWN_MS = 5000;

const CHAT_MAX_LEN      = 200;
const CHAT_HISTORY_SIZE = 50;
const CHAT_RATE_MS      = 1000;
const MAX_SPECTATORS    = 50;

const HEARTBEAT_INTERVAL_MS      = 2000;
const PEER_DISCOVERY_INTERVAL_MS = 3000;

if (!JWT_SECRET) { console.error('JWT_SECRET no definido'); process.exit(1); }

//estado

const players        = new Map();
const orbs           = new Map();
const scores         = new Map();
const peerConnections = new Map();
const knownPeers     = new Map();
const chatHistory    = [];
const chatRateLimits = new Map();
const seenChatIds    = new Set();
const spectators     = new Set();

let chatMsgCtr = 0;

//funciones auxiliares

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sanitizeAxis(v)  { const n = Number(v); return Number.isFinite(n) ? Math.sign(n) : 0; }
function createSpawnPosition() {
  return {
    x: BASE_RADIUS + Math.random() * (WORLD_WIDTH  - BASE_RADIUS * 2),
    y: BASE_RADIUS + Math.random() * (WORLD_HEIGHT - BASE_RADIUS * 2),
  };
}
function sendJson(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function countLocalPlayers() {
  let n = 0;
  for (const p of players.values()) if (p.local && p.socket?.readyState === WebSocket.OPEN) n++;
  return n;
}
function getRadius(score) {
  return Math.min(MAX_RADIUS, BASE_RADIUS + Math.sqrt(Math.max(0, score)) * GROWTH_FACTOR);
}

//funciones de difusión de mensajes

function broadcastToLocalPlayers(raw) {
  for (const p of players.values())
    if (p.local && p.socket?.readyState === WebSocket.OPEN) p.socket.send(raw);
}
function broadcastToSpectators(raw) {
  for (const ws of spectators) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}
function broadcastToAll(raw) { broadcastToLocalPlayers(raw); broadcastToSpectators(raw); }
function broadcastToPeers(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of peerConnections.values()) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
}

//orbes

let nextOrbId = 1;

function spawnOrb() {
  const id    = nextOrbId++;
  const types = [
    { type: 'gold',    points: 10, color: '#FFD700', prob: 0.7 },
    { type: 'diamond', points: 30, color: '#00FFFF', prob: 0.2 },
    { type: 'ruby',    points: 50, color: '#FF3366', prob: 0.1 },
  ];
  let acc = 0, orbType = types[0];
  const r = Math.random();
  for (const t of types) { acc += t.prob; if (r <= acc) { orbType = t; break; } }
  const pos = createSpawnPosition();
  orbs.set(id, { id, x: pos.x, y: pos.y, ...orbType });
}

function initOrbs() { for (let i = 0; i < MAX_ORBS; i++) spawnOrb(); }

function orbsSnapshot() {
  return Array.from(orbs.values()).map(o => ({ id: o.id, x: o.x, y: o.y, type: o.type, points: o.points, color: o.color }));
}

function scoresSnapshot() {
  const list = [];
  for (const [userId, score] of scores) {
    const p = players.get(userId);
    if (p) list.push({ userId, username: p.username, score });
  }
  return list.sort((a, b) => b.score - a.score);
}

function checkOrbCollisions() {
  for (const [orbId, orb] of orbs) {
    for (const [userId, player] of players) {
      if (!player.local) continue;
      const pr = getRadius(scores.get(userId) || 0);
      if (Math.hypot(player.x - orb.x, player.y - orb.y) > pr + ORB_RADIUS) continue;
      const newScore = (scores.get(userId) || 0) + orb.points;
      scores.set(userId, newScore);
      orbs.delete(orbId);
      broadcastToAll(JSON.stringify({
        type: 'orb_collected', orbId,
        collector: { userId, username: player.username },
        orbType: orb.type, points: orb.points, newScore,
      }));
      broadcastToPeers({ type: 'score_replicate', origin: COORDINATOR_ID, userId, score: newScore });
      setTimeout(spawnOrb, ORB_RESPAWN_MS);
      break;
    }
  }
}

//colisiones agar.io

const RESPAWN_INVINCIBILITY_MS = 3000;

function respawnPlayer(userId, player) {
  const pos = createSpawnPosition();
  player.x = pos.x; player.y = pos.y;
  player.respawnedAt = Date.now();
  scores.set(userId, 0);
}

function checkPlayerCollisions() {
  for (const [idA, pA] of players) {
    if (!pA.local) continue;
    const scoreA = scores.get(idA) || 0;
    const radA   = getRadius(scoreA);

    for (const [idB, pB] of players) {
      if (idA === idB) continue;
      if (pB.respawnedAt && (Date.now() - pB.respawnedAt) < RESPAWN_INVINCIBILITY_MS) continue;
      const scoreB = scores.get(idB) || 0;
      const radB   = getRadius(scoreB);
      if (radA <= radB * MIN_EAT_RATIO) continue;
      if (Math.hypot(pA.x - pB.x, pA.y - pB.y) > radA) continue;

      const gain = Math.max(10, Math.floor(scoreB * 0.5));
      const newScoreA = scoreA + gain;
      scores.set(idA, newScoreA);

      broadcastToAll(JSON.stringify({
        type: 'player_killed',
        killer: { userId: idA, username: pA.username },
        victim: { userId: idB, username: pB.username },
      }));
      broadcastToPeers({ type: 'kill_replicate', origin: COORDINATOR_ID,
        killerId: idA, killerUsername: pA.username, killerScore: newScoreA,
        victimId: idB, victimUsername: pB.username });
      broadcastToPeers({ type: 'score_replicate', origin: COORDINATOR_ID, userId: idA, score: newScoreA });

      if (pB.local) {
        respawnPlayer(idB, pB);
        sendJson(pB.socket, { type: 'you_died', killedBy: pA.username });
      } else {
        scores.set(idB, 0);
        pB.respawnedAt = Date.now();
      }
    }
  }
}

//sistema de chat

function addChatMessage(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_SIZE) chatHistory.shift();
}

function broadcastChatToAll(msg) { broadcastToAll(JSON.stringify({ type: 'chat', msg })); }

function handleChatMessage(userId, text) {
  const now = Date.now();
  if (now - (chatRateLimits.get(userId) || 0) < CHAT_RATE_MS) return;
  chatRateLimits.set(userId, now);
  if (typeof text !== 'string') return;
  text = text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;
  const player = players.get(userId);
  const msgId  = `${COORDINATOR_ID}-${++chatMsgCtr}`;
  const msg    = { id: msgId, userId, username: player?.username || 'Unknown', text, ts: now };
  seenChatIds.add(msgId);
  addChatMessage(msg);
  broadcastChatToAll(msg);
  broadcastToPeers({ type: 'chat_replicate', origin: COORDINATOR_ID, msg });
}

//autenticación con JWT

function verifyUpgradeToken(req) {
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Token no proporcionado');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded?.userId || !decoded?.username) throw new Error('JWT inválido');
  return { userId: decoded.userId, username: decoded.username };
}

function rejectUpgrade(socket, code = 401, msg = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

//jugadores

function upsertLocalPlayer(userId, username, socket) {
  const prev = players.get(userId);
  if (prev?.local && prev.socket !== socket && prev.socket?.readyState === WebSocket.OPEN)
    prev.socket.close(4000, 'Nueva conexión');
  const spawn = createSpawnPosition();
  players.set(userId, { x: spawn.x, y: spawn.y, intent: { x: 0, y: 0 }, extras: {}, username, socket, local: true, connectedAt: Date.now() });
  if (!scores.has(userId)) scores.set(userId, 0);
  return players.get(userId);
}

function removeLocalPlayer(userId, socket) {
  const cur = players.get(userId);
  if (!cur?.local) return;
  if (socket && cur.socket !== socket) return;
  players.delete(userId); scores.delete(userId);
}

function upsertRemotePlayer(userId, username, x, y) {
  if (players.get(userId)?.local) return;
  players.set(userId, { x: x || 0, y: y || 0, intent: { x: 0, y: 0 }, extras: {}, username, socket: null, local: false, connectedAt: Date.now() });
}

function removeRemotePlayer(userId) {
  const cur = players.get(userId);
  if (!cur || cur.local) return;
  players.delete(userId); scores.delete(userId);
}

//captura del estado del juego

function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId, x: p.x, y: p.y, intent: { ...p.intent }, extras: p.extras,
    username: p.username, connectedAt: new Date(p.connectedAt).toISOString(),
    radius: getRadius(scores.get(userId) || 0),
  }));
}

function broadcastStateToAll(now) {
  broadcastToAll(JSON.stringify({ type: 'state', t: now, players: snapshot(), orbs: orbsSnapshot(), scores: scoresSnapshot() }));
}

//servidor HTTP + WS

const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

const server       = http.createServer(app);
const wssPublic    = new WebSocketServer({ noServer: true });
const wssPeer      = new WebSocketServer({ noServer: true });
const wssSpectator = new WebSocketServer({ noServer: true });

app.get('/health', (_req, res) => res.json({
  status: 'ok', coordinatorId: COORDINATOR_ID, uptime: process.uptime(),
}));

app.get('/status', (_req, res) => res.json({
  coordinatorId: COORDINATOR_ID, localPlayers: countLocalPlayers(),
  totalPlayers: players.size, spectators: spectators.size,
  peers: Array.from(peerConnections.keys()), players: snapshot(),
  chatHistory: chatHistory.slice(-10),
}));

server.on('upgrade', (req, socket, head) => {
  try {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (path === '/connect') {
      const user = verifyUpgradeToken(req);
      wssPublic.handleUpgrade(req, socket, head, (ws) => wssPublic.emit('connection', ws, req, user));
    } else if (path === '/peer') {
      wssPeer.handleUpgrade(req, socket, head, (ws) => wssPeer.emit('connection', ws, req));
    } else if (path === '/spectate') {
      if (spectators.size >= MAX_SPECTATORS) { rejectUpgrade(socket, 503, 'Full'); return; }
      wssSpectator.handleUpgrade(req, socket, head, (ws) => wssSpectator.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  } catch (err) {
    rejectUpgrade(socket);
  }
});

//jugadores conectados

wssPublic.on('connection', (ws, _req, user) => {
  const { userId, username } = user;
  const currentPlayer = upsertLocalPlayer(userId, username, ws);
  console.log(`[+] ${username} conectado`);

  sendJson(ws, {
    type: 'welcome',
    you: { userId, username, x: currentPlayer.x, y: currentPlayer.y, intent: { ...currentPlayer.intent }, extras: { ...currentPlayer.extras }, connectedAt: new Date(currentPlayer.connectedAt).toISOString() },
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: BASE_RADIUS, tickRate: TICK_RATE },
    chatHistory: chatHistory.slice(-20),
  });

  broadcastToPeers({ type: 'player_joined', origin: COORDINATOR_ID, userId, username, x: currentPlayer.x, y: currentPlayer.y });

  ws.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const player = players.get(userId);
    if (!player?.local) return;

    if (payload.type === 'intent') {
      const candidate = payload.intent || payload.direction || payload.dir || payload;
      const next = candidate?.dir || candidate;
      const ix = sanitizeAxis(next?.x); const iy = sanitizeAxis(next?.y);
      player.intent = { x: ix, y: iy };
      broadcastToPeers({ type: 'intent_replicate', origin: COORDINATOR_ID, userId, intent: { x: ix, y: iy } });
      return;
    }

    if (isPlainObject(payload) && payload.type === 'extras_update') {
      const extras = payload.extras;
      if (!isPlainObject(extras)) return;
      const s = JSON.stringify(extras);
      if (s.length > 1024) return;
      player.extras = JSON.parse(s);
      broadcastToPeers({ type: 'extras_replicate', origin: COORDINATOR_ID, userId, extras: player.extras });
      return;
    }

    if (payload.type === 'chat_message') handleChatMessage(userId, payload.text);
  });

  ws.on('close', () => {
    console.log(`[-] ${username} desconectado`);
    removeLocalPlayer(userId, ws);
    chatRateLimits.delete(userId);
    broadcastToPeers({ type: 'player_left', origin: COORDINATOR_ID, userId });
  });

  ws.on('error', (err) => console.error(`[WS] error ${username}:`, err.message));
});

//espectadores

wssSpectator.on('connection', (ws) => {
  spectators.add(ws);
  sendJson(ws, {
    type: 'spectator_welcome',
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: BASE_RADIUS, tickRate: TICK_RATE },
    chatHistory: chatHistory.slice(-20),
  });
  ws.on('message', () => {});
  ws.on('close', () => spectators.delete(ws));
  ws.on('error', () => spectators.delete(ws));
});

//mesh entre coordinadores

function handlePeerMessage(data, senderId) {
  let msg;
  try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
  if (msg.origin === COORDINATOR_ID) return;

  switch (msg.type) {
    case 'player_joined':
      upsertRemotePlayer(msg.userId, msg.username, msg.x, msg.y); break;
    case 'player_left':
      removeRemotePlayer(msg.userId); break;
    case 'intent_replicate': {
      const p = players.get(msg.userId);
      if (p && !p.local && msg.intent) p.intent = { x: sanitizeAxis(msg.intent.x), y: sanitizeAxis(msg.intent.y) };
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
      if (typeof msg.score === 'number') scores.set(msg.userId, msg.score); break;
    case 'kill_replicate': {
      if (typeof msg.killerScore === 'number') scores.set(msg.killerId, msg.killerScore);
      broadcastToAll(JSON.stringify({
        type: 'player_killed',
        killer: { userId: msg.killerId, username: msg.killerUsername },
        victim: { userId: msg.victimId, username: msg.victimUsername },
      }));
      const victim = players.get(msg.victimId);
      if (victim?.local) {
        respawnPlayer(msg.victimId, victim);
        sendJson(victim.socket, { type: 'you_died', killedBy: msg.killerUsername || 'alguien' });
      } else if (victim) {
        scores.set(msg.victimId, 0);
        victim.respawnedAt = Date.now();
      }
      break;
    }
    case 'chat_replicate': {
      const m = msg.msg;
      if (!m?.id || seenChatIds.has(m.id)) break;
      seenChatIds.add(m.id);
      if (seenChatIds.size > 2000) {
        const it = seenChatIds.values();
        for (let i = 0; i < 500; i++) seenChatIds.delete(it.next().value);
      }
      addChatMessage(m); broadcastChatToAll(m); break;
    }
  }
}

function sendLocalPlayersToSocket(ws) {
  for (const [userId, player] of players)
    if (player.local) sendJson(ws, { type: 'player_joined', origin: COORDINATOR_ID, userId, username: player.username, x: player.x, y: player.y });
}

wssPeer.on('connection', (ws) => {
  let remoteId = null;
  ws.on('message', (data) => {
    if (!remoteId) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { ws.close(); return; }
      if (msg.type !== 'hello' || !msg.coordinatorId) { ws.close(); return; }
      remoteId = msg.coordinatorId;
      if (remoteId > COORDINATOR_ID && peerConnections.has(remoteId)) { ws.close(); return; }
      peerConnections.set(remoteId, ws);
      console.log(`[MESH] conectado: ${remoteId} (${peerConnections.size} peers)`);
      sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID });
      sendLocalPlayersToSocket(ws);
      return;
    }
    handlePeerMessage(data, remoteId);
  });
  ws.on('close', () => {
    if (remoteId && peerConnections.get(remoteId) === ws) {
      peerConnections.delete(remoteId);
      console.log(`[MESH] desconectado: ${remoteId}`);
    }
  });
  ws.on('error', () => {});
});

function connectToPeer(peerId, peerUrlStr) {
  if (peerConnections.has(peerId)) return;
  console.log(`[MESH] conectando a ${peerId}...`);
  const ws = new WebSocket(peerUrlStr);
  let done = false;
  ws.on('open', () => sendJson(ws, { type: 'hello', coordinatorId: COORDINATOR_ID }));
  ws.on('message', (data) => {
    if (!done) {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
      if (msg.type === 'hello') {
        done = true;
        peerConnections.set(peerId, ws);
        console.log(`[MESH] conectado: ${peerId} (${peerConnections.size} peers)`);
        sendLocalPlayersToSocket(ws);
      }
      return;
    }
    handlePeerMessage(data, peerId);
  });
  ws.on('close', () => { if (peerConnections.get(peerId) === ws) peerConnections.delete(peerId); });
  ws.on('error', (err) => console.error(`[MESH] error ${peerId}:`, err.message));
}

async function discoverPeers() {
  for (const authUrl of AUTH_URLS) {
    try {
      const res = await fetch(`${authUrl}/coordinator-peers`);
      if (!res.ok) {
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          if (body.leaderUrl) {
            const r2 = await fetch(`${body.leaderUrl}/coordinator-peers`).catch(() => null);
            if (r2?.ok) { _processPeers((await r2.json()).peers || []); return; }
          }
        }
        continue;
      }
      _processPeers((await res.json()).peers || []);
      return;
    } catch (_) {}
  }
}

function _processPeers(peers) {
  for (const peer of peers) {
    if (peer.coordinatorId === COORDINATOR_ID) continue;
    knownPeers.set(peer.coordinatorId, { publicUrl: peer.publicUrl, peerUrl: peer.peerUrl });
    if (!peerConnections.has(peer.coordinatorId) && COORDINATOR_ID < peer.coordinatorId)
      connectToPeer(peer.coordinatorId, peer.peerUrl);
  }
}

//latido hacia el servicio de autenticación

let _knownLeaderUrl = null;

async function sendHeartbeat() {
  const body    = JSON.stringify({ coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL, connectedPlayers: countLocalPlayers(), uptime: process.uptime() });
  const headers = { 'Content-Type': 'application/json' };
  const targets = _knownLeaderUrl ? [_knownLeaderUrl, ...AUTH_URLS.filter(u => u !== _knownLeaderUrl)] : AUTH_URLS;

  for (const authUrl of targets) {
    try {
      const res = await fetch(`${authUrl}/heartbeat`, { method: 'POST', headers, body });
      if (res.ok) { _knownLeaderUrl = authUrl; return; }
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        if (data.leaderUrl) {
          const r2 = await fetch(`${data.leaderUrl}/heartbeat`, { method: 'POST', headers, body }).catch(() => null);
          if (r2?.ok) { _knownLeaderUrl = data.leaderUrl; return; }
        }
      }
    } catch (_) {}
  }
  console.warn('[HEARTBEAT] Sin auth leader disponible');
}

//bucle principal del juego

let lastTickAt = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTickAt) / 1000;
  lastTickAt = now;

  for (const [userId, player] of players) {
    const { x: ix, y: iy } = player.intent;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      const r = getRadius(scores.get(userId) || 0);
      player.x = Math.max(r, Math.min(WORLD_WIDTH  - r, player.x + (ix / mag) * PLAYER_SPEED * dt));
      player.y = Math.max(r, Math.min(WORLD_HEIGHT - r, player.y + (iy / mag) * PLAYER_SPEED * dt));
    }
  }

  checkOrbCollisions();
  checkPlayerCollisions();
  broadcastStateToAll(now);
}

//arranque

setInterval(tick, TICK_MS);
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
setInterval(discoverPeers, PEER_DISCOVERY_INTERVAL_MS);
initOrbs();

server.listen(PORT, () => {
  console.log(`\nCOORDINADOR [${COORDINATOR_ID}] | ${PUBLIC_URL} | auth: ${AUTH_URLS.join(', ')}`);
});
