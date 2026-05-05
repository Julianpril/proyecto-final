require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const db = new Database('users.db');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 10;

app.use(cors());
app.use(express.json());

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);

    if (existing) {
      return res.status(409).json({ error: 'Usuario ya existe' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash);

    return res.status(201).json({
      userId: result.lastInsertRowid,
      username
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const user = db
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username);

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    return res.status(200).json({
      token,
      username: user.username
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});

