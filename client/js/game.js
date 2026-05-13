// js/game.js
export function createGame(config) {
    const { canvas, onIntent, getRenderState, localPlayerId, options = {} } = config;
    const opts = {
        worldWidth: 480,
        worldHeight: 270,
        playerRadius: 10,
        backgroundColor: '#0f1419',
        gridColor: '#1f2730',
        gridSize: 30,
        ...options
    };
    // World logical size (units from server)
    const worldW = opts.worldWidth;
    const worldH = opts.worldHeight;

    // Display size in CSS pixels (small square by default)
    const displayW = options.displayWidth || 500;
    const displayH = options.displayHeight || Math.round((displayW * worldH) / worldW);

    // Support high-DPI displays while keeping canvas CSS size small
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    canvas.width = Math.floor(displayW * dpr);
    canvas.height = Math.floor(displayH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Scale factors: map world coordinates -> display pixels
    const scaleX = displayW / worldW;
    const scaleY = displayH / worldH;

    const keys = new Set();
    let lastIntent = { x: 0, y: 0 };

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

    function drawPlayer(p) {
        const isLocal = p.userId === localPlayerId;
        const color = (p.extras && p.extras.color) || colorFromId(p.userId);
        const px = p.x * scaleX;
        const py = p.y * scaleY;
        const pr = Math.max(2, opts.playerRadius * ((scaleX + scaleY) / 2));

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

    function render() {
        const state = getRenderState();
        drawBackground();
        if (!state || !Array.isArray(state.players)) return;
        const sorted = [...state.players].sort((a,b) => {
            if (a.userId === localPlayerId) return 1;
            if (b.userId === localPlayerId) return -1;
            return 0;
        });
        for (const p of sorted) drawPlayer(p);
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

    return { start, stop, destroy, options: opts };
}