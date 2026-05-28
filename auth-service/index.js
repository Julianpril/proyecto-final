require('dotenv').config();

const express    = require('express');
const http       = require('http');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const { OAuth2Client } = require('google-auth-library');
const { WebSocketServer, WebSocket } = require('ws');

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

const PORT        = parseInt(process.env.PORT)      || 4000;
const PEER_PORT   = parseInt(process.env.PEER_PORT) || (PORT + 1);
const AUTH_ID     = process.env.AUTH_ID             || 'auth-a';
const PUBLIC_URL  = process.env.PUBLIC_URL          || `http://localhost:${PORT}`;
const PEER_URL    = process.env.PEER_URL            || `ws://localhost:${PEER_PORT}`;
const AUTH_PEERS_RAW = process.env.AUTH_PEERS       || '';  // comma-separated ws:// peer URLs
const DB_PATH     = process.env.DB_PATH             || 'users.db';
const JWT_SECRET  = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const HEARTBEAT_INTERVAL_MS = 2000;
const LEADER_TIMEOUT_MS     = 6000;
const BCRYPT_ROUNDS         = 10;
const COORDINATOR_TIMEOUT_MS = 6000;

// ═══════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    provider      TEXT NOT NULL CHECK(provider IN ('local','google')),
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    email         TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS write_log (
    seq        INTEGER PRIMARY KEY,
    op         TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const { maxSeq } = db.prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM write_log').get();

// ═══════════════════════════════════════════════════════════
//  AUTH MESH STATE
// ═══════════════════════════════════════════════════════════

let role               = 'replica';
let term               = 0;
let lastSeq            = maxSeq;
let leaderUrl          = null;
let leaderAuthId       = null;
let lastLeaderHb       = 0;       // timestamp of last heartbeat received
let electionInProgress = false;
let votesReceived      = 0;

const authPeers = new Map();  // authId → { authId, publicUrl, peerUrl, role, term, lastSeq, ws }

// Coordinator directory (from Taller 6) — only leader manages this
const coordinators = new Map();

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ═══════════════════════════════════════════════════════════
//  WRITE HELPERS
// ═══════════════════════════════════════════════════════════

function applyWrite(seq, op, data) {
  const run = db.transaction(() => {
    if (op === 'register') {
      try {
        db.prepare(
          `INSERT INTO users (id, username, provider, password_hash, created_at)
           VALUES (?, ?, 'local', ?, ?)`
        ).run(data.userId, data.username, data.password_hash, data.created_at);
      } catch (_) {}
    } else if (op === 'register_google') {
      try {
        db.prepare(
          `INSERT INTO users (id, username, provider, google_sub, email, created_at)
           VALUES (?, ?, 'google', ?, ?, ?)`
        ).run(data.userId, data.username, data.google_sub, data.email, data.created_at);
      } catch (_) {}
    }
    try {
      db.prepare(
        `INSERT OR IGNORE INTO write_log (seq, op, data, created_at) VALUES (?, ?, ?, ?)`
      ).run(seq, op, JSON.stringify(data), data.created_at || new Date().toISOString());
    } catch (_) {}
    if (seq > lastSeq) lastSeq = seq;
  });
  run();
}

// leaderWrite: inserts into DB, logs to write_log, propagates to replicas.
// Returns { userId, seq }. The endpoint must NOT insert separately.
function leaderWrite(op, data) {
  const seq = ++lastSeq;
  const createdAt = new Date().toISOString();
  let userId;

  if (op === 'register') {
    const result = db.prepare(
      `INSERT INTO users (username, provider, password_hash, created_at)
       VALUES (?, 'local', ?, ?)`
    ).run(data.username, data.password_hash, createdAt);
    userId = result.lastInsertRowid;
  } else if (op === 'register_google') {
    const result = db.prepare(
      `INSERT INTO users (username, provider, google_sub, email, created_at)
       VALUES (?, 'google', ?, ?, ?)`
    ).run(data.username, data.google_sub, data.email, createdAt);
    userId = result.lastInsertRowid;
  }

  const writeData = { ...data, userId, created_at: createdAt };
  db.prepare(
    `INSERT INTO write_log (seq, op, data, created_at) VALUES (?, ?, ?, ?)`
  ).run(seq, op, JSON.stringify(writeData), createdAt);

  broadcastToPeers({ type: 'write_propagate', term, seq, op, data: writeData });
  return { userId, seq };
}

// ═══════════════════════════════════════════════════════════
//  AUTH PEER MESH — WebSocket server on PEER_PORT
// ═══════════════════════════════════════════════════════════

const peerServer = new WebSocketServer({ port: PEER_PORT });

function sendToPeer(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function broadcastToPeers(msg) {
  for (const peer of authPeers.values()) {
    if (peer.ws) sendToPeer(peer.ws, msg);
  }
}

function handlePeerMsg(ws, msg) {
  switch (msg.type) {

    case 'hello': {
      const existing = authPeers.get(msg.authId) || {};
      authPeers.set(msg.authId, {
        ...existing,
        authId: msg.authId, publicUrl: msg.publicUrl, peerUrl: msg.peerUrl,
        role: msg.role || 'replica', term: msg.term || 0, lastSeq: msg.lastSeq || 0,
        ws
      });

      // Accept leader claim if their term is >= ours
      if (msg.role === 'leader' && msg.term >= term) {
        role      = 'replica';
        term      = msg.term;
        leaderUrl = msg.publicUrl;
        leaderAuthId = msg.authId;
        lastLeaderHb = Date.now();
        electionInProgress = false;
      }

      // If WE are the leader, introduce ourselves and sync if needed
      if (role === 'leader') {
        sendToPeer(ws, {
          type: 'hello', authId: AUTH_ID, role, term, lastSeq, publicUrl: PUBLIC_URL, peerUrl: PEER_URL
        });
        if (msg.lastSeq < lastSeq) {
          const entries = db.prepare(
            'SELECT seq, op, data FROM write_log WHERE seq > ? ORDER BY seq'
          ).all(msg.lastSeq).map(e => ({ seq: e.seq, op: e.op, data: JSON.parse(e.data) }));
          if (entries.length > 0) sendToPeer(ws, { type: 'sync_response', entries });
        }
      }
      break;
    }

    case 'heartbeat': {
      if (msg.term >= term) {
        role         = 'replica';
        term         = msg.term;
        leaderAuthId = msg.authId;
        const p = authPeers.get(msg.authId);
        if (p) { leaderUrl = p.publicUrl; p.lastSeq = msg.lastSeq || 0; }
        lastLeaderHb       = Date.now();
        electionInProgress = false;
        // Request sync if too far behind
        if (typeof msg.lastSeq === 'number' && msg.lastSeq > lastSeq + 20) {
          sendToPeer(ws, { type: 'request_sync', fromSeq: lastSeq });
        }
      }
      break;
    }

    case 'write_propagate': {
      if (typeof msg.seq === 'number' && msg.seq > lastSeq) {
        applyWrite(msg.seq, msg.op, msg.data);
      }
      break;
    }

    case 'request_sync': {
      if (role === 'leader') {
        const entries = db.prepare(
          'SELECT seq, op, data FROM write_log WHERE seq > ? ORDER BY seq'
        ).all(msg.fromSeq || 0).map(e => ({ seq: e.seq, op: e.op, data: JSON.parse(e.data) }));
        sendToPeer(ws, { type: 'sync_response', entries });
      }
      break;
    }

    case 'sync_response': {
      if (Array.isArray(msg.entries)) {
        for (const e of msg.entries) {
          if (e.seq > lastSeq) applyWrite(e.seq, e.op, e.data);
        }
      }
      break;
    }

    case 'election': {
      // Vote YES if candidate's term > ours, or same term and candidate < us lexicographically
      const voteGranted = (msg.term > term) ||
        (msg.term === term && (msg.lastSeq || 0) >= lastSeq && msg.candidate < AUTH_ID);
      sendToPeer(ws, {
        type: 'vote', voter: AUTH_ID, term: msg.term, voteGranted, candidate: msg.candidate
      });
      if (msg.term > term) { term = msg.term; electionInProgress = false; }
      break;
    }

    case 'vote': {
      if (electionInProgress && msg.candidate === AUTH_ID && msg.voteGranted && msg.term === term) {
        votesReceived++;
        const majority = Math.floor((authPeers.size + 1) / 2) + 1;  // total nodes / 2 + 1
        if (votesReceived + 1 >= majority) {  // +1 for self
          role         = 'leader';
          leaderUrl    = PUBLIC_URL;
          leaderAuthId = AUTH_ID;
          electionInProgress = false;
          votesReceived      = 0;
          console.log(`[ELECTION] ${AUTH_ID} became leader for term ${term}`);
          broadcastToPeers({ type: 'new_leader', leader: AUTH_ID, term, publicUrl: PUBLIC_URL });
        }
      }
      break;
    }

    case 'new_leader': {
      if (msg.term >= term) {
        role         = 'replica';
        term         = msg.term;
        leaderAuthId = msg.leader;
        const p = authPeers.get(msg.leader);
        if (p) leaderUrl = p.publicUrl;
        else if (msg.publicUrl) leaderUrl = msg.publicUrl;
        lastLeaderHb       = Date.now();
        electionInProgress = false;
      }
      break;
    }
  }
}

peerServer.on('connection', (ws) => {
  let peerId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!peerId && msg.authId) peerId = msg.authId;
      handlePeerMsg(ws, msg);
    } catch (_) {}
  });

  ws.on('close', () => {
    if (peerId) {
      const p = authPeers.get(peerId);
      if (p && p.ws === ws) p.ws = null;
    }
  });

  ws.on('error', () => {});
});

// ── Leader election ──

function startElection() {
  if (electionInProgress) return;
  electionInProgress = true;
  votesReceived      = 0;
  term++;
  leaderUrl    = null;
  leaderAuthId = null;
  console.log(`[ELECTION] ${AUTH_ID} starting election for term ${term}`);
  broadcastToPeers({ type: 'election', candidate: AUTH_ID, term, lastSeq });

  // If no majority in 3s, give up (another node may have won)
  setTimeout(() => {
    if (electionInProgress) {
      electionInProgress = false;
      votesReceived      = 0;
      console.log(`[ELECTION] ${AUTH_ID} election timed out, no majority`);
    }
  }, 3000);
}

// ── Leader heartbeat timer ──

setInterval(() => {
  if (role === 'leader') {
    broadcastToPeers({ type: 'heartbeat', authId: AUTH_ID, term, lastSeq });
  }
}, HEARTBEAT_INTERVAL_MS);

// ── Leader timeout detection (replica side) ──

setInterval(() => {
  if (role !== 'replica' || electionInProgress) return;
  if (authPeers.size === 0) return;  // no peers yet, wait
  if (Date.now() - lastLeaderHb <= LEADER_TIMEOUT_MS) return;

  // Determine who should start the election: smallest live authId
  const live = [...authPeers.values()]
    .filter(p => p.ws && p.ws.readyState === WebSocket.OPEN)
    .map(p => p.authId)
    .concat([AUTH_ID])
    .sort();

  if (live[0] === AUTH_ID) startElection();
}, 1000);

// ── Outgoing connections to auth peers ──

function connectToAuthPeer(peerUrl) {
  if (!peerUrl || peerUrl === PEER_URL) return;

  let ws;
  try { ws = new WebSocket(peerUrl); } catch (_) { return; }

  ws.on('open', () => {
    sendToPeer(ws, {
      type: 'hello', authId: AUTH_ID, role, term, lastSeq, publicUrl: PUBLIC_URL, peerUrl: PEER_URL
    });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Register peer if unknown
      if (msg.authId && !authPeers.has(msg.authId)) {
        authPeers.set(msg.authId, {
          authId: msg.authId, publicUrl: msg.publicUrl, peerUrl: msg.peerUrl,
          role: msg.role || 'replica', term: msg.term || 0, lastSeq: msg.lastSeq || 0, ws
        });
      } else if (msg.authId && authPeers.has(msg.authId)) {
        authPeers.get(msg.authId).ws = ws;
      }
      handlePeerMsg(ws, msg);
    } catch (_) {}
  });

  ws.on('close', () => {
    setTimeout(() => connectToAuthPeer(peerUrl), 5000);
  });

  ws.on('error', () => {
    setTimeout(() => connectToAuthPeer(peerUrl), 5000);
  });
}

function initAuthMesh() {
  const peers = AUTH_PEERS_RAW.split(',').map(s => s.trim()).filter(Boolean);
  for (const url of peers) {
    // Connect with a stagger to avoid simultaneous race
    const delay = 1000 + Math.random() * 1000;
    setTimeout(() => connectToAuthPeer(url), delay);
  }
}

// ── After initial connections, if no leader is detected, the smallest authId calls election ──

setTimeout(() => {
  if (role === 'replica' && !leaderAuthId) {
    const all = [...authPeers.keys(), AUTH_ID].sort();
    if (all[0] === AUTH_ID) {
      console.log(`[MESH] ${AUTH_ID} is smallest — initiating initial leader election`);
      lastLeaderHb = 0;  // force timeout
      startElection();
    }
  }
}, 4000);

// ═══════════════════════════════════════════════════════════
//  EXPRESS APP
// ═══════════════════════════════════════════════════════════

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});
app.use(express.json());

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(err.name === 'TokenExpiredError' ? 401 : 403).json({
        error: err.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido'
      });
    }
    req.user = decoded;
    next();
  });
}

// ── Guard: write requires leader ──
function requireLeader(req, res, next) {
  if (role === 'leader') return next();
  if (electionInProgress || !leaderUrl) {
    return res.status(503).json({ error: 'no_leader' });
  }
  return res.status(503).json({ error: 'not_leader', leaderUrl });
}

// ── Guard: reads allowed unless mid-election ──
function allowRead(req, res, next) {
  if (electionInProgress) return res.status(503).json({ error: 'no_leader' });
  next();
}

// ═══════════════════════════════════════════════════════════
//  TALLER 7: NEW ENDPOINTS
// ═══════════════════════════════════════════════════════════

app.get('/status', (req, res) => {
  const { count: users } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  res.json({
    authId:         AUTH_ID,
    role,
    publicUrl:      PUBLIC_URL,
    peerUrl:        PEER_URL,
    leaderUrl:      leaderUrl || PUBLIC_URL,
    knownPeers:     [...authPeers.keys()],
    lastAppliedSeq: lastSeq,
    users,
    term,
  });
});

app.get('/peers', (req, res) => {
  const peers = [...authPeers.values()].map(p => ({
    authId:    p.authId,
    publicUrl: p.publicUrl,
    peerUrl:   p.peerUrl,
    role:      p.role,
  }));
  res.json({ peers });
});

// ═══════════════════════════════════════════════════════════
//  TALLER 6: COORDINATOR DIRECTORY (leader only)
// ═══════════════════════════════════════════════════════════

app.post('/heartbeat', (req, res) => {
  if (role !== 'leader') {
    return res.status(503).json({ error: 'not_leader', leaderUrl: leaderUrl || null });
  }
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body;
  if (!coordinatorId) return res.status(400).json({ error: 'Missing coordinatorId' });
  coordinators.set(coordinatorId, {
    coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime, lastSeen: Date.now()
  });
  return res.status(200).json({ ok: true });
});

app.get('/coordinator', (req, res) => {
  if (role !== 'leader') {
    return res.status(503).json({ error: 'not_leader', leaderUrl: leaderUrl || null });
  }
  const now = Date.now();
  let best = null;
  for (const [id, data] of coordinators.entries()) {
    if (now - data.lastSeen > COORDINATOR_TIMEOUT_MS) { coordinators.delete(id); continue; }
    if (!best || data.connectedPlayers < best.connectedPlayers) best = data;
  }
  if (!best) return res.status(503).json({ error: 'no_coordinators_available' });
  return res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
});

app.get('/coordinator-peers', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [id, data] of coordinators.entries()) {
    if (now - data.lastSeen > COORDINATOR_TIMEOUT_MS) coordinators.delete(id);
    else list.push({ coordinatorId: data.coordinatorId, publicUrl: data.publicUrl, peerUrl: data.peerUrl });
  }
  res.json({ peers: list });
});

// ═══════════════════════════════════════════════════════════
//  PUBLIC CONFIG
// ═══════════════════════════════════════════════════════════

app.get('/config', (req, res) => {
  res.json({ GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID || '' });
});

// ═══════════════════════════════════════════════════════════
//  AUTH ENDPOINTS (Talleres 4 + 5, leader/replica aware)
// ═══════════════════════════════════════════════════════════

app.post('/register', requireLeader, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Usuario ya existe' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { userId } = leaderWrite('register', { username, password_hash: hash });

    return res.status(201).json({ userId, username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/login', allowRead, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });

    const user = db.prepare(
      `SELECT id, username, provider, password_hash FROM users WHERE username = ?`
    ).get(username);

    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (user.provider !== 'local') return res.status(401).json({ error: 'Este usuario debe iniciar sesión con Google' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { userId: user.id, username: user.username, provider: 'local' },
      JWT_SECRET, { expiresIn: '1h' }
    );
    return res.status(200).json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/perfil', authenticateToken, (req, res) => {
  return res.json({ message: `Hola, ${req.user.username}` });
});

app.post('/auth/google', async (req, res) => {
  if (electionInProgress) return res.status(503).json({ error: 'no_leader' });

  try {
    const { idToken, username } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken requerido' });

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (_) {
      return res.status(401).json({ error: 'invalid_id_token' });
    }

    if (!payload.email_verified) return res.status(401).json({ error: 'email_not_verified' });

    const existing = db.prepare(`SELECT * FROM users WHERE google_sub = ?`).get(payload.sub);
    if (existing) {
      const token = jwt.sign(
        { userId: existing.id, username: existing.username, provider: existing.provider },
        JWT_SECRET, { expiresIn: '1h' }
      );
      return res.status(200).json({ token, username: existing.username });
    }

    // New Google user — write required
    if (role !== 'leader') {
      if (electionInProgress || !leaderUrl) return res.status(503).json({ error: 'no_leader' });
      return res.status(503).json({ error: 'not_leader', leaderUrl });
    }

    if (!username) return res.status(409).json({ error: 'username_required', hint: 'Primer login con Google' });

    const taken = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
    if (taken) return res.status(409).json({ error: 'username_taken' });

    const { userId } = leaderWrite('register_google', {
      username, google_sub: payload.sub, email: payload.email
    });

    const token = jwt.sign(
      { userId, username, provider: 'google' },
      JWT_SECRET, { expiresIn: '1h' }
    );
    return res.status(200).json({ token, username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal' });
  }
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════

const server = http.createServer(app);

server.listen(PORT, () => {
  const bar = '═'.repeat(55);
  console.log(`\n${bar}`);
  console.log(`  AUTH [${AUTH_ID}] — ${role.toUpperCase()} — Taller 7`);
  console.log(`${bar}`);
  console.log(`  HTTP:       ${PUBLIC_URL}`);
  console.log(`  Peer mesh:  ws://localhost:${PEER_PORT}`);
  console.log(`  Auth peers: ${AUTH_PEERS_RAW || '(ninguno)'}`);
  console.log(`  DB:         ${DB_PATH}`);
  console.log(`${bar}\n`);

  initAuthMesh();
});
