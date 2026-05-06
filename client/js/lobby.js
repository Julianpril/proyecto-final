// js/lobby.js - Lógica del lobby y conexión WebSocket
(function () {
    const token = localStorage.getItem('token');
    const username = localStorage.getItem('username');

    // Verificar sesión activa
    if (!token) {
        showModal('Sin Sesión', 'No hay sesión activa. Redirigiendo al login...');
        return;
    }

    document.getElementById('currentUser').textContent = username || 'Invitado';

    const WS_URL = window.APP_CONFIG.COORDINATOR_WS_URL;
    let ws = null;

    // --- Conexión WebSocket ---
    function connectWebSocket() {
        const wsUrl = `${WS_URL}/connect?token=${encodeURIComponent(token)}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket conectado al coordinador');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'players_update') {
                    renderPlayers(msg.players);
                }
            } catch (err) {
                console.error('Error parseando mensaje WS:', err);
            }
        };

        ws.onclose = (event) => {
            console.log(`WebSocket cerrado: código ${event.code} - ${event.reason}`);
            localStorage.removeItem('token');
            localStorage.removeItem('username');

            showModal('Conexión Perdida', 'Se ha perdido la conexión con el servidor. El token es inválido o el servidor está inactivo.');
        };

        ws.onerror = (error) => {
            console.error('Error en WebSocket:', error);
            ws.close();
        };
    }

    // --- Renderizar jugadores ---
    function renderPlayers(players) {
        const listEl = document.getElementById('playersList');
        if (!players || players.length === 0) {
            listEl.innerHTML = '<li>No hay jugadores en línea</li>';
            return;
        }
        listEl.innerHTML = players.map(p => `
            <li>
                ${escapeHtml(p.username)} 
                <span style="margin-left: auto; font-size: 0.75rem; color: #0ff;">ID: ${p.userId}</span>
            </li>
        `).join('');
    }

    // --- Escapar HTML para prevenir XSS ---
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function (m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    // --- Modal de desconexión ---
    function showModal(title, message) {
        const modal = document.getElementById('disconnectModal');
        const modalTitle = modal.querySelector('h3');
        const modalMsg = modal.querySelector('p');
        modalTitle.textContent = title;
        modalMsg.textContent = message;
        modal.style.display = 'flex';
    }

    // --- Botón del modal ---
    const modalOkBtn = document.getElementById('modalOkBtn');
    if (modalOkBtn) {
        modalOkBtn.addEventListener('click', () => {
            window.location.href = 'index.html';
        });
    }

    // --- Cerrar sesión ---
    const logoutBtn = document.getElementById('logoutBtn');
    logoutBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        window.location.href = 'index.html';
    });

    // Iniciar conexión WebSocket
    connectWebSocket();
})();
