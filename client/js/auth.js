// js/auth.js - Lógica de registro e inicio de sesión
(function () {
    const API_URL = window.APP_CONFIG.AUTH_API_URL;

    // --- Registro ---
    const regBtn = document.getElementById('registerBtn');
    const regUsername = document.getElementById('regUsername');
    const regPassword = document.getElementById('regPassword');
    const regMsg = document.getElementById('regMessage');

    regBtn.addEventListener('click', async () => {
        const username = regUsername.value.trim();
        const password = regPassword.value.trim();

        if (!username || !password) {
            regMsg.className = 'error';
            regMsg.textContent = 'Usuario y contraseña requeridos';
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
                regMsg.textContent = '¡Guerrero registrado! Ahora inicia sesión.';
                regUsername.value = '';
                regPassword.value = '';
            } else if (res.status === 409) {
                regMsg.className = 'error';
                regMsg.textContent = 'Ese nombre ya existe en el campo de batalla';
            } else {
                const data = await res.json();
                regMsg.className = 'error';
                regMsg.textContent = data.error || 'Error en el registro';
            }
        } catch (err) {
            regMsg.className = 'error';
            regMsg.textContent = 'Error de conexión con el servidor de autenticación';
            console.error(err);
        } finally {
            regBtn.disabled = false;
            regBtn.textContent = 'Crear cuenta';
        }
    });

    // --- Login ---
    const loginBtn = document.getElementById('loginBtn');
    const loginUsername = document.getElementById('loginUsername');
    const loginPassword = document.getElementById('loginPassword');
    const loginMsg = document.getElementById('loginMessage');

    loginBtn.addEventListener('click', async () => {
        const username = loginUsername.value.trim();
        const password = loginPassword.value.trim();

        if (!username || !password) {
            loginMsg.className = 'error';
            loginMsg.textContent = 'Usuario y contraseña requeridos';
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
                loginMsg.textContent = 'Credenciales inválidas, guerrero';
            } else {
                const data = await res.json();
                loginMsg.className = 'error';
                loginMsg.textContent = data.error || 'Error en el login';
            }
        } catch (err) {
            loginMsg.className = 'error';
            loginMsg.textContent = 'Error de conexión con el servidor de autenticación';
            console.error(err);
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Entrar al lobby';
        }
    });
})();
