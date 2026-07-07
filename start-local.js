const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

process.env.RUNNING_LOCAL = 'true';

// Load existing env variables
require('dotenv').config();

const PORT = process.env.PORT || 3000;

(async () => {
    console.log('Starting tunnelmole tunnel...');
    
    // Spawn tunnelmole: npx tunnelmole 3000
    const tunnelProcess = spawn('npx', ['tunnelmole', PORT.toString()], { shell: true });
    
    let tunnelUrl = '';
    
    tunnelProcess.stdout.on('data', (data) => {
        const output = data.toString();
        // Look for the HTTPS URL, e.g. https://xxxx.tunnelmole.net
        const match = output.match(/https:\/\/[a-zA-Z0-9.-]+\.tunnelmole\.net/);
        if (match && !tunnelUrl) {
            tunnelUrl = match[0];
            console.log('\n======================================================');
            console.log(`🚀 Tunnelmole active: ${tunnelUrl}`);
            console.log(`🔗 Redirect URI: ${tunnelUrl}/callback`);
            console.log('======================================================\n');
            
            // Set Redirect URI in environment
            process.env.REDIRECT_URI = `${tunnelUrl}/callback`;
            
            // Update the .env file automatically
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                if (envContent.includes('REDIRECT_URI=')) {
                    envContent = envContent.replace(/REDIRECT_URI=.*/, `REDIRECT_URI=${tunnelUrl}/callback`);
                } else {
                    envContent += `\nREDIRECT_URI=${tunnelUrl}/callback\n`;
                }
                fs.writeFileSync(envPath, envContent, 'utf8');
                console.log('Updated REDIRECT_URI in .env file.');
            }
            
            // Start the server in the same process
            console.log('Starting local Express server...');
            require('./server.js');
        }
    });

    tunnelProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Filter out deprecation warnings to keep logs clean
        if (!msg.includes('npm warn') && !msg.includes('Multer')) {
            console.error(`[Tunnelmole Error]: ${msg}`);
        }
    });

    tunnelProcess.on('close', (code) => {
        console.log(`Tunnelmole process exited with code ${code}`);
    });
})();
