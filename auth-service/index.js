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

app.use(cors());
app.use(express.json());

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


// GOOGLE AUTH

app.post('/auth/google', async (req, res) => {

  try {

    const { idToken, username } = req.body;

    if (!idToken) {

      return res.status(400).json({
        error: 'idToken requerido'
      });
    }

    let payload;

    try {

      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID
      });

      payload = ticket.getPayload();

    } catch (err) {

      return res.status(401).json({
        error: 'invalid_id_token'
      });
    }

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

    // Primer login Google
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


app.listen(PORT, () => {

  console.log(`Servidor en http://localhost:${PORT}`);
});