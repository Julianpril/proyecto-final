    // js/lobby.js
    import { createGame } from './game.js';

    const token    = localStorage.getItem('token');
    const username = localStorage.getItem('username');
    if (!token) {
        alert('No hay sesión activa');
        window.location.href = 'index.html';
    }
    document.getElementById('currentUser').textContent = username || 'Invitado';

    const canvas        = document.getElementById('gameCanvas');
    const chatMessages  = document.getElementById('chatMessages');
    const chatInput     = document.getElementById('chatInput');
    const chatSendBtn   = document.getElementById('chatSendBtn');

    let ws           = null;
    let game         = null;
    let currentState = { players: [], orbs: [], scores: [] };
    let world        = null;

    window.lastState = currentState;

    // registro de colecciones (orbes y eliminaciones)

    const feedContainer = document.getElementById('collectFeed');

    function showFeed(html, color, isKill = false) {
        if (!feedContainer) return;
        const div = document.createElement('div');
        div.className = 'feed-item' + (isKill ? ' kill-msg' : '');
        div.style.color = color;
        div.innerHTML = html;
        feedContainer.prepend(div);
        while (feedContainer.children.length > 6) feedContainer.removeChild(feedContainer.lastChild);
        setTimeout(() => {
            div.classList.add('feed-item-fade');
            setTimeout(() => div.remove(), 500);
        }, 4000);
    }

    function showCollectionFeed(collectorName, orbType, points, isSelf) {
        const emojis  = { gold: '⭐', diamond: '💎', ruby: '💠' };
        const colors  = { gold: '#FFD700', diamond: '#00FFFF', ruby: '#FF3366' };
        showFeed(
            `${emojis[orbType] || '⭐'} <strong>${isSelf ? '¡Tú' : collectorName}</strong> ${isSelf ? 'recogiste' : 'recogió'} +${points}`,
            colors[orbType] || '#fff'
        );
    }

    function showKillFeed(killerName, victimName, isSelfKiller, isSelfVictim) {
        let text;
        if (isSelfVictim) {
            text = `💀 <strong>Fuiste comido</strong> por ${killerName}`;
        } else if (isSelfKiller) {
            text = `🍽️ <strong>¡Comiste</strong> a ${victimName}!`;
        } else {
            text = `💀 ${killerName} comió a ${victimName}`;
        }
        showFeed(text, '#ff4488', true);
    }

    // sistema de chat

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
        const div  = document.createElement('div');
        div.className = 'chat-msg';
        const time = new Date(msg.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `<span class="chat-username">${escapeHtml(msg.username)}</span>: ${escapeHtml(msg.text)} <span class="chat-timestamp">${time}</span>`;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        // Mantener máx 100 mensajes en DOM
        while (chatMessages.children.length > 100) chatMessages.removeChild(chatMessages.firstChild);
    }

    function sendChatMessage() {
        const text = chatInput ? chatInput.value.trim() : '';
        if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'chat_message', text }));
        chatInput.value = '';
    }

    if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);

    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
            // Evitar que las teclas de movimiento lleguen al juego mientras escribe
            e.stopPropagation();
        });
    }

    // conexión al coordinador

    // Header requerido por ngrok para saltar su página de advertencia
    const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

    async function authFetch(url) {
        return fetch(url, { headers: NGROK_HEADERS });
    }

    async function getCoordinator() {
        const urls = (window.APP_CONFIG.AUTH_URLS && window.APP_CONFIG.AUTH_URLS.length)
            ? window.APP_CONFIG.AUTH_URLS
            : [window.APP_CONFIG.AUTH_API_URL || 'http://localhost:4000'];
        for (const base of urls) {
            try {
                const res = await authFetch(`${base}/coordinator`);
                if (res.ok) { const d = await res.json(); d._authUrl = base; return d; }
                if (res.status === 503) {
                    const body = await res.json().catch(() => ({}));
                    if (body.leaderUrl) {
                        const r2 = await authFetch(`${body.leaderUrl}/coordinator`).catch(() => null);
                        if (r2 && r2.ok) {
                            const d = await r2.json();
                            d._authUrl = body.leaderUrl;
                            return d;
                        }
                    }
                }
            } catch (_) {}
        }
        throw new Error('No hay coordinadores disponibles');
    }

    async function updateInfraStatus(coordId, authUrl) {
        const coordEl = document.getElementById('infraCoord');
        const authEl  = document.getElementById('infraAuth');
        if (coordEl) coordEl.textContent = `⚙️ ${coordId}`;
        if (authEl)  authEl.textContent  = `🔐 ${authUrl} …`;
        // Obtiene el /status del auth para mostrar el rol del nodo
        try {
            const res = await authFetch(`${authUrl}/status`);
            if (res.ok) {
                const s = await res.json();
                const roleColor = s.role === 'leader' ? '#0f0' : '#fa0';
                if (authEl) authEl.innerHTML =
                    `🔐 <span style="color:${roleColor};font-weight:700">${s.authId}</span>`+
                    `<span style="color:rgba(255,255,255,.45);font-size:10px"> (${s.role})</span>`;
            }
        } catch (_) {}
    }

    async function connect() {
        try {
            const data = await getCoordinator();

            console.log(`🔌 Conectando a ${data.coordinatorId} en ${data.publicUrl}`);
            ws = new WebSocket(`${data.publicUrl}/connect?token=${encodeURIComponent(token)}`);

            ws.onopen = () => {
                console.log(`✅ Conectado al ${data.coordinatorId}`);
                updateInfraStatus(data.coordinatorId, data._authUrl || window.APP_CONFIG.AUTH_URLS[0]);
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);

                    if (msg.type === 'welcome') {
                        reconnectAttempts = 0;  // conexión exitosa, resetear backoff
                        world = msg.world;
                        initGame(msg.you.userId);
                        // Cargar historial de chat
                        if (Array.isArray(msg.chatHistory)) {
                            msg.chatHistory.forEach(m => addChatMessage(m));
                        }

                    } else if (msg.type === 'state') {
                        currentState = {
                            players: msg.players || [],
                            orbs:    msg.orbs    || [],
                            scores:  msg.scores  || [],
                        };
                        window.lastState = currentState;

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

                    } else if (msg.type === 'chat') {
                        addChatMessage(msg.msg);

                    } else if (msg.type === 'player_killed') {
                        const isSelfKiller = msg.killer.userId === window.localPlayerId;
                        const isSelfVictim = msg.victim.userId === window.localPlayerId;
                        showKillFeed(msg.killer.username, msg.victim.username, isSelfKiller, isSelfVictim);
                        if (isSelfKiller && game && game.addFloatingText) {
                            const killer = currentState.players.find(p => p.userId === msg.killer.userId);
                            if (killer) game.addFloatingText(killer.x, killer.y, '¡NOM!', '#ff4488');
                        }

                    } else if (msg.type === 'you_died') {
                        // El feed de kills ya muestra "Fuiste comido por X".
                        // Solo hacemos flash visual en el canvas.
                        if (game && game.addFloatingText) {
                            const me = currentState.players.find(p => p.userId === window.localPlayerId);
                            if (me) game.addFloatingText(me.x, me.y, '💀 COMIDO', '#ff2255');
                        }
                    }

                } catch (err) {
                    console.error('Error parseando WS', err);
                }
            };

            ws.onclose = () => {
                if (game) { game.destroy(); game = null; }
                showReconnecting();
                scheduleReconnect();
            };

            ws.onerror = () => ws.close();

        } catch (err) {
            console.error('Error al conectar:', err);
            showReconnecting();
            scheduleReconnect();
        }
    }

    // reconexión automática si se cae el coordinador

    let reconnectAttempts = 0;
    const MAX_RECONNECT   = 10;
    let   reconnectTimer  = null;

    function showReconnecting() {
        const infraCoord = document.getElementById('infraCoord');
        const infraAuth  = document.getElementById('infraAuth');
        if (infraCoord) infraCoord.textContent = '⚙️ reconectando…';
        if (infraAuth)  infraAuth.textContent  = '';
        console.warn(`[WS] Desconectado. Reintentando (${reconnectAttempts + 1}/${MAX_RECONNECT})…`);
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        if (reconnectAttempts >= MAX_RECONNECT) {
            showModal('Sin coordinadores', 'No se pudo reconectar a ningún servidor. Vuelve a iniciar sesión.');
            return;
        }
        const delay = Math.min(1000 * (reconnectAttempts + 1), 8000); // backoff: 1s, 2s, 3s… máx 8s
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            reconnectAttempts++;
            connect();
        }, delay);
    }



    // inicialización del juego

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
            options: world ? (() => {
                // Canvas adaptable: ocupa el ancho disponible menos el panel de chat y márgenes
                const chatW   = window.innerWidth < 820 ? 0 : 240;
                const padding = window.innerWidth < 820 ? 16 : 36;
                const maxW    = Math.min(560, window.innerWidth - chatW - padding);
                const dw      = Math.max(280, maxW);
                const dh      = Math.round(dw * world.height / world.width);
                return {
                    worldWidth:   world.width,
                    worldHeight:  world.height,
                    playerRadius: world.playerRadius,
                    orbRadius:    world.orbRadius || 8,
                    displayWidth: dw,
                    displayHeight: dh,
                };
            })() : {},
        });
        game.start();

        // Igualamos la altura del panel de chat con la del canvas para un diseño limpio
        requestAnimationFrame(() => {
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel && canvas.offsetHeight > 0) {
                chatPanel.style.height = canvas.offsetHeight + 'px';
            }
        });
    }

    // controles del jugador

    function setupColorPicker() {
        const colorInput = document.getElementById('playerColor');
        if (!colorInput) return;
        colorInput.addEventListener('input', (e) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ type: 'extras_update', extras: { color: e.target.value } }));
        });
    }

    function showModal(title, message) {
        const modal = document.getElementById('disconnectModal');
        if (!modal) return;
        const titleEl = document.getElementById('modalTitle');
        const msgEl   = document.getElementById('modalMsg');
        if (titleEl) titleEl.textContent = title;
        if (msgEl)   msgEl.textContent   = message;
        modal.style.display = 'flex';
        const okBtn = document.getElementById('modalOkBtn');
        if (okBtn) okBtn.onclick = () => {
            modal.style.display = 'none';
            // Si fue muerte, no salir al login — solo cerrar el modal
            // Si fue desconexión, ir al login
            if (title.includes('Conexión') || title.includes('Error')) {
                window.location.href = 'index.html';
            }
        };
    }

    document.getElementById('logoutBtn').addEventListener('click', () => {
        if (ws) ws.close();
        if (game) game.destroy();
        localStorage.clear();
        window.location.href = 'index.html';
    });

    connect();
    setupColorPicker();
