// js/lobby.js - Versión Taller 6 (con GET /coordinator, reconexión, orbes, color picker)
import { createGame } from './game.js';

const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
if (!token) {
    alert('No hay sesión activa');
    window.location.href = 'index.html';
}
document.getElementById('currentUser').textContent = username || 'Invitado';

// Elementos de la UI para el coordinador y tick rate
const coordinatorSpan = document.getElementById('coordinatorId');
const tickRateSpan = document.getElementById('tickRate');

const canvas = document.getElementById('gameCanvas');
let ws = null;
let game = null;
let currentState = { players: [], orbs: [], scores: [] };
let world = null;
let currentCoordinatorId = null;

// Variable auxiliar para evitar reconexión si el usuario cerró sesión manualmente
let manualLogout = false;

// ---------- Helper: obtener coordinador desde auth ----------
async function fetchCoordinator() {
    const authUrl = window.APP_CONFIG.AUTH_API_URL;
    try {
        // Añadimos el parámetro ngrok-skip-browser-warning por si usas ngrok
        const res = await fetch(`${authUrl}/coordinator?ngrok-skip-browser-warning=true`);
        if (res.status === 200) {
            const data = await res.json();
            return { coordinatorId: data.coordinatorId, publicUrl: data.publicUrl };
        } else if (res.status === 503) {
            throw new Error('No hay coordinadores disponibles');
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        console.error('Error obteniendo coordinador:', err);
        throw err;
    }
}

// ---------- Inicializar el juego y el canvas ----------
function initGame(localPlayerId) {
    if (game) game.destroy();
    game = createGame({
        canvas,
        onIntent: (intent) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'intent', intent }));
            }
        },
        getRenderState: () => currentState,
        localPlayerId,
        options: world ? {
            worldWidth: world.width,
            worldHeight: world.height,
            playerRadius: world.playerRadius,
            orbRadius: world.orbRadius || 8,
            displayWidth: 500,
            displayHeight: 500
        } : {}
    });
    game.start();
}

// ---------- Colección de orbes (feed) ----------
const feedContainer = document.getElementById('collectFeed');
function showCollectionFeed(collectorName, orbType, points, isSelf) {
    if (!feedContainer) return;
    const emojis = { gold: '⭐', diamond: '💎', ruby: '💠' };
    const colors = { gold: '#FFD700', diamond: '#00FFFF', ruby: '#FF3366' };
    const div = document.createElement('div');
    div.className = 'feed-item';
    div.style.color = colors[orbType] || '#fff';
    div.innerHTML = `${emojis[orbType] || '⭐'} <strong>${isSelf ? '¡Tú' : collectorName}</strong> ${isSelf ? 'recogiste' : 'recogió'} +${points}`;
    feedContainer.prepend(div);
    while (feedContainer.children.length > 5) {
        feedContainer.removeChild(feedContainer.lastChild);
    }
    setTimeout(() => {
        div.classList.add('feed-item-fade');
        setTimeout(() => div.remove(), 500);
    }, 3000);
}

// ---------- WebSocket con reconexión ----------
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function connectToCoordinator() {
    if (manualLogout) return;

    try {
        // 1. Pedir coordinador al auth
        const { coordinatorId, publicUrl } = await fetchCoordinator();
        currentCoordinatorId = coordinatorId;
        coordinatorSpan.textContent = coordinatorId;

        // 2. Conectar WebSocket
        const wsUrl = `${publicUrl}/connect?token=${encodeURIComponent(token)}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log(`✅ Conectado a coordinador ${coordinatorId} en ${publicUrl}`);
            reconnectAttempts = 0; // reiniciar contador
            // Ocultar modal si estaba visible
            const modal = document.getElementById('disconnectModal');
            if (modal) modal.style.display = 'none';
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'welcome') {
                    world = msg.world;
                    canvas.width = world.width;
                    canvas.height = world.height;
                    if (tickRateSpan) tickRateSpan.textContent = world.tickRate || 20;
                    initGame(msg.you.userId);
                } else if (msg.type === 'state') {
                    currentState = {
                        players: msg.players,
                        orbs: msg.orbs || [],
                        scores: msg.scores || [],
                    };
                } else if (msg.type === 'orb_collected') {
                    const isSelf = msg.collector.userId === window.localPlayerId;
                    showCollectionFeed(msg.collector.username, msg.orbType, msg.points, isSelf);
                    if (game && game.addFloatingText) {
                        const player = currentState.players.find(p => p.userId === msg.collector.userId);
                        if (player) {
                            const colors = { gold: '#FFD700', diamond: '#00FFFF', ruby: '#FF3366' };
                            game.addFloatingText(player.x, player.y, `+${msg.points}`, colors[msg.orbType] || '#FFD700');
                        }
                    }
                }
            } catch (err) {
                console.error('Error parseando WS', err);
            }
        };

        ws.onclose = (event) => {
            console.log(`WebSocket cerrado (código ${event.code})`);
            if (game) game.destroy();

            if (!manualLogout && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                console.log(`Reintentando conexión (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                coordinatorSpan.textContent = `Reconectando... (${reconnectAttempts})`;
                setTimeout(connectToCoordinator, 2000);
            } else if (!manualLogout) {
                // Agotamos los reintentos: mostramos modal y redirigimos
                const modal = document.getElementById('disconnectModal');
                if (modal) modal.style.display = 'flex';
                else alert('No se pudo reconectar. Redirigiendo...');
                localStorage.clear();
                setTimeout(() => { window.location.href = 'index.html'; }, 3000);
            }
        };

        ws.onerror = (err) => {
            console.error('WS error', err);
            ws.close(); // esto disparará onclose
        };
    } catch (err) {
        console.error('Fallo al obtener coordinador:', err);
        if (!manualLogout && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`Error obteniendo coordinador, reintento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
            coordinatorSpan.textContent = `Error: reintentando...`;
            setTimeout(connectToCoordinator, 2000);
        } else if (!manualLogout) {
            alert('No se pudo contactar al servidor de autenticación. Redirigiendo...');
            localStorage.clear();
            window.location.href = 'index.html';
        }
    }
}

// ---------- Color picker (feature extra) ----------
function setupColorPicker() {
    const colorInput = document.getElementById('playerColor');
    if (!colorInput) return;
    colorInput.addEventListener('input', (event) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'extras_update',
                extras: { color: event.target.value }
            }));
        }
    });
}

// ---------- Cerrar sesión (sin reconectar) ----------
function logout() {
    manualLogout = true;
    if (ws) {
        ws.onclose = null; // evitar reconexión
        ws.close();
    }
    if (game) game.destroy();
    localStorage.clear();
    window.location.href = 'index.html';
}

// ---------- Eventos ----------
document.getElementById('logoutBtn').addEventListener('click', logout);
const modalOkBtn = document.getElementById('modalOkBtn');
if (modalOkBtn) modalOkBtn.onclick = logout;

// Iniciar todo
setupColorPicker();
connectToCoordinator();