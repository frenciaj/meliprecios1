const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Vercel
app.set('trust proxy', 1);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Helpers
const base64URLEncode = (str) => str.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest();

// HTML Layout Helper
const renderPage = (title, content) => `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Meli Connector</title>
    <link rel="stylesheet" href="/style.css">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
</head>
<body>
    <header>
        <div class="header-content">
            <h1>Meli Connector</h1>
        </div>
        <a href="/">Home</a>
    </header>
    <div class="container">
        ${content}
    </div>
    <footer style="text-align: center; color: #999; margin-top: 40px; font-size: 0.8rem;">
        v2.0 - Cookie Auth - ${new Date().toISOString()}
    </footer>
</body>
</html>
`;

// Routes
app.get('/', (req, res) => {
    // Check for token in cookies
    const accessToken = req.cookies.access_token;

    if (accessToken) {
        res.redirect('/listings');
    } else {
        res.send(renderPage('Home', `
            <div class="login-card">
                <h2>Welcome to Mercado Libre Connector</h2>
                <p style="color: #666; margin-bottom: 30px;">Connect your account to view and manage your listings.</p>
                <a href="/auth" class="btn-primary">Connect with Mercado Libre</a>
            </div>
        `));
    }
});

app.get('/auth', (req, res) => {
    const verifier = base64URLEncode(crypto.randomBytes(32));
    const challenge = base64URLEncode(sha256(verifier));
    const state = base64URLEncode(crypto.randomBytes(16));

    // Store verifier and state in HTTP-only cookies
    // Vercel is HTTPS, so we should use secure: true and sameSite: none to allow cross-site redirects if needed
    const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 600000 // 10 mins
    };

    res.cookie('pkce_verifier', verifier, cookieOptions);
    res.cookie('pkce_state', state, cookieOptions);

    const authUrl = `https://auth.mercadolibre.com.ar/authorization` +
        `?response_type=code` +
        `&client_id=${process.env.CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
        `&state=${state}` +
        `&code_challenge=${challenge}` +
        `&code_challenge_method=S256`;

    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    const cookieState = req.cookies.pkce_state;
    const codeVerifier = req.cookies.pkce_verifier;

    if (!code || !state) return res.redirect('/');

    // Debugging info for user if validation fails
    if (!cookieState || state !== cookieState || !codeVerifier) {
        return res.status(400).send(renderPage('Error', `
            <div class="card">
                <h2>Security/Session Error</h2>
                <p>There was a problem verifying your session.</p>
                <div style="background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 4px; text-align: left; font-family: monospace; font-size: 0.8rem;">
                    <strong>Debug Info:</strong><br>
                    Received State: ${state}<br>
                    Cookie State: ${cookieState || 'undefined'}<br>
                    Verifier Present: ${codeVerifier ? 'Yes' : 'No'}
                </div>
                <p>Please try clicking the button below to start a fresh connection.</p>
                <a href="/" class="btn-primary">Try Again</a>
            </div>
        `));
    }

    // Clear one-time cookies
    res.clearCookie('pkce_state');
    res.clearCookie('pkce_verifier');

    try {
        const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
            headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                code: code,
                redirect_uri: process.env.REDIRECT_URI,
                code_verifier: codeVerifier
            }
        });

        const accessToken = response.data.access_token;
        const refreshToken = response.data.refresh_token; // In real app, store securely

        // Store access token in cookie for simplicity in this demo
        res.cookie('access_token', accessToken, { httpOnly: true, maxAge: 21000 * 1000 }); // 6 hours

        res.redirect('/listings');

    } catch (error) {
        console.error('Auth Error:', error.message);
        res.send(renderPage('Error', `
            <div class="card">
                <h2>Authentication Failed</h2>
                <p>${error.response ? JSON.stringify(error.response.data) : error.message}</p>
                <a href="/" class="btn-primary">Try Again</a>
            </div>
        `));
    }
});

app.get('/listings', async (req, res) => {
    const accessToken = req.cookies.access_token;

    if (!accessToken) return res.redirect('/');

    try {
        const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userId = userResponse.data.id;

        const searchResponse = await axios.get(`https://api.mercadolibre.com/users/${userId}/items/search`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { status: 'active' }
        });

        const itemIds = searchResponse.data.results;

        let allItems = [];
        if (itemIds.length > 0) {
            const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
            const batches = chunkArray(itemIds, 20);

            for (const batch of batches) {
                const itemsResponse = await axios.get(`https://api.mercadolibre.com/items`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { ids: batch.join(',') }
                });
                allItems = allItems.concat(itemsResponse.data);
            }
        }

        const tableRows = allItems.map(itemWrapper => {
            if (itemWrapper.code !== 200) return '';
            const item = itemWrapper.body;
            return `
                <tr>
                    <td>
                        <img src="${item.thumbnail}" alt="" class="thumbnail">
                    </td>
                    <td>
                        <div style="font-weight: 500;">${item.title}</div>
                        <div style="font-size: 0.8rem; color: #999;">ID: ${item.id}</div>
                    </td>
                    <td>
                        <div class="price">$ ${item.price.toLocaleString('es-AR')}</div>
                    </td>
                    <td>${item.available_quantity}</td>
                    <td><span class="status-badge status-${item.status}">${item.status}</span></td>
                    <td><a href="${item.permalink}" target="_blank" class="link-btn">View @ Meli</a></td>
                </tr>
            `;
        }).join('');

        const content = `
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2 style="margin: 0;">My Listings (${allItems.length})</h2>
                    <span style="color: #666;">User ID: ${userId}</span>
                </div>
                ${allItems.length > 0 ? `
                    <table>
                        <thead>
                            <tr>
                                <th>Image</th>
                                <th>Title</th>
                                <th>Price</th>
                                <th>Qty</th>
                                <th>Status</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                ` : '<p>No active listings found.</p>'}
            </div>
            <div style="text-align: center; margin-top: 20px;">
                <a href="/logout" style="color: #666; text-decoration: none;">Logout</a>
            </div>
        `;

        res.send(renderPage('My Listings', content));

    } catch (error) {
        console.error('Listings Error:', error.message);
        res.send(renderPage('Error', `<p>Error fetching listings: ${error.message}</p><a href="/logout">Logout</a>`));
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('access_token');
    res.redirect('/');
});


// Export app for Vercel
module.exports = app;

// Only listen if run directly (not required for Vercel)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
