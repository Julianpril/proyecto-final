// Broadcast de la lista de jugadores a todos los clientes
const WebSocket = require('ws');
const { getPlayerList, getAllPlayers } = require('./playerStore');

// Envía la lista actualizada a todos los sockets abiertos
function broadcastPlayerList() {
  const playerList = getPlayerList();
  const allPlayers = getAllPlayers();

  const message = JSON.stringify({
    type: 'players_update',
    players: playerList,
    totalPlayers: playerList.length,
    timestamp: new Date().toISOString(),
  });

  let sent = 0;

  for (const [userId, { socket }] of allPlayers) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
      sent++;
    }
  }

  console.log(`[BROADCAST] Enviado a ${sent}/${allPlayers.size} clientes.`);
}

module.exports = { broadcastPlayerList };
