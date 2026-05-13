const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const configContent = `// js/config.js - GENERADO AUTOMÁTICAMENTE A PARTIR DE .env
window.APP_CONFIG = {
    AUTH_API_URL: '${process.env.AUTH_API_URL || 'http://localhost:4000'}',
    COORDINATOR_WS_URL: '${process.env.COORDINATOR_WS_URL || 'ws://localhost:5000'}'
};
`;

const configPath = path.join(__dirname, 'js', 'config.js');

// Crear carpeta js si no existe
if (!fs.existsSync(path.join(__dirname, 'js'))) {
    fs.mkdirSync(path.join(__dirname, 'js'));
}

fs.writeFileSync(configPath, configContent);
console.log('✅ client/js/config.js generado desde .env');
