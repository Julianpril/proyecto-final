// js/lobby.js - Versión Taller 5 (canvas, movimiento, extras)
import { createGame } from './game.js';

const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
if (!token) {
    alert('No hay sesión activa');
    window.location.href = 'index.html';
}
document.getElementById('currentUser').textContent = username || 'Invitado';

const canvas = document.getElementById('gameCanvas');
let ws = null;
let game = null;
let currentState = { players: [] };
let world = null;

window.lastState = currentState;

function connect() {
    const wsUrl = `${window.APP_CONFIG.COORDINATOR_WS_URL}/connect?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => console.log('✅ Conectado al coordinador');

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'welcome') {
                world = msg.world;
                // don't set canvas pixel size directly; createGame will map world->display
                initGame(msg.you.userId);
            } else if (msg.type === 'state') {
                currentState = { players: msg.players };
                window.lastState = currentState;
            }
        } catch (err) {
            console.error('Error parseando WS', err);
        }
    };

    ws.onclose = () => {
        if (game) game.destroy();
        localStorage.clear();
        showModal('Conexión perdida', 'El servidor cerró la conexión.');
    };

    ws.onerror = (err) => {
        console.error('WS error', err);
        ws.close();
    };
}

function initGame(localPlayerId) {
    if (game) game.destroy();
    window.localPlayerId = localPlayerId;
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
            // display a larger square canvas as requested
            displayWidth: 500,
            displayHeight: 500
        } : {}
    });
    game.start();
}

function setupColorPicker() {
    const colorInput = document.getElementById('playerColor');
    if (!colorInput) return;

    colorInput.addEventListener('input', (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify({
            type: 'extras_update',
            extras: { color: event.target.value }
        }));
    });
}

// Modal (reutiliza el que tienes en lobby.html)
function showModal(title, message) {
    const modal = document.getElementById('disconnectModal');
    if (!modal) return;
    const titleEl = modal.querySelector('h3');
    const msgEl = modal.querySelector('p');
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    modal.style.display = 'flex';
    const okBtn = document.getElementById('modalOkBtn');
    if (okBtn) okBtn.onclick = () => window.location.href = 'index.html';
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    if (ws) ws.close();
    if (game) game.destroy();
    localStorage.clear();
    window.location.href = 'index.html';
});

connect();
setupColorPicker();