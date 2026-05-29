const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// AUTH_URLS: array from VITE_AUTH_URLS (comma-separated) or legacy VITE_AUTH_SERVICE_URL
const rawUrls   = process.env.VITE_AUTH_URLS || process.env.VITE_AUTH_SERVICE_URL || process.env.AUTH_API_URL || 'http://localhost:4000';
const authUrls  = rawUrls.split(',').map(s => s.trim()).filter(Boolean);
const authUrlsJson = JSON.stringify(authUrls);

const configContent = `// js/config.js - GENERADO AUTOMÁTICAMENTE A PARTIR DE .env
window.APP_CONFIG = {
    AUTH_API_URL:  '${authUrls[0]}',
    AUTH_URLS:     ${authUrlsJson},
    COORDINATOR_WS_URL: '${process.env.COORDINATOR_WS_URL || 'ws://localhost:5000'}',
    GOOGLE_CLIENT_ID: '${process.env.GOOGLE_CLIENT_ID || ''}'
};
`;

const configPath = path.join(__dirname, 'js', 'config.js');
if (!fs.existsSync(path.join(__dirname, 'js'))) {
    fs.mkdirSync(path.join(__dirname, 'js'));
}
fs.writeFileSync(configPath, configContent);
console.log('✅ client/js/config.js generado desde .env');
