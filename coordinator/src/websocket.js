// Servidor WebSocket con autenticación JWT
const { WebSocketServer } = require('ws');
const { verifyUpgradeToken } = require('./auth');
const { addPlayer, removePlayer } = require('./playerStore');
const { broadcastPlayerList } = require('./broadcast');

// Inicializa el WebSocket y lo adjunta al servidor HTTP
function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Interceptar upgrade: validar JWT antes de aceptar la conexión
  server.on('upgrade', (req, socket, head) => {
    console.log(`[WS] Upgrade recibido desde ${req.socket.remoteAddress}`);

    try {
      const user = verifyUpgradeToken(req);
      console.log(`[WS] Token válido: "${user.username}" (${user.userId})`);

      // Token ok → completar handshake
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, user);
      });
    } catch (error) {
      console.error(`[WS] Auth fallida: ${error.message}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  // Manejar conexiones ya autenticadas
  wss.on('connection', (ws, req, user) => {
    const { userId, username } = user;
    console.log(`[WS] Conectado: "${username}" (${userId})`);

    // Registrar jugador (cierra conexión previa si existe)
    addPlayer(userId, username, ws);

    // Mensaje de bienvenida
    ws.send(JSON.stringify({
      type: 'welcome',
      message: `Bienvenido al servidor, ${username}!`,
      userId,
      username,
      timestamp: new Date().toISOString(),
    }));

    // Notificar a todos la nueva lista
    broadcastPlayerList();

    // Desconexión: limpiar y notificar
    ws.on('close', (code, reason) => {
      console.log(`[WS] Desconectado: "${username}" (${userId}) — Código: ${code}`);
      removePlayer(userId);
      broadcastPlayerList();
    });

    ws.on('error', (error) => {
      console.error(`[WS] Error de "${username}":`, error.message);
    });

    ws.on('message', (data) => {
      console.log(`[WS] Mensaje de "${username}": ${data}`);
    });
  });

  console.log('[WS] WebSocket inicializado (noServer)');
  return wss;
}

module.exports = { setupWebSocket };
