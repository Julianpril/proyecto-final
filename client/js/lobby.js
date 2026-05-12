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

function connect() {
    const wsUrl = `${window.APP_CONFIG.COORDINATOR_WS_URL}/connect?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => console.log('✅ Conectado al coordinador');

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'welcome') {
                world = msg.world;
                canvas.width = world.width;
                canvas.height = world.height;
                initGame(msg.you.userId);
            } else if (msg.type === 'state') {
                currentState = { players: msg.players };
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
        } : {}
    });
    game.start();
}

// Feature extra: cambio de color
function changeColor() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const randomColor = '#' + Math.floor(Math.random() * 16777215).toString(16);
    ws.send(JSON.stringify({
        type: 'extras_update',
        extras: { color: randomColor }
    }));
    console.log('Enviado cambio de color:', randomColor);
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

// Botones
const colorBtn = document.getElementById('colorBtn');
if (colorBtn) colorBtn.addEventListener('click', changeColor);
document.getElementById('logoutBtn').addEventListener('click', () => {
    if (ws) ws.close();
    if (game) game.destroy();
    localStorage.clear();
    window.location.href = 'index.html';
});

connect();