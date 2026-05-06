// js/config.js - Configuración centralizada de URLs
window.APP_CONFIG = {
    // Auth service (cambiar a URL de ngrok cuando se exponga)
    AUTH_API_URL: 'http://localhost:4000',
    // Coordinator WebSocket (cambiar a wss://... cuando se use ngrok)
    COORDINATOR_WS_URL: 'ws://localhost:5000'
};
