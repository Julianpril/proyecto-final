// Estado en memoria de jugadores conectados
// Map<userId, { username, socket, connectedAt }>
const players = new Map();

// Agrega un jugador. Si ya existe, cierra la conexión anterior
function addPlayer(userId, username, socket) {
  if (players.has(userId)) {
    const existing = players.get(userId);
    console.log(`[STORE] "${username}" ya conectado, cerrando conexión anterior.`);
    existing.socket.close(4000, 'Nueva conexión desde otro cliente');
  }

  players.set(userId, {
    username,
    socket,
    connectedAt: new Date(),
  });

  console.log(`[STORE] Jugador registrado: "${username}" (${userId}). Total: ${players.size}`);
}

// Elimina un jugador del Map
function removePlayer(userId) {
  const player = players.get(userId);
  if (player) {
    console.log(`[STORE] Desconectado: "${player.username}" (${userId}). Total: ${players.size - 1}`);
    players.delete(userId);
  }
}

// Lista de jugadores sin el socket (para enviar por broadcast)
function getPlayerList() {
  const list = [];
  for (const [userId, data] of players) {
    list.push({
      userId,
      username: data.username,
      connectedAt: data.connectedAt.toISOString(),
    });
  }
  return list;
}

// Retorna el Map completo (incluye sockets, uso interno)
function getAllPlayers() {
  return players;
}

function getPlayerCount() {
  return players.size;
}

module.exports = {
  addPlayer,
  removePlayer,
  getPlayerList,
  getAllPlayers,
  getPlayerCount,
};
