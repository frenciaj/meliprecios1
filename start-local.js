const localtunnel = require('localtunnel');
const fs = require('fs');
const path = require('path');

// Load existing env variables
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const SUBDOMAIN = process.env.LOCALTUNNEL_SUBDOMAIN || '';

(async () => {
    console.log('Starting localtunnel...');
    try {
        const opts = { port: PORT };
        if (SUBDOMAIN) {
            opts.subdomain = SUBDOMAIN;
        }

        const tunnel = await localtunnel(opts);
        console.log('\n======================================================');
        console.log(`🚀 Localtunnel active: ${tunnel.url}`);
        console.log(`🔗 Redirect URI: ${tunnel.url}/callback`);
        console.log('======================================================\n');

        // Dynamically override REDIRECT_URI in environment before starting server
        process.env.REDIRECT_URI = `${tunnel.url}/callback`;

        // Update the .env file automatically so the user can see it
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            if (envContent.includes('REDIRECT_URI=')) {
                envContent = envContent.replace(/REDIRECT_URI=.*/, `REDIRECT_URI=${tunnel.url}/callback`);
            } else {
                envContent += `\nREDIRECT_URI=${tunnel.url}/callback\n`;
            }
            fs.writeFileSync(envPath, envContent, 'utf8');
            console.log('Updated REDIRECT_URI in .env file.');
        }

        tunnel.on('close', () => {
            console.log('Tunnel closed.');
        });

        // Start the server in the same process
        require('./server.js');

    } catch (err) {
        console.error('Error starting localtunnel:', err.message);
        console.log('Falling back to local-only mode (http://localhost:3000).');
        console.log('NOTE: Mercado Libre OAuth requires HTTPS/Tunneling to function.');
        require('./server.js');
    }
})();
