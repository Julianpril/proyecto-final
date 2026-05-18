require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const db = new Database('users.db');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const BCRYPT_ROUNDS = 10;

// Permitir cualquier origen (necesario con ngrok)
app.use(cors({
  origin: true,
  credentials: true
}));

// Fix para Google Sign-In con ngrok:
// el popup de Google necesita postMessage de vuelta a la ventana padre,
// pero ngrok agrega COOP: same-origin por defecto y lo bloquea.
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

app.use(express.json());

// Public config endpoint (safe to expose non-secret client IDs)
app.get('/config', (req, res) => {
  return res.json({
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || ''
  });
});

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('local','google')),
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  email TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);

// Middleware para verificar token
function authenticateToken(req, res, next) {

  const authHeader = req.headers['authorization'];

  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Token requerido'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {

    if (err) {

      if (err.name === 'TokenExpiredError') {

        return res.status(401).json({
          error: 'Token expirado'
        });
      }

      return res.status(403).json({
        error: 'Token inválido'
      });
    }

    req.user = decoded;

    next();
  });
}


// REGISTER LOCAL

app.post('/register', async (req, res) => {

  try {

    const { username, password } = req.body;

    if (!username || !password) {

      return res.status(400).json({
        error: 'Faltan datos'
      });
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);

    if (existing) {

      return res.status(409).json({
        error: 'Usuario ya existe'
      });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = db
      .prepare(`
        INSERT INTO users (
          username,
          provider,
          password_hash
        )
        VALUES (?, 'local', ?)
      `)
      .run(username, hash);

    return res.status(201).json({
      userId: result.lastInsertRowid,
      username
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});


// LOGIN LOCAL

app.post('/login', async (req, res) => {

  try {

    const { username, password } = req.body;

    if (!username || !password) {

      return res.status(400).json({
        error: 'Faltan datos'
      });
    }

    const user = db
      .prepare(`
        SELECT
          id,
          username,
          provider,
          password_hash
        FROM users
        WHERE username = ?
      `)
      .get(username);

    if (!user) {

      return res.status(401).json({
        error: 'Credenciales inválidas'
      });
    }

    if (user.provider !== 'local') {

      return res.status(401).json({
        error: 'Este usuario debe iniciar sesión con Google'
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {

      return res.status(401).json({
        error: 'Credenciales inválidas'
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        provider: 'local'
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    return res.status(200).json({
      token,
      username: user.username
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// PERFIL PROTEGIDO

app.get('/perfil', authenticateToken, (req, res) => {

  return res.json({
    message: `Hola, ${req.user.username}`
  });
});


// Login con Google
app.post('/auth/google', async (req, res) => {

  try {

    const { idToken, username } = req.body;

    if (!idToken) {

      return res.status(400).json({
        error: 'idToken requerido'
      });
    }

    let payload;

    // Verificar que el token sea real con Google
    try {

      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID // que sea para nuestra app
      });

      payload = ticket.getPayload();

    } catch (err) {
      // Token falso o expirado
      return res.status(401).json({
        error: 'invalid_id_token'
      });
    }

    // Solo aceptar cuentas con email verificado
    if (!payload.email_verified) {

      return res.status(401).json({
        error: 'email_not_verified'
      });
    }

    const googleSub = payload.sub;

    const email = payload.email;

    const existing = db
      .prepare(`
        SELECT *
        FROM users
        WHERE google_sub = ?
      `)
      .get(googleSub);

    // Usuario Google ya existe
    if (existing) {

      const token = jwt.sign(
        {
          userId: existing.id,
          username: existing.username,
          provider: existing.provider
        },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      return res.status(200).json({
        token,
        username: existing.username
      });
    }

    // Si nunca ha entrado con Google, pedirle un nombre de usuario
    if (!username) {

      return res.status(409).json({
        error: 'username_required',
        hint: 'Primer login con Google'
      });
    }

    const usernameTaken = db
      .prepare(`
        SELECT id
        FROM users
        WHERE username = ?
      `)
      .get(username);

    if (usernameTaken) {

      return res.status(409).json({
        error: 'username_taken'
      });
    }

    const result = db
      .prepare(`
        INSERT INTO users (
          username,
          provider,
          google_sub,
          email
        )
        VALUES (?, 'google', ?, ?)
      `)
      .run(username, googleSub, email);

    const token = jwt.sign(
      {
        userId: result.lastInsertRowid,
        username,
        provider: 'google'
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    return res.status(200).json({
      token,
      username
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: 'internal'
    });
  }
});

// ════════════════════════════════════════════════════════════════
// MESH P2P DIRECTORY SERVICE (Fase 3)
// ════════════════════════════════════════════════════════════════

// Map<coordinatorId, { publicUrl, peerUrl, connectedPlayers, uptime, lastSeen }>
const coordinators = new Map();
const HEARTBEAT_TIMEOUT_MS = 6000;

app.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body;
  if (!coordinatorId) return res.status(400).json({ error: 'Missing coordinatorId' });

  coordinators.set(coordinatorId, {
    coordinatorId,
    publicUrl,
    peerUrl,
    connectedPlayers,
    uptime,
    lastSeen: Date.now()
  });

  return res.status(200).json({ ok: true });
});

app.get('/coordinator', (req, res) => {
  const now = Date.now();
  let bestCoord = null;

  for (const [id, data] of coordinators.entries()) {
    if (now - data.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      coordinators.delete(id);
      continue;
    }
    if (!bestCoord || data.connectedPlayers < bestCoord.connectedPlayers) {
      bestCoord = data;
    }
  }

  if (!bestCoord) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }

  return res.json({
    coordinatorId: bestCoord.coordinatorId,
    publicUrl: bestCoord.publicUrl
  });
});

app.get('/peers', (req, res) => {
  const now = Date.now();
  const peers = [];

  for (const [id, data] of coordinators.entries()) {
    if (now - data.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      coordinators.delete(id);
    } else {
      peers.push({
        coordinatorId: data.coordinatorId,
        publicUrl: data.publicUrl,
        peerUrl: data.peerUrl
      });
    }
  }

  return res.json({ peers });
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});