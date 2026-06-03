// js/game.js
export function createGame(config) {
    const { canvas, onIntent, getRenderState, localPlayerId, options = {} } = config;
    const opts = {
        worldWidth: 480,
        worldHeight: 270,
        playerRadius: 10,
        orbRadius: 8,
        backgroundColor: '#0f1419',
        gridColor: '#1f2730',
        gridSize: 30,
        ...options
    };
    // Tamaño lógico del mundo (unidades que vienen del servidor)
    const worldW = opts.worldWidth;
    const worldH = opts.worldHeight;

    // Tamaño visual en píxeles CSS (cuadrado pequeño por defecto)
    const displayW = options.displayWidth || 500;
    const displayH = options.displayHeight || Math.round((displayW * worldH) / worldW);

    // Soporte para pantallas de alta resolución sin agrandar el canvas en CSS
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    canvas.width = Math.floor(displayW * dpr);
    canvas.height = Math.floor(displayH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Factores de escala: convierte coordenadas del mundo a píxeles de pantalla
    const scaleX = displayW / worldW;
    const scaleY = displayH / worldH;

    const keys = new Set();
    let lastIntent = { x: 0, y: 0 };

    // Textos flotantes de puntos
    const floatingTexts = [];
    let animFrame = 0;

    function addFloatingText(worldX, worldY, text, color) {
        floatingTexts.push({
            x: worldX * scaleX,
            y: worldY * scaleY,
            text,
            color,
            alpha: 1.0,
            dy: -1.2,
            life: 60, // fotogramas
        });
    }

    function updateFloatingTexts() {
        for (let i = floatingTexts.length - 1; i >= 0; i--) {
            const ft = floatingTexts[i];
            ft.y += ft.dy;
            ft.life--;
            ft.alpha = Math.max(0, ft.life / 60);
            if (ft.life <= 0) floatingTexts.splice(i, 1);
        }
    }

    function drawFloatingTexts() {
        for (const ft of floatingTexts) {
            ctx.save();
            ctx.globalAlpha = ft.alpha;
            ctx.font = `bold ${Math.max(10, 16 * ((scaleX + scaleY) / 2))}px Orbitron, system-ui`;
            ctx.fillStyle = ft.color;
            ctx.textAlign = 'center';
            ctx.shadowColor = ft.color;
            ctx.shadowBlur = 10;
            ctx.fillText(ft.text, ft.x, ft.y);
            ctx.restore();
        }
    }

    function computeDirection() {
        let x = 0, y = 0;
        if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
        if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
        if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
        if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
        return { x, y };
    }

    function maybeEmitIntent() {
        const dir = computeDirection();
        if (dir.x !== lastIntent.x || dir.y !== lastIntent.y) {
            lastIntent = dir;
            onIntent({ type: 'move', dir });
        }
    }

    function onKeyDown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (keys.has(e.code)) return;
        keys.add(e.code);
        if (isMovementKey(e.code)) {
            e.preventDefault();
            maybeEmitIntent();
        }
    }

    function onKeyUp(e) {
        if (!keys.has(e.code)) return;
        keys.delete(e.code);
        if (isMovementKey(e.code)) {
            e.preventDefault();
            maybeEmitIntent();
        }
    }

    function onBlur() {
        if (keys.size === 0) return;
        keys.clear();
        maybeEmitIntent();
    }

    function isMovementKey(code) {
        return ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyA','KeyD','KeyW','KeyS'].includes(code);
    }

    function drawBackground() {
        ctx.fillStyle = opts.backgroundColor;
        ctx.fillRect(0, 0, displayW, displayH);
        ctx.strokeStyle = opts.gridColor;
        ctx.lineWidth = 1;
        const gridPx = Math.max(6, opts.gridSize * scaleX);
        for (let x = 0; x <= displayW; x += gridPx) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, displayH);
            ctx.stroke();
        }
        for (let y = 0; y <= displayH; y += gridPx) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(displayW, y);
            ctx.stroke();
        }
    }

    function colorFromId(userId) {
        const hue = (Number(userId) * 137.508) % 360;
        return `hsl(${hue}, 70%, 55%)`;
    }

    // === Dibuja los orbes con brillo y pulso ===
    function drawOrb(orb) {
        const px = orb.x * scaleX;
        const py = orb.y * scaleY;
        const baseR = Math.max(2, opts.orbRadius * ((scaleX + scaleY) / 2));
        const pulse = 1 + 0.15 * Math.sin(animFrame * 0.08 + orb.id * 2);
        const r = baseR * pulse;

        // Brillo exterior
        ctx.save();
        ctx.shadowColor = orb.color;
        ctx.shadowBlur = 18 + 5 * Math.sin(animFrame * 0.06 + orb.id);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(px, py, r * 0.2, px, py, r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.4, orb.color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Destello interior
        ctx.beginPath();
        ctx.arc(px, py, r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fill();

        // Etiqueta de puntos del orbe
        const pointsMap = { gold: '1', diamond: '3', ruby: '5' };
        const emoji = orb.type === 'gold' ? '⭐' : orb.type === 'diamond' ? '💎' : '💠';
        ctx.font = `${Math.max(7, 10 * ((scaleX + scaleY) / 2))}px system-ui`;
        ctx.fillStyle = orb.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(emoji + (pointsMap[orb.type] || ''), px, py + r + 2);
    }

    function drawPlayer(p) {
        const isLocal = p.userId === localPlayerId;
        const color = (p.extras && p.extras.color) || colorFromId(p.userId);
        const px = p.x * scaleX;
        const py = p.y * scaleY;
        // Usa el radio dinámico del servidor (mecánica Agar.io) si está disponible
        const serverRadius = (p.radius && p.radius > 0) ? p.radius : opts.playerRadius;
        const pr = Math.max(2, serverRadius * ((scaleX + scaleY) / 2));

        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = isLocal ? 2 : 1;
        ctx.strokeStyle = isLocal ? '#ffffff' : '#000000';
        ctx.stroke();
        ctx.font = Math.max(8, 12 * ((scaleX + scaleY) / 2)) + 'px system-ui';
        ctx.fillStyle = '#e6e6e6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const text = p.username + (isLocal ? ' (tú)' : '');
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.strokeText(text, px, py - pr - 4);
        ctx.fillText(text, px, py - pr - 4);
    }

    // === Dibuja el marcador superpuesto ===
    function drawLeaderboard(scores) {
        if (!scores || scores.length === 0) return;

        const padding = 10;
        const lineH = 18;
        const maxShow = Math.min(scores.length, 5);
        const boxW = 160;
        const boxH = 24 + lineH * maxShow + padding;
        const x = displayW - boxW - 10;
        const y = 10;

        // Fondo del panel
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = '#0a0c15';
        ctx.beginPath();
        ctx.roundRect(x, y, boxW, boxH, 8);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#0ff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, boxW, boxH, 8);
        ctx.stroke();
        ctx.restore();

        // Título del marcador
        ctx.font = `bold ${11}px Orbitron, system-ui`;
        ctx.fillStyle = '#0ff';
        ctx.textAlign = 'center';
        ctx.fillText('🏆 RANKING', x + boxW / 2, y + 16);

        // Entradas del marcador
        ctx.font = `${10}px system-ui`;
        ctx.textAlign = 'left';
        const medals = ['🥇', '🥈', '🥉'];
        for (let i = 0; i < maxShow; i++) {
            const s = scores[i];
            const isMe = s.userId === localPlayerId;
            const ey = y + 28 + i * lineH;
            const medal = i < 3 ? medals[i] : `${i + 1}.`;
            ctx.fillStyle = isMe ? '#FFD700' : '#b0f0ff';
            ctx.font = isMe ? `bold ${10}px system-ui` : `${10}px system-ui`;
            const name = s.username.length > 10 ? s.username.slice(0, 9) + '…' : s.username;
            ctx.fillText(`${medal} ${name}`, x + 8, ey);
            ctx.textAlign = 'right';
            ctx.fillText(`${s.score} pts`, x + boxW - 8, ey);
            ctx.textAlign = 'left';
        }
    }

    // === Dibuja el puntaje propio ===
    function drawMyScore(scores) {
        if (!scores) return;
        const me = scores.find(s => s.userId === localPlayerId);
        const myScore = me ? me.score : 0;

        ctx.save();
        ctx.font = `bold ${13}px Orbitron, system-ui`;
        ctx.fillStyle = '#FFD700';
        ctx.textAlign = 'left';
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 8;
        ctx.fillText(`⭐ ${myScore} pts`, 12, 22);
        ctx.restore();
    }

    function render() {
        const state = getRenderState();
        drawBackground();
        if (!state) return;

        // Dibuja los orbes
        if (Array.isArray(state.orbs)) {
            for (const orb of state.orbs) drawOrb(orb);
        }

        // Dibuja los jugadores
        if (Array.isArray(state.players)) {
            const sorted = [...state.players].sort((a, b) => {
                if (a.userId === localPlayerId) return 1;
                if (b.userId === localPlayerId) return -1;
                return 0;
            });
            for (const p of sorted) drawPlayer(p);
        }

        // Dibuja los textos flotantes
        updateFloatingTexts();
        drawFloatingTexts();

        // Dibuja el HUD
        drawMyScore(state.scores);
        drawLeaderboard(state.scores);

        animFrame++;
    }

    let running = false;
    let rafId = null;
    function loop() {
        if (!running) return;
        render();
        rafId = requestAnimationFrame(loop);
    }

    function start() {
        if (running) return;
        running = true;
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        loop();
    }

    function stop() {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
    }

    function destroy() {
        stop();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return { start, stop, destroy, options: opts, addFloatingText };
}