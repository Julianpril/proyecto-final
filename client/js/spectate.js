// js/spectate.js — Modo espectador (Track 2.5)
import { createGame } from './game.js';

const canvas       = document.getElementById('gameCanvas');
const chatMessages = document.getElementById('chatMessages');
const eventFeed    = document.getElementById('eventFeed');
const statusBar    = document.getElementById('statusBar');

let ws           = null;
let game         = null;
let currentState = { players: [], orbs: [], scores: [] };

// ═══════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ═══════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function addChatMessage(msg) {
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const time = new Date(msg.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<span class="chat-username">${escapeHtml(msg.username)}</span>: ${escapeHtml(msg.text)} <span class="chat-timestamp">${time}</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    while (chatMessages.children.length > 100) chatMessages.removeChild(chatMessages.firstChild);
}

function showEvent(html, color, isKill = false) {
    if (!eventFeed) return;
    const div = document.createElement('div');
    div.className = 'feed-item' + (isKill ? ' kill-msg' : '');
    div.style.color = color;
    div.innerHTML = html;
    eventFeed.prepend(div);
    while (eventFeed.children.length > 6) eventFeed.removeChild(eventFeed.lastChild);
    setTimeout(() => {
        div.classList.add('feed-item-fade');
        setTimeout(() => div.remove(), 500);
    }, 4000);
}

// ═══════════════════════════════════════════════════════════════════════
//  CONEXIÓN COMO ESPECTADOR
// ═══════════════════════════════════════════════════════════════════════

async function getCoordinator() {
    const urls = (window.APP_CONFIG.AUTH_URLS && window.APP_CONFIG.AUTH_URLS.length)
        ? window.APP_CONFIG.AUTH_URLS
        : [window.APP_CONFIG.AUTH_API_URL || 'http://localhost:4000'];
    for (const base of urls) {
        try {
            const res = await fetch(`${base}/coordinator`);
            if (res.ok) return res.json();
            if (res.status === 503) {
                const body = await res.json().catch(() => ({}));
                if (body.leaderUrl) {
                    const r2 = await fetch(`${body.leaderUrl}/coordinator`).catch(() => null);
                    if (r2 && r2.ok) return r2.json();
                }
            }
        } catch (_) {}
    }
    throw new Error('No hay coordinadores disponibles');
}

async function connect() {
    try {
        const data = await getCoordinator();

        // Conectar a /spectate en lugar de /connect (sin token)
        const wsUrl = `${data.publicUrl}/spectate`;
        console.log(`👁️ Espectando ${data.coordinatorId} en ${wsUrl}`);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            if (statusBar) statusBar.textContent = `👁️ Espectando ${data.coordinatorId}`;
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === 'spectator_welcome') {
                    if (Array.isArray(msg.chatHistory)) {
                        msg.chatHistory.forEach(m => addChatMessage(m));
                    }
                    initGame(msg.world);

                } else if (msg.type === 'state') {
                    currentState = {
                        players: msg.players || [],
                        orbs:    msg.orbs    || [],
                        scores:  msg.scores  || [],
                    };

                } else if (msg.type === 'chat') {
                    addChatMessage(msg.msg);

                } else if (msg.type === 'orb_collected') {
                    const emojis = { gold: '⭐', diamond: '💎', ruby: '💠' };
                    const colors = { gold: '#FFD700', diamond: '#00FFFF', ruby: '#FF3366' };
                    showEvent(
                        `${emojis[msg.orbType] || '⭐'} <strong>${escapeHtml(msg.collector.username)}</strong> +${msg.points}`,
                        colors[msg.orbType] || '#fff'
                    );

                } else if (msg.type === 'player_killed') {
                    showEvent(
                        `💀 <strong>${escapeHtml(msg.killer.username)}</strong> comió a ${escapeHtml(msg.victim.username)}`,
                        '#ff4488',
                        true
                    );
                }

            } catch (err) {
                console.error('Error parseando WS:', err);
            }
        };

        ws.onclose = () => {
            if (statusBar) statusBar.textContent = 'Desconectado del servidor';
            if (game) game.destroy();
        };

        ws.onerror = (err) => {
            console.error('WS error:', err);
            if (statusBar) statusBar.textContent = 'Error de conexión';
        };

    } catch (err) {
        console.error('Error al conectar:', err);
        if (statusBar) statusBar.textContent = 'Error: no hay coordinadores disponibles';
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  INICIALIZACIÓN DEL CANVAS
// ═══════════════════════════════════════════════════════════════════════

function initGame(world) {
    if (game) game.destroy();
    game = createGame({
        canvas,
        onIntent: () => {},      // Espectadores no envían intents
        getRenderState: () => currentState,
        localPlayerId: null,     // Sin jugador local
        options: world ? {
            worldWidth:    world.width,
            worldHeight:   world.height,
            playerRadius:  world.playerRadius,
            orbRadius:     8,
            displayWidth:  500,
            displayHeight: Math.round(500 * world.height / world.width),
        } : {},
    });
    game.start();
}

connect();
