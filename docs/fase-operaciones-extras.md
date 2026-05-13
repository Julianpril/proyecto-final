# Fase de Operaciones y Features Extras

## 1. Configuracion de Google Cloud Console

### OAuth consent screen

1. Entra a Google Cloud Console y selecciona el proyecto del juego.
2. Ve a APIs y servicios > Pantalla de consentimiento OAuth.
3. Define `User Type` como `External`.
4. Completa los datos basicos de la app:
   - Nombre de la aplicacion
   - Correo de soporte
   - Correo del desarrollador
5. En `Scopes`, agrega exactamente estos permisos:
   - `email`
   - `profile`
   - `openid`
6. Si el proyecto sigue en modo pruebas, agrega tus correos en `Test users`.

### OAuth client ID

1. Ve a APIs y servicios > Credenciales.
2. Haz clic en `Crear credenciales` > `ID de cliente OAuth`.
3. Selecciona `Web application` como tipo de aplicacion.
4. Asigna un nombre, por ejemplo `Juego Web - Login Google`.
5. En `Authorized JavaScript origins` agrega:
   - `http://localhost:3000`
   - `https://TU_SUBDOMINIO.ngrok-free.dev`
6. En `Authorized redirect URIs` agrega la ruta completa del callback:
   - `https://TU_SUBDOMINIO.ngrok-free.dev/auth/google/callback`
7. Guarda y copia el `Client ID`.

### Nota sobre Ngrok

Cada vez que Ngrok genere una URL nueva, debes actualizar el origen HTTPS y el redirect URI en Google Cloud Console. El origen debe ser la raiz HTTPS, sin la ruta del callback.

## 2. Feature Extra: Color de Jugador

### HTML / UI

En el lobby usa un selector simple de color:

```html
<label class="color-picker-label" for="playerColor">Color del jugador</label>
<input id="playerColor" class="color-picker" type="color" value="#ff5500" />
```

### Frontend Cliente JS

En `client/js/lobby.js`, captura el cambio del selector y envia el mensaje exacto por WebSocket:

```js
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
```

En el render del canvas, pinta el circulo con `player.extras.color` o usa un color por defecto:

```js
function drawPlayer(p) {
    const isLocal = p.userId === localPlayerId;
    const color = (p.extras && p.extras.color) || colorFromId(p.userId);

    ctx.beginPath();
    ctx.arc(p.x, p.y, opts.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}
```

### Backend Coordinador JS

En `coordinator/index.js`, usa este bloque para `ws.on('message')`:

```js
if (isPlainObject(payload) && payload.type === 'extras_update') {
  const extras = payload.extras;

  if (!isPlainObject(extras)) {
    return;
  }

  const serialized = JSON.stringify(extras);

  if (serialized.length > 1024) {
    return;
  }

  currentPlayer.extras = JSON.parse(serialized);
}
```

## 3. Guion de Sustentacion: Demo de Autoridad Antitrampas

### Script para DevTools

Primero, el cliente debe exponer el estado local como `window.lastState`. Luego ejecuta esto en la consola del navegador:

```js
(() => {
  if (!window.lastState || !Array.isArray(window.lastState.players)) {
    console.warn('No hay lastState disponible');
    return;
  }

  const me = window.lastState.players.find((player) => player && player.userId === window.localPlayerId);
  if (!me) {
    console.warn('No hay jugador local disponible');
    return;
  }

  me.x = 1400;
  me.y = 120;

  window.lastState = {
    ...window.lastState,
    players: [...window.lastState.players]
  };

  console.log('Teletransporte local simulado');
})();
```

### Guion para decir en voz alta

"En esta pestaña modifique el estado visual del cliente desde la consola y el jugador salto de posicion. Sin embargo, la otra pestaña no cambió, porque el servidor es quien calcula y difunde la verdad del juego. El navegador solo representa el estado recibido; no decide la posicion real del jugador. Eso demuestra la autoridad del coordinador y evita trampas como teletransporte o aumento de velocidad desde el cliente."
