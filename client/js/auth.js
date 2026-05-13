// js/auth.js - Lógica de registro e inicio de sesión (local + Google)
(async function () {
    const API_URL = window.APP_CONFIG.AUTH_API_URL;

    // Fetch runtime config from auth service (safe: only exposes public client id)
    try {
        const cfgRes = await fetch(`${API_URL}/config`);
        if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            window.APP_CONFIG.GOOGLE_CLIENT_ID = cfg.GOOGLE_CLIENT_ID || '';
        } else {
            console.warn('No se obtuvo /config desde auth-service:', cfgRes.status);
        }
    } catch (err) {
        console.warn('Error al pedir /config:', err);
    }

    const GOOGLE_CLIENT_ID = window.APP_CONFIG.GOOGLE_CLIENT_ID;

    // --- Configurar botón de Google ---
    const googleDiv = document.getElementById('g_id_onload');
    if (googleDiv && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== '') {
        googleDiv.setAttribute('data-client_id', GOOGLE_CLIENT_ID);
    } else {
        console.warn('Google Client ID no configurado en el servidor');
    }

    // --- Registro local ---
    const regBtn = document.getElementById('registerBtn');
    const regUsername = document.getElementById('regUsername');
    const regPassword = document.getElementById('regPassword');
    const regMsg = document.getElementById('regMessage');

    regBtn.addEventListener('click', async () => {
        const username = regUsername.value.trim();
        const password = regPassword.value.trim();
        if (!username || !password) {
            regMsg.className = 'error';
            regMsg.textContent = '❌ Usuario y contraseña requeridos';
            return;
        }

        regBtn.disabled = true;
        regBtn.textContent = '⏳ Forjando...';

        try {
            const res = await fetch(`${API_URL}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (res.status === 201) {
                regMsg.className = 'success';
                regMsg.textContent = '✅ ¡Guerrero registrado! Ahora inicia sesión.';
                regUsername.value = '';
                regPassword.value = '';
            } else if (res.status === 409) {
                regMsg.className = 'error';
                regMsg.textContent = '⚠️ Ese nombre ya existe en el campo de batalla';
            } else {
                const data = await res.json();
                regMsg.className = 'error';
                regMsg.textContent = data.error || 'Error en el registro';
            }
        } catch (err) {
            regMsg.className = 'error';
            regMsg.textContent = '💀 Error de conexión con el servidor de autenticación';
            console.error(err);
        } finally {
            regBtn.disabled = false;
            regBtn.textContent = 'Crear cuenta';
        }
    });

    // --- Login local ---
    const loginBtn = document.getElementById('loginBtn');
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    const loginMsg = document.getElementById('loginMessage');

    loginBtn.addEventListener('click', async () => {
        const username = loginUsername.value.trim();
        const password = loginPassword.value.trim();
        if (!username || !password) {
            loginMsg.className = 'error';
            loginMsg.textContent = '❌ Usuario y contraseña requeridos';
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = '⏳ Conectando...';

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (res.status === 200) {
                const data = await res.json();
                localStorage.setItem('token', data.token);
                localStorage.setItem('username', data.username);
                window.location.href = 'lobby.html';
            } else if (res.status === 401) {
                loginMsg.className = 'error';
                loginMsg.textContent = '🔐 Credenciales inválidas, guerrero';
            } else {
                const data = await res.json();
                loginMsg.className = 'error';
                loginMsg.textContent = data.error || 'Error en el login';
            }
        } catch (err) {
            loginMsg.className = 'error';
            loginMsg.textContent = '💀 Error de conexión con el servidor de autenticación';
            console.error(err);
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Entrar al lobby';
        }
    });

    // --- Login con Google (maneja 409 username_required) ---
    window.handleGoogleLogin = async (response) => {
        const idToken = response.credential;
        try {
            let res = await fetch(`${API_URL}/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            });

            if (res.status === 200) {
                const data = await res.json();
                localStorage.setItem('token', data.token);
                localStorage.setItem('username', data.username);
                window.location.href = 'lobby.html';
            } 
            else if (res.status === 409) {
                const error = await res.json();
                if (error.error === 'username_required') {
                    let chosen = prompt('Primera vez con Google. Elige un nombre de guerrero:');
                    if (!chosen) return;
                    res = await fetch(`${API_URL}/auth/google`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ idToken, username: chosen })
                    });
                    if (res.status === 200) {
                        const data = await res.json();
                        localStorage.setItem('token', data.token);
                        localStorage.setItem('username', data.username);
                        window.location.href = 'lobby.html';
                    } else if (res.status === 409) {
                        alert('Nombre de usuario ya en uso, elige otro');
                    } else {
                        alert('Error al crear usuario');
                    }
                } else if (error.error === 'username_taken') {
                    alert('El nombre de usuario ya está en uso');
                } else {
                    alert('Error inesperado');
                }
            }
            else if (res.status === 401) {
                alert('Token de Google inválido o email no verificado');
            } else {
                const err = await res.json();
                alert('Error con Google: ' + (err.error || 'desconocido'));
            }
        } catch (err) {
            console.error(err);
            alert('Error de conexión con el servidor de autenticación');
        }
    };
})();