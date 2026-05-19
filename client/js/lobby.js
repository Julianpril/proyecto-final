// js/lobby.js
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
let currentState = { players: [], orbs: [], scores: [] };
let world = null;

window.lastState = currentState;

// Collection feed (on-screen notifications)
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
    // Remove old items
    while (feedContainer.children.length > 5) {
        feedContainer.removeChild(feedContainer.lastChild);
    }
    setTimeout(() => {
        div.classList.add('feed-item-fade');
        setTimeout(() => div.remove(), 500);
    }, 3000);
}

function connect() {
    const wsUrl = `${window.APP_CONFIG.COORDINATOR_WS_URL}/connect?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => console.log('✅ Conectado al coordinador');

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'welcome') {
                world = msg.world;
                initGame(msg.you.userId);
            } else if (msg.type === 'state') {
                currentState = {
                    players: msg.players,
                    orbs: msg.orbs || [],
                    scores: msg.scores || [],
                };
                window.lastState = currentState;
            } else if (msg.type === 'orb_collected') {
                const isSelf = msg.collector.userId === window.localPlayerId;
                showCollectionFeed(msg.collector.username, msg.orbType, msg.points, isSelf);
                // Add floating text in the game at the orb's approximate location
                // (we find the collector's position as proxy)
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
            orbRadius: world.orbRadius || 8,
            // Respetar el aspect ratio del mundo para que la velocidad
            // se vea igual en horizontal y vertical
            displayWidth: 500,
            displayHeight: Math.round(500 * world.height / world.width)
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