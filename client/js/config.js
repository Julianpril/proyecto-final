// js/config.js - Configuración del cliente (Taller 6)
window.APP_CONFIG = {
    // URL del auth service (HTTP)
    // Para desarrollo local:
    // AUTH_API_URL: 'http://localhost:4000',

    // Para ngrok (sustentación) – descomenta y usa la URL de tu túnel del auth
    AUTH_API_URL: 'https://breadless-keren-topfull.ngrok-free.dev',

    // El cliente ya no tiene COORDINATOR_WS_URL fijo; lo obtiene del auth mediante /coordinator

    // ID de cliente de Google (debe coincidir con el del auth)
    GOOGLE_CLIENT_ID: '1029045203245-v2bkcr682rh2vc9raono9ddp1dvlc988.apps.googleusercontent.com'
};