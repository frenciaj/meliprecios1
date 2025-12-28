const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();

// Initialize Database
const fs = require('fs');

// Initialize Database
const dbPath = process.env.VERCEL ? '/tmp/meliprecios.db' : 'meliprecios.db';
console.log(`[Startup] Initializing Database at: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[Startup] Critical DB Connection Error:', err.message);
    } else {
        console.log(`[Startup] Connected to SQLite database at ${dbPath}`);
        // Enable WAL mode for better concurrency
        db.run('PRAGMA journal_mode = WAL;');
    }
});

db.run(`CREATE TABLE IF NOT EXISTS items_v14 (
    id TEXT,
    user_id TEXT,
    title TEXT,
    thumbnail TEXT,
    price REAL,
    currency_id TEXT,
    available_quantity INTEGER,
    original_price REAL,
    permalink TEXT,
    status TEXT,
    listing_type_id TEXT,
    sale_price_amount REAL,
    sale_price_regular_amount REAL,
    promotion_id TEXT,
    promotion_type TEXT,
    price_to_win REAL,
    last_updated DATETIME,
    free_shipping INTEGER,
    brand TEXT,
    sold_quantity INTEGER DEFAULT 0,
    promotion_name TEXT,
    PRIMARY KEY (id, user_id)
)`);

// Migration: Add sold_quantity column if it doesn't exist
db.run(`ALTER TABLE items_v14 ADD COLUMN sold_quantity INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
        console.error('[Migration] Error adding sold_quantity:', err.message);
    }
});

// Migration: Add promotion_name column if it doesn't exist
db.run(`ALTER TABLE items_v14 ADD COLUMN promotion_name TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
        console.error('[Migration] Error adding promotion_name:', err.message);
    }
});


// Ensure DB is closed on exit
process.on('SIGINT', () => {
    db.close(() => {
        console.log('DB Connection closed.');
        process.exit(0);
    });
});

const app = express();
const PORT = process.env.PORT || 3000;

// Global Cache for Fees (persists between requests to minimize API calls)
const GLOBAL_FEE_CACHE = new Map();
const GLOBAL_SHIPPING_CACHE = new Map();

// Listing Type Mappings (normalized for API requests)
const LISTING_TYPE_ALIASES = {
    'gold_special': 'classic',
    'gold_pro': 'premium',
    'classic': 'classic',
    'premium': 'premium'
};

// Trust proxy for Vercel
app.set('trust proxy', 1);

app.get('/debug-config', (req, res) => {
    res.send(`
        <h1>Configuration Debug</h1>
        <p><strong>Redirect URI (Server sees):</strong> ${process.env.REDIRECT_URI}</p>
        <p><strong>Client ID (Server sees):</strong> ${process.env.CLIENT_ID}</p>
        <p><em>Check if these match EXACTLY what is in your Mercado Libre App Settings.</em></p>
        <hr>
        <p>Timestamp: ${new Date().toISOString()}</p>
    `);
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(express.json()); // Parse JSON request bodies

// Helpers
const base64URLEncode = (str) => str.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest();

const renderDebugError = (title, msg, details = {}) => {
    return renderPage('System Error', `
        <div class="card">
            <h2 style="color: #d00000;">${title}</h2>
            <p>${msg}</p>
            <div style="background: #222; color: #0f0; padding: 15px; margin: 15px 0; border-radius: 4px; text-align: left; font-family: monospace; font-size: 0.8rem; overflow-x: auto;">
                <strong>DEBUG REPORT (v8.1):</strong><br>
                ---------------------------<br>
                ${Object.entries(details).map(([k, v]) => `<strong>${k}:</strong> ${typeof v === 'object' ? JSON.stringify(v, null, 2) : v}`).join('<br>')}
            </div>
            <a href="/" class="btn-primary">Go Home</a>
        </div>
    `);
};

// HTML Layout Helper
const renderPage = (title, content, activeTab = 'listings') => `
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
        <div class="header-content" style="text-align: center; flex: 1;">
            <h1>Listado De Articulos</h1>
        </div>
        <div style="display: flex; gap: 20px; align-items: center;">
            <a href="/">Home</a>
            <a href="/logout" style="color: #d32f2f;">Logout</a>
        </div>
    </header>
    
    <nav class="tabs-nav">
        <a href="/listings" class="tab-link ${activeTab === 'listings' ? 'active' : ''}">Listados</a>
        <a href="/promotions" class="tab-link ${activeTab === 'promotions' ? 'active' : ''}">Promociones</a>
    </nav>

    <div class="container">
        ${content}
    </div>
    <footer style="text-align: center; color: #999; margin-top: 40px; font-size: 0.8rem;">
        <div>Creado por Tatan. Todos los Derechos Reservados &copy; ${new Date().getFullYear()}</div>
        <div style="margin-top: 5px;">v12.56 - Inline Promo Name - ${new Date().toISOString()}</div>
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
                    <div style="margin-top: 20px; font-size: 0.8rem;">
                        <a href="/debug-config" style="color: #999;">Diagnostic Config</a>
                    </div>
                </div>
            `, 'none'));
    }
});

app.get('/auth', (req, res) => {
    // If already has token, just go to listings
    if (req.cookies.access_token) {
        return res.redirect('/listings');
    }

    const verifier = base64URLEncode(crypto.randomBytes(32));
    const challenge = base64URLEncode(sha256(verifier));
    const state = base64URLEncode(crypto.randomBytes(16));

    // Store verifier and state in HTTP-only cookies
    // Use sameSite: 'lax' to allow cookies during OAuth redirects
    const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
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
    const cookiesReceived = Object.keys(req.cookies);

    if (!code || !state) return res.redirect('/');

    // Validation
    if (!cookieState || state !== cookieState || !codeVerifier) {
        return res.status(400).send(renderDebugError(
            'Session Validation Failed',
            'We could not verify your security session.',
            {
                state,
                cookieState,
                codeVerifier: codeVerifier ? 'PRESENT' : 'MISSING',
                cookies: cookiesReceived.join(', ')
            }
        ));
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

        // Store access token
        const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 21000 * 1000 };
        res.cookie('access_token', accessToken, cookieOptions);

        res.redirect('/listings');

    } catch (error) {
        console.error('Auth Error:', error.message);
        return res.status(500).send(renderDebugError(
            'Mercado Libre API Error',
            'Authentication was rejected by Mercado Libre.',
            { apiError: error.response ? error.response.data : error.message }
        ));
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
        const userName = userResponse.data.nickname || userResponse.data.first_name || 'Seller';

        // Pagination & Search Params
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const search = req.query.q ? `%${req.query.q}%` : '%';
        const statusFilter = req.query.status || 'all';
        const sortBy = req.query.sort || 'name';

        // Build SQL Query
        let sql = `SELECT * FROM items_v14 WHERE user_id = ? AND (title LIKE ? OR id LIKE ? OR brand LIKE ?)`;
        const params = [userId, search, search, search];

        if (statusFilter !== 'all') {
            sql += ` AND status = ?`;
            params.push(statusFilter);
        }

        // Get Total Count
        db.get(`SELECT COUNT(*) as count FROM (${sql})`, params, (err, row) => {
            if (err) {
                console.error('DB Count Error:', err);
                return res.send(renderPage('Error', '<p>Database Error</p>', 'listings'));
            }
            const totalItems = row.count;
            const totalPages = Math.ceil(totalItems / limit);

            // Get Items with dynamic sorting
            let orderByClause = 'title ASC'; // Default: alphabetical
            if (sortBy === 'sales') orderByClause = 'sold_quantity DESC';
            else if (sortBy === 'price_asc') orderByClause = 'price ASC';
            else if (sortBy === 'price_desc') orderByClause = 'price DESC';

            sql += ` ORDER BY ${orderByClause} LIMIT ? OFFSET ?`;
            params.push(limit, offset);

            db.all(sql, params, async (err, rows) => {
                if (err) {
                    console.error('DB Query Error:', err);
                    return res.send(renderPage('Error', '<p>Database Query Error</p>', 'listings'));
                }

                const allItems = rows;

                // Hydrate with Real-time Data (Fees, BuyBox) - limited to current page
                const buyBoxData = new Map();
                const feeData = new Map();
                const shippingData = new Map();
                // We use DB sale prices initially, but verify if needed? 
                // Let's trust DB for speed (Sync button is there for a reason).
                // Just fetch fees and buybox.

                await Promise.all(allItems.map(async (item) => {
                    const itemId = item.id;

                    // 1. Buy Box
                    try {
                        const pbRes = await axios.get(`https://api.mercadolibre.com/items/${itemId}/price_to_win`, {
                            headers: { Authorization: `Bearer ${accessToken}` },
                            params: { siteId: 'MLA', version: 'v2' }
                        });
                        buyBoxData.set(itemId, { status: pbRes.data.status, priceToWin: pbRes.data.price_to_win });
                    } catch (e) { }

                    // 2. Fees & Shipping
                    try {
                        const detailRes = await axios.get(`https://api.mercadolibre.com/suggestions/items/${itemId}/details`, {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        });
                        if (detailRes.data?.costs) {
                            const c = detailRes.data.costs;
                            feeData.set(itemId, { saleFee: c.selling_fees, financingFee: 0 });
                            shippingData.set(itemId, c.shipping_fees);
                        } else {
                            feeData.set(itemId, { saleFee: item.price * 0.15, financingFee: 0, isEstimate: true });
                            shippingData.set(itemId, 0);
                        }
                    } catch (e) {
                        feeData.set(itemId, { saleFee: item.price * 0.15, financingFee: 0, isEstimate: true });
                        shippingData.set(itemId, 0);
                    }
                }));

                // Render Table Rows
                const tableRows = allItems.map((item) => {
                    const spAmount = item.sale_price_amount;
                    const spRegular = item.sale_price_regular_amount;
                    const currentPrice = spAmount || item.price;
                    const originalPrice = spRegular || item.original_price || item.price;
                    const hasPromo = originalPrice > currentPrice;

                    // Buy Box Logic
                    let buyBoxStatus = '';
                    let buyBoxClass = 'status-na';
                    let priceToWin = '-';
                    const bbData = buyBoxData.get(item.id);
                    if (bbData) {
                        const s = bbData.status;
                        if (s === 'winning') { buyBoxStatus = '🏆 Winning'; buyBoxClass = 'status-winning'; }
                        else if (s === 'sharing_first_place') { buyBoxStatus = '🏆 Sharing 1st'; buyBoxClass = 'status-winning'; }
                        else if (s === 'losing') { buyBoxStatus = 'Losing'; buyBoxClass = 'status-losing'; }

                        // New Condition: No status but Price to Win exists -> Perdiendo
                        if (!s && bbData.priceToWin) {
                            buyBoxStatus = '💀 Perdiendo';
                            buyBoxClass = 'status-losing';
                        }

                        if (bbData.priceToWin) priceToWin = `$ ${bbData.priceToWin.toLocaleString('es-AR')}`;
                    }

                    // Fees
                    const fees = feeData.get(item.id) || { saleFee: 0 };
                    // Only deduct shipping if Free Shipping is ACTIVE (1)
                    // If free_shipping is 0 (Buyer pays), then cost to seller is 0.
                    const rawShipFee = Number(shippingData.get(item.id)) || 0;
                    const shipFee = (item.free_shipping === 1) ? rawShipFee : 0;

                    const saleFee = Number(fees.saleFee) || 0;
                    const netIncome = currentPrice - saleFee - shipFee;
                    const netIncomeFormatted = `$ ${isFinite(netIncome) ? netIncome.toLocaleString('es-AR') : '---'}`;
                    const netIncomeColor = netIncome < 0 ? '#d32f2f' : '#00a650';

                    return `
                        <tr>
                            <td><img src="${item.thumbnail}" class="thumbnail"></td>
                            <td>
                                <div style="font-weight: 500;">${item.title}</div>
                                <div style="font-size: 0.75rem; color: #999; margin-top: 4px;">
                                    ID: ${item.id} | Marca: ${item.brand || 'N/A'} | <span style="font-weight: 700; color: #666;">Vendidos: ${item.sold_quantity || 0}</span>
                                </div>
                            </td>
                            <td>
                                <div class="price-edit-container" data-item-id="${item.id}">
                                    <div class="price-display">
                                        <span class="price-value">$ ${Number(item.price).toLocaleString('es-AR')}</span>
                                        <button class="edit-price-btn" onclick="editPrice('${item.id}', ${item.price})">✏️</button>
                                    </div>
                                    <div class="price-edit-form" style="display: none;">
                                        <input type="number" class="price-input" value="${item.price}" step="0.01" onkeydown="if(event.key==='Enter') savePrice('${item.id}')" />
                                        <button class="save-price-btn" onclick="savePrice('${item.id}')">✓</button>
                                        <button class="cancel-price-btn" onclick="cancelEdit('${item.id}')">✗</button>
                                    </div>
                                </div>
                            </td>
                            <td style="text-align: center;">
                                ${hasPromo ? `
                                    <div class="promo-edit-container" data-item-id="${item.id}" data-promo-id="${item.promotion_id || ''}" data-promo-type="${item.promotion_type || ''}">
                                        <div class="promo-display">
                                            <div style="color: #00a650; font-weight: 700; font-size: 1.1rem;">$ <span class="promo-value-text">${currentPrice.toLocaleString('es-AR')}</span></div>
                                            <div style="font-size: 0.7rem; color: #666; background: #e6f7ee; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px;">En Promoción</div>
                                            <button class="edit-price-btn" onclick="editPromoPrice('${item.id}', ${currentPrice})" style="margin-left: 5px;">✏️</button>
                                            ${item.promotion_name ? `<div style="font-size: 0.75rem; color: #4da6ff; margin-top: 6px; line-height: 1.2; max-width: 180px; margin-left: auto; margin-right: auto;">${item.promotion_name}</div>` : ''}
                                        </div>
                                        <div class="promo-edit-form" style="display: none; align-items: center; justify-content: center; gap: 5px; margin-top: 5px;">
                                            <input type="number" class="promo-input" value="${currentPrice}" step="0.01" style="width: 80px; padding: 4px;" onkeydown="if(event.key==='Enter') savePromoPrice('${item.id}')" />
                                            <button class="save-price-btn" onclick="savePromoPrice('${item.id}')">✓</button>
                                            <button class="cancel-price-btn" onclick="cancelPromoEdit('${item.id}')">✗</button>
                                        </div>
                                    </div>
                                ` : '<span style="color: #ccc;">---</span>'}
                            </td>
                            <td class="net-income-cell" style="font-weight: 600; color: ${netIncomeColor};">
                                ${netIncomeFormatted}
                                <div class="fee-tooltip">
                                     <div class="tooltip-title">Detalle de Costos</div>
                                     <div class="tooltip-row"><span class="tooltip-label">Venta:</span><span class="tooltip-value">$ ${currentPrice.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row"><span class="tooltip-label">Cargos:</span><span class="tooltip-value minus">-$ ${saleFee.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row"><span class="tooltip-label">Envío:</span><span class="tooltip-value minus">-$ ${shipFee.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row total"><span class="tooltip-label">Recibís:</span><span class="tooltip-value" style="color: ${netIncomeColor};">${netIncomeFormatted}</span></div>
                                     ${item.free_shipping === 0 ? '<div class="tooltip-row" style="margin-top:5px; font-size:0.7rem; color:#666;">* Envío a cargo del comprador</div>' : ''}
                                </div>
                            </td>
                            <td>${priceToWin}</td>
                            <td>
                                <div class="qty-edit-container" data-item-id="${item.id}">
                                    <div class="qty-display"><span class="qty-value">${item.available_quantity}</span><button class="edit-qty-btn" onclick="editQty('${item.id}', ${item.available_quantity})">✏️</button></div>
                                    <div class="qty-edit-form" style="display: none;">
                                        <input type="number" class="qty-input" value="${item.available_quantity}" step="1" onkeydown="if(event.key==='Enter') saveQty('${item.id}')" />
                                        <button class="save-qty-btn" onclick="saveQty('${item.id}')">✓</button>
                                        <button class="cancel-qty-btn" onclick="cancelQtyEdit('${item.id}')">✗</button>
                                    </div>
                                </div>
                            </td>
                            <td><span class="status-badge status-${item.status}">${item.status}</span></td>
                            <td><span class="status-badge ${buyBoxClass}">${buyBoxStatus}</span></td>
                            <td><a href="${item.permalink}" target="_blank" class="link-btn">View</a></td>
                        </tr>
                    `;
                }).join('');

                const content = `
                    <div class="card">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                            <h2 style="margin: 0; display: flex; align-items: center; gap: 10px;">
                                Mis Artículos 
                                <span id="item-count" style="background: #eee; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; color: #666;">${totalItems}</span>
                            </h2>
                            <div style="display: flex; gap: 15px; align-items: center;">
                                <div style="display: flex; align-items: center; gap: 8px; background: #f0f8ff; padding: 6px 12px; border-radius: 20px; border: 1px solid #d0e8ff;">
                                    <span style="font-size: 1.2rem;">👤</span>
                                    <div style="display: flex; flex-direction: column; line-height: 1;">
                                        <span style="font-size: 0.7rem; color: #666; font-weight: 500;">Vendedor</span>
                                        <span style="font-weight: 600; color: #333;">${userName}</span>
                                    </div>
                                </div>
                                <select id="sortBy" onchange="applyListingsSort()" style="padding: 8px 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 0.9rem; cursor: pointer; background: white; font-weight: 500;">
                                    <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Alfabético</option>
                                    <option value="sales" ${sortBy === 'sales' ? 'selected' : ''}>Más vendidos</option>
                                    <option value="price_asc" ${sortBy === 'price_asc' ? 'selected' : ''}>Precio: menor a mayor</option>
                                    <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Precio: mayor a menor</option>
                                </select>
                                <button onclick="syncListings()" id="sync-btn" style="background: white; color: #00a650; border: 1px solid #00a650; padding: 8px 16px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: 500; transition: all 0.2s;">
                                    <span>🔄</span> Actualizar
                                </button>
                            </div>
                        </div>

                        <div style="margin-bottom: 20px; display: flex; gap: 10px; align-items: center; background: #f9f9f9; padding: 15px; border-radius: 8px;">
                            <form action="/listings" method="GET" style="display: flex; gap: 10px; width: 100%;">
                                <input type="text" name="q" value="${req.query.q || ''}" placeholder="Buscar por título, ID o marca..." style="flex-grow: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                                <select name="status" style="padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                                    <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>Todos los Estados</option>
                                    <option value="active" ${statusFilter === 'active' ? 'selected' : ''}>Activo</option>
                                    <option value="paused" ${statusFilter === 'paused' ? 'selected' : ''}>Pausado</option>
                                    <option value="closed" ${statusFilter === 'closed' ? 'selected' : ''}>Cerrado</option>
                                </select>
                                <select name="limit" onchange="this.form.submit()" style="padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                                    <option value="50" ${limit === 50 ? 'selected' : ''}>50 / pág</option>
                                    <option value="100" ${limit === 100 ? 'selected' : ''}>100 / pág</option>
                                    <option value="200" ${limit === 200 ? 'selected' : ''}>200 / pág</option>
                                </select>
                                <button type="submit" style="background: #3483fa; color: white; border: none; padding: 0 20px; border-radius: 4px; cursor: pointer;">Buscar</button>
                            </form>
                        </div>

                        ${totalItems === 0 ? `
                            <div style="text-align: center; padding: 40px; color: #666;">
                                <p>No items found in database.</p>
                                <p>Click <strong>Sync</strong> to fetch your listings from Mercado Libre.</p>
                            </div>
                        ` : `
                            <table id="listings-table">
                                <thead>
                                    <tr>
                                        <th>Imagen</th>
                                        <th>Nombre</th>
                                        <th>Precio (Base)</th>
                                        <th>Promoción</th>
                                        <th>Lo que recibis</th>
                                        <th>Precio para Ganar</th>
                                        <th>Cant</th>
                                        <th>Status</th>
                                        <th>Buy Box</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>${tableRows}</tbody>
                            </table>

                            <!-- Pagination -->
                            <div style="display: flex; justify-content: center; align-items: center; margin-top: 20px; gap: 15px;">
                                ${page > 1 ? `<a href="/listings?page=${page - 1}&limit=${limit}&q=${req.query.q || ''}&status=${statusFilter}" style="padding: 8px 16px; background: #eee; border-radius: 4px; text-decoration: none; color: #333;">&laquo; Prev</a>` : ''}
                                <span style="color: #666;">Page ${page} of ${totalPages}</span>
                                ${page < totalPages ? `<a href="/listings?page=${page + 1}&limit=${limit}&q=${req.query.q || ''}&status=${statusFilter}" style="padding: 8px 16px; background: #eee; border-radius: 4px; text-decoration: none; color: #333;">Next &raquo;</a>` : ''}
                            </div>
                        `}

                        <script>
                            async function syncListings() {
                                const btn = document.getElementById('sync-btn');
                                const originalText = btn.innerHTML;
                                btn.disabled = true;
                                btn.innerHTML = '⏳ Syncing...';
                                
                                try {
                                    const version = 'v12.53';
                                    const footerDescription = 'Listing Manager & Repricer - Styled Promo Tooltip';
                                    const res = await fetch('/sync-listings', { method: 'POST' });
                                    const data = await res.json();
                                    if (data.success) {
                                        alert('Sync Complete! Processed ' + data.count + ' items.');
                                        location.reload();
                                    } else {
                                        alert('Sync Error: ' + data.error);
                                    }
                                } catch (e) {
                                    alert('Sync Failed: ' + e.message);
                                } finally {
                                    btn.innerHTML = originalText;
                                    btn.disabled = false;
                                }
                            }

                            // --- Price Editing ---
                            function editPrice(itemId, currentPrice) {
                                document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .price-display').style.display = 'none';
                                const form = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .price-edit-form');
                                form.style.display = 'flex';
                                form.querySelector('input').focus();
                            }

                            function cancelEdit(itemId) {
                                document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .price-display').style.display = 'flex';
                                document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .price-edit-form').style.display = 'none';
                            }

                            async function savePrice(itemId) {
                                const input = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .price-input');
                                const newPrice = input.value;
                                const btn = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"] .save-price-btn');
                                
                                btn.disabled = true;
                                btn.innerHTML = '...';

                                try {
                                    const controller = new AbortController();
                                    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

                                    const res = await fetch('/update-price', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ itemId, newPrice }),
                                        signal: controller.signal
                                    });
                                    clearTimeout(timeoutId);

                                    const contentType = res.headers.get('content-type');
                                    if (contentType && contentType.includes('text/html')) {
                                        throw new Error('Server Crash (HTML Response)');
                                    }

                                    const data = await res.json();
                                    if (data.success) {
                                        location.reload();
                                    } else {
                                        alert('Error updating price: ' + data.error);
                                        btn.disabled = false;
                                        btn.innerHTML = '✓';
                                    }
                                } catch (e) {
                                    if (e.name === 'AbortError') {
                                        alert('Error: Request timed out. Please try again.');
                                    } else {
                                        alert('Error: ' + e.message);
                                    }
                                    btn.disabled = false;
                                    btn.innerHTML = '✓';
                                }
                            }

                            // --- Quantity Editing ---
                            function editQty(itemId, currentQty) {
                                document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .qty-display').style.display = 'none';
                                const form = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .qty-edit-form');
                                form.style.display = 'flex';
                                form.querySelector('input').focus();
                            }

                            function cancelQtyEdit(itemId) {
                                document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .qty-display').style.display = 'flex';
                                document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .qty-edit-form').style.display = 'none';
                            }

                            async function saveQty(itemId) {
                                const input = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .qty-input');
                                const newQuantity = input.value;
                                const btn = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"] .save-qty-btn');

                                btn.disabled = true;
                                btn.innerHTML = '...';

                                try {
                                    const res = await fetch('/update-quantity', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ itemId, newQuantity })
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                        location.reload();
                                    } else {
                                        alert('Error updating quantity: ' + data.error);
                                        btn.disabled = false;
                                        btn.innerHTML = '✓';
                                    }
                                } catch (e) {
                                    alert('Error: ' + e.message);
                                    btn.disabled = false;
                                    btn.innerHTML = '✓';
                                }
                            }

                            // --- Promo Price Editing (Inline) ---
                            function editPromoPrice(itemId, currentPrice) {
                                document.querySelector('.promo-edit-container[data-item-id="' + itemId + '"] .promo-display').style.display = 'none';
                                const form = document.querySelector('.promo-edit-container[data-item-id="' + itemId + '"] .promo-edit-form');
                                form.style.display = 'flex';
                                form.querySelector('input').focus();
                            }

                            function cancelPromoEdit(itemId) {
                                document.querySelector('.promo-edit-container[data-item-id="' + itemId + '"] .promo-display').style.display = 'block';
                                document.querySelector('.promo-edit-container[data-item-id="' + itemId + '"] .promo-edit-form').style.display = 'none';
                            }

                            async function savePromoPrice(itemId) {
                                const container = document.querySelector('.promo-edit-container[data-item-id="' + itemId + '"]');
                                const input = container.querySelector('.promo-input');
                                const promoId = container.dataset.promoId;
                                const promoType = container.dataset.promoType;
                                const newPrice = parseFloat(input.value);

                                if (!promoId || !promoType) {
                                    alert('Error: Missing promotion data');
                                    return;
                                }

                                const btn = container.querySelector('.save-price-btn');
                                btn.disabled = true;
                                btn.innerHTML = '...';

                                try {
                                    // Use /apply-promotion endpoint
                                    const res = await fetch('/apply-promotion', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ 
                                            item_id: itemId, 
                                            promotion_id: promoId, 
                                            promotion_type: promoType, 
                                            deal_price: newPrice 
                                        })
                                    });
                                    
                                    if (res.ok) {
                                        location.reload();
                                    } else {
                                        let errorMsg = 'Unknown Error';
                                        try {
                                            const data = await res.json();
                                            // 1. Unpack server error wrapper
                                            if (data.error) {
                                                // 2. Check if error is a stringified JSON (from our backend)
                                                if (data.error.startsWith('{')) {
                                                    const errorObj = JSON.parse(data.error);
                                                    
                                                    // 3. Extract best message
                                                    if (errorObj.api_error && errorObj.api_error.message) {
                                                        errorMsg = errorObj.api_error.message;
                                                        
                                                        // 4. Overrides for Humans
                                                        if (errorMsg.includes('PRICE_GT_CURRENT')) {
                                                            errorMsg = "⚠️ Operation Denied: You cannot raise the price of an active promotion.";
                                                        }
                                                    } else if (errorObj.message) {
                                                        errorMsg = errorObj.message;
                                                    }
                                                } else {
                                                    errorMsg = data.error;
                                                }
                                            }
                                        } catch (e) {
                                            errorMsg = await res.text(); // Fallback to raw text
                                        }

                                        alert('Error updating promo: ' + errorMsg);
                                        btn.disabled = false;
                                        btn.innerHTML = '✓';
                                    }
                                } catch (e) {
                                    alert('Error: ' + e.message);
                                    btn.disabled = false;
                                    btn.innerHTML = '✓';
                                }
                            }

                            function applyListingsSort() {
                                const sortValue = document.getElementById('sortBy').value;
                                const url = new URL(window.location);
                                url.searchParams.set('sort', sortValue);
                                url.searchParams.set('page', '1');
                                window.location.href = url.toString();
                            }
                        </script>
                    </div>
                `;

                res.send(renderPage('My Listings', content, 'listings'));
            });
        });

    } catch (error) {
        console.error('Listings Error:', error.message);
        res.send(renderPage('Error', `<p>Error fetching listings: ${error.message}</p>`, 'listings'));
    }
});


// Update item price
app.post('/update-price', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const { itemId, newPrice } = req.body;
    if (!itemId || newPrice === undefined) return res.status(400).json({ success: false, error: 'Missing params' });

    try {
        // 1. Get User ID
        const userRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
        const userId = userRes.data.id;

        console.log(`[Price Update] Item: ${itemId}, New Price: ${newPrice}, User: ${userId}`);

        // 2. Update API with explicit timeout
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { price: parseFloat(newPrice) }, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            timeout: 5000 // Reduced to 5s to catch latency early
        });
        console.log(`[Price Update] API Success for ${itemId}`);

        // 3. Update Local DB (wrapped in Promise to ensure completion)
        await new Promise((resolve, reject) => {
            db.run(`UPDATE items_v14 SET price = ?, last_updated = ? WHERE id = ? AND user_id = ?`,
                [parseFloat(newPrice), new Date().toISOString(), itemId, userId],
                (err) => {
                    if (err) {
                        console.error('Local DB Update Error:', err);
                        reject(err);
                    } else {
                        console.log(`[Price Update] DB Updated for ${itemId}`);
                        resolve();
                    }
                }
            );
        });

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Update item quantity
app.post('/update-quantity', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const { itemId, newQuantity } = req.body;
    if (!itemId || newQuantity === undefined) return res.status(400).json({ success: false, error: 'Missing params' });

    try {
        // 1. Get User ID
        const userRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
        const userId = userRes.data.id;

        // 2. Update API
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { available_quantity: parseInt(newQuantity) }, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });

        // 3. Update Local DB
        db.run(`UPDATE items_v14 SET available_quantity = ?, last_updated = ? WHERE id = ? AND user_id = ?`,
            [parseInt(newQuantity), new Date().toISOString(), itemId, userId],
            (err) => {
                if (err) console.error('Local DB Update Error:', err);
            }
        );

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/promotions', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.redirect('/');

    try {
        const userResponse = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userId = userResponse.data.id;

        // 1. Fetch available promotions v2
        const promotionsResponse = await axios.get(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const campaigns = promotionsResponse.data.results || [];

        // 2. Fetch candidates for the first active campaign (as a starting point)
        let candidates = [];
        let activeCampaignId = req.query.campaign_id || (campaigns.length > 0 ? campaigns[0].id : null);
        let activeCampaignType = req.query.type || (campaigns.length > 0 ? campaigns[0].type : null);

        let rawApiData = {};

        // Pagination and search setup (moved outside if block for scope)
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        const offset = (page - 1) * limit;
        const searchFilter = req.query.search || '';
        const sortBy = req.query.sort || 'name';

        // Build WHERE clause for search
        let whereClause = 'user_id = ?';
        let queryParams = [userId];

        if (searchQuery) {
            whereClause += ' AND (title LIKE ? OR id LIKE ? OR brand LIKE ?)';
            const searchPattern = `%${searchQuery}%`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        // Build ORDER BY clause
        let orderByClause = 'last_updated DESC'; // Default: most recent
        if (sortBy === 'sales') orderByClause = 'sold_quantity DESC NULLS LAST';
        if (sortBy === 'price_asc') orderByClause = 'price ASC';
        if (sortBy === 'price_desc') orderByClause = 'price DESC';

        // Get total count (with search filter) - moved outside if block
        const totalItems = await new Promise((resolve, reject) => {
            db.get(
                `SELECT COUNT(*) as count FROM items_v14 WHERE ${whereClause}`,
                queryParams,
                (err, row) => err ? reject(err) : resolve(row.count)
            );
        });

        const totalPages = Math.ceil(totalItems / perPage);
        console.log(`[Promotions] Total: ${totalItems} items, Page ${page}/${totalPages}, Search: "${searchQuery}"`);

        if (activeCampaignId) {
            console.log(`[Promotions] Fetching items for ID: ${activeCampaignId}, Type: ${activeCampaignType}`);

            const fetchByStatus = async (status) => {
                try {
                    const res = await axios.get(`https://api.mercadolibre.com/seller-promotions/promotions/${activeCampaignId}/items`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        params: { promotion_type: activeCampaignType, status, app_version: 'v2' }
                    });
                    rawApiData[status] = res.data;
                    return res.data.results || res.data.items || [];
                } catch (e) {
                    console.error(`[Promotions] API Error for ${status}:`, e.response?.data || e.message);
                    rawApiData[status + '_error'] = e.response?.data || e.message;
                    return [];
                }
            };

            // ===== NEW APPROACH: Load from DB, then enrich with promo data =====

            // Load paginated items from database (with search filter)
            const dbItems = await new Promise((resolve, reject) => {
                db.all(
                    `SELECT * FROM items_v14 WHERE ${whereClause} ORDER BY ${orderByClause} LIMIT ? OFFSET ?`,
                    [...queryParams, perPage, offset],
                    (err, rows) => {
                        if (err) {
                            console.error('[Promotions] DB Error:', err);
                            reject(err);
                        } else {
                            resolve(rows || []);
                        }
                    }
                );
            });

            console.log(`[Promotions] Loaded ${dbItems.length} items from database`);

            // 2. Fetch promotion info from API (per item, batched)
            const promoInfoMap = {};

            if (activeCampaignId && dbItems.length > 0) {
                console.log(`[Promotions] Fetching promo data for ${dbItems.length} items...`);

                // Batch fetch promo info for all items (limit to avoid timeout)
                const itemsToFetch = dbItems.slice(0, 100); // Process first 100 items

                for (const item of itemsToFetch) {
                    try {
                        const res = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${item.id}?app_version=v2`, {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        });

                        const promos = res.data || [];

                        // Find matching promotion for selected campaign
                        const matchingPromo = promos.find(p => p.id === activeCampaignId);

                        if (matchingPromo) {
                            promoInfoMap[item.id] = {
                                status: matchingPromo.status,
                                price: matchingPromo.price,
                                min: matchingPromo.min_discounted_price,
                                max: matchingPromo.max_discounted_price,
                                suggested: matchingPromo.suggested_discounted_price,
                                original: matchingPromo.original_price
                            };
                            rawApiData[`item_${item.id}`] = promos; // Store for debug
                        }
                    } catch (e) {
                        // Silently skip items that error (likely not eligible)
                        if (e.response?.status !== 404) {
                            console.error(`[Promotions] Error fetching promo for ${item.id}:`, e.message);
                        }
                    }
                }

                console.log(`[Promotions] Found ${Object.keys(promoInfoMap).length} items with promo data for campaign ${activeCampaignId}`);
            }

            // 3. Merge DB items with promo info and filter
            candidates = dbItems
                .map(item => {
                    // Parse attributes if stored as JSON string
                    let attributes = [];
                    try {
                        attributes = item.attributes ? JSON.parse(item.attributes) : [];
                    } catch (e) {
                        // If not JSON, create brand attribute from brand column
                        if (item.brand) {
                            attributes = [{ id: 'BRAND', value_name: item.brand }];
                        }
                    }

                    return {
                        id: item.id,
                        title: item.title,
                        thumbnail: item.thumbnail,
                        price: item.price,
                        attributes: attributes,
                        promo_info: promoInfoMap[item.id] || {}
                    };
                })
                .filter(item => {
                    // If campaign selected, only show items with promo info
                    if (activeCampaignId) {
                        return promoInfoMap[item.id] !== undefined;
                    }
                    // Otherwise show all items
                    return true;
                });

            console.log(`[Promotions] Showing ${candidates.length} candidates after filtering`);
        }

        const campaignsHtml = campaigns.map(c => `
            <div class="campaign-chip ${c.id === activeCampaignId ? 'active' : ''}" 
                 onclick="window.location.href='/promotions?campaign_id=${c.id}&type=${c.type}'">
                ${c.name || c.id} (${c.type})
            </div>
        `).join('');

        const candidatesHtml = candidates.map(item => {
            const brand = item.attributes?.find(a => a.id === 'BRAND')?.value_name || 'N/A';
            const info = item.promo_info || {};
            const isStarted = info.status === 'started';

            // Prepare data for the modal
            const modalData = JSON.stringify({
                id: item.id,
                title: item.title,
                original: item.price,
                min: info.min,
                max: info.max,
                suggested: info.suggested,
                current: info.price || info.suggested || (item.price * 0.9)
            }).replace(/"/g, '&quot;');

            return `
                <div class="promo-card" 
                     data-name="${item.title.toLowerCase()}" 
                     data-id="${item.id}" 
                     data-brand="${brand.toLowerCase()}">
                    <div class="promo-header">
                        <img src="${item.thumbnail}" alt="" class="promo-img">
                        <div class="promo-info">
                            <div class="promo-title">${item.title}</div>
                            <div class="promo-meta">ID: ${item.id} | Marca: ${brand}</div>
                        </div>
                    </div>
                    <div class="promo-price-row">
                        <div>
                            ${isStarted ? `
                                <div style="font-size: 0.7rem; color: #999; text-decoration: line-through;">Previo: $ ${item.price.toLocaleString('es-AR')}</div>
                                <div style="font-weight: 700; color: #00a650; font-size: 1.1rem;">$ ${info.price?.toLocaleString('es-AR') || '---'}</div>
                            ` : `
                                <div style="font-size: 0.75rem; color: #999;">Precio Actual</div>
                                <div style="font-weight: 600;">$ ${item.price.toLocaleString('es-AR')}</div>
                            `}
                        </div>
                        <button class="btn-participate" 
                                style="${isStarted ? 'background: #00a650;' : ''}"
                                onclick="openPromoModal(${modalData}, '${activeCampaignId}', '${activeCampaignType}')">
                            ${isStarted ? 'Participando' : 'Participar'}
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        const content = `
            <div class="card">
                <h2 style="margin-bottom: 20px;">Central de Promociones</h2>
                
                <!-- Search Bar -->
                <div style="margin-bottom: 25px;">
                    <div style="position: relative; max-width: 500px;">
                        <input 
                            type="text" 
                            id="promoSearchInput" 
                            value="${searchQuery}"
                            placeholder="🔍 Buscar por nombre, ID o marca..." 
                            style="width: 100%; padding: 12px 40px 12px 15px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 0.95rem; transition: all 0.2s;"
                            onfocus="this.style.borderColor='#3483fa'; this.style.boxShadow='0 0 0 3px rgba(52,131,250,0.1)'"
                            onblur="this.style.borderColor='#e0e0e0'; this.style.boxShadow='none'"
                            onkeypress="if(event.key==='Enter') performSearch()"
                        />
                        <button 
                            id="clearSearchBtn" 
                            onclick="clearPromoSearch()" 
                            style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: #999; cursor: pointer; font-size: 1.2rem; padding: 5px; display: none;"
                            title="Limpiar búsqueda"
                        >✕</button>
                    </div>
                    <div id="searchResultsCount" style="margin-top: 8px; font-size: 0.85rem; color: #666; display: none;"></div>
                </div>
                
                <!-- Sort Dropdown -->
                <div style="margin-bottom: 20px;">
                    <label style="font-weight: 500; color: #333; margin-right: 10px;">Ordenar por:</label>
                    <select id="sortBy" onchange="applySort()" style="padding: 8px 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 0.95rem; cursor: pointer; background: white;">
                        <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Más recientes</option>
                        <option value="sales" ${sortBy === 'sales' ? 'selected' : ''}>Más vendidos</option>
                        <option value="price_asc" ${sortBy === 'price_asc' ? 'selected' : ''}>Precio: menor a mayor</option>
                        <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Precio: mayor a menor</option>
                    </select>
                </div>
                
                <!-- Pagination Controls -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                    <button 
                        onclick="goToPage(${page - 1})" 
                        ${page === 1 ? 'disabled' : ''}
                        style="padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 6px; cursor: ${page === 1 ? 'not-allowed' : 'pointer'}; opacity: ${page === 1 ? '0.5' : '1'};"
                    >
                        ← Anterior
                    </button>
                    <span style="font-weight: 500; color: #666;">
                        Página ${page} de ${totalPages} (${totalItems} items${searchQuery ? ` - filtrado por "${searchQuery}"` : ''})
                    </span>
                    <button 
                        onclick="goToPage(${page + 1})" 
                        ${page >= totalPages ? 'disabled' : ''}
                        style="padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 6px; cursor: ${page >= totalPages ? 'not-allowed' : 'pointer'}; opacity: ${page >= totalPages ? '0.5' : '1'};"
                    >
                        Siguiente →
                    </button>
                </div>
                
                <div style="margin-bottom: 15px; font-weight: 600; color: var(--text-gray);">Campañas Disponibles:</div>
                <div class="campaigns-panel">
                    ${campaignsHtml || '<p style="color: #999; padding: 10px;">No hay campañas activas en este momento.</p>'}
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin: 30px 0 15px;">
                    <h3 style="margin: 0;">Productos Candidatos (${candidates.length})</h3>
                </div>

                ${candidates.length > 0 ? `
                    <div class="promos-grid">
                        ${candidatesHtml}
                    </div>
                ` : `
                    <div style="text-align: center; padding: 60px; background: #fdfdfd; border: 1px dashed #ddd; border-radius: 8px;">
                        <div style="font-size: 3rem; margin-bottom: 10px;">${activeCampaignId ? '🔍' : '🏷️'}</div>
                        <p style="color: #666;">
                            ${activeCampaignId
                ? 'No se encontraron productos elegibles para esta campaña. Puede que ya estén participando o no califiquen.'
                : 'Selecciona una campaña para ver los productos que pueden participar.'}
                        </p>
                    </div>
                `}

                <details style="margin-top: 40px; color: #ccc; font-size: 0.7rem; cursor: pointer; text-align: left;">
                    <summary>Debug API Info</summary>
                    <pre style="background: #f4f4f4; padding: 10px; color: #666; overflow: auto; max-height: 400px; margin-top: 10px; border-radius: 4px;">
Selected ID: ${activeCampaignId}
Selected Type: ${activeCampaignType}
Campaigns Count: ${campaigns.length}
Items Loaded: ${candidates.length}

--- RAW API DATA ---
${JSON.stringify(rawApiData, null, 2)}
                    </pre>
                </details>
            </div>

            <!-- Promotion Modal -->
            <div id="promoModal" class="modal-overlay">
                <div class="modal-box">
                    <div class="modal-header">
                        <div class="modal-title">Configurar Promoción</div>
                        <button class="close-modal" onclick="closePromoModal()">&times;</button>
                    </div>
                    
                    <div id="modalProductTitle" style="font-size: 0.9rem; margin-bottom: 20px; color: #666; font-weight: 500;"></div>

                    <div class="price-guidelines">
                        <div class="guideline-item">
                            <span class="guideline-label">Precio Original:</span>
                            <span class="guideline-value" id="guideOriginal">$ 0</span>
                        </div>
                        <div class="guideline-item">
                            <span class="guideline-label">Mínimo sugerido:</span>
                            <span class="guideline-value" id="guideMin">$ 0</span>
                        </div>
                        <div class="guideline-item">
                            <span class="guideline-label">Máximo permitido:</span>
                            <span class="guideline-value" id="guideMax">$ 0</span>
                        </div>
                        <div class="guideline-item" style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #ced4da;">
                            <span class="guideline-label">Sugerencia Meli:</span>
                            <span class="guideline-value suggested" id="guideSuggested">$ 0</span>
                        </div>
                    </div>

                    <div class="input-group">
                        <label class="input-label">Método de precio:</label>
                        <div style="display: flex; gap: 20px; margin-bottom: 10px;">
                            <label style="display: flex; align-items: center; cursor: pointer;">
                                <input type="radio" name="priceMethod" value="fixed" checked style="margin-right: 5px;">
                                Precio fijo
                            </label>
                            <label style="display: flex; align-items: center; cursor: pointer;">
                                <input type="radio" name="priceMethod" value="percentage" style="margin-right: 5px;">
                                Porcentaje de descuento
                            </label>
                        </div>
                    </div>

                    <div class="input-group">
                        <label class="input-label" id="priceInputLabel">Tu precio de oferta:</label>
                        <div class="modal-input-wrapper">
                            <input type="number" id="promoDealPrice" class="modal-input" placeholder="0.00">
                            <input type="number" id="promoPercentage" class="modal-input" placeholder="15" style="display: none;" min="0" max="100">
                            <span id="percentageSign" style="display: none; position: absolute; right: 15px; top: 50%; transform: translateY(-50%); color: #666; font-weight: 500;">%</span>
                        </div>
                        <div id="calculatedPrice" style="margin-top: 8px; font-size: 0.9rem; color: #28a745; display: none;">
                            Precio final: <strong>$ <span id="finalPriceDisplay">0</span></strong>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button class="btn-modal btn-modal-cancel" onclick="closePromoModal()">Cancelar</button>
                        <button id="btnConfirmPromo" class="btn-modal btn-modal-confirm">Confirmar Oferta</button>
                    </div>
                </div>
            </div>

            <script>
                let currentPromoData = null;

                window.openPromoModal = function(data, promoId, promoType) {
                    currentPromoData = { ...data, promoId, promoType };
                    
                    document.getElementById('modalProductTitle').textContent = data.title;
                    document.getElementById('guideOriginal').textContent = '$ ' + (data.original?.toLocaleString() || '---');
                    document.getElementById('guideMin').textContent = '$ ' + (data.min?.toLocaleString() || '---');
                    document.getElementById('guideMax').textContent = '$ ' + (data.max?.toLocaleString() || '---');
                    document.getElementById('guideSuggested').textContent = '$ ' + (data.suggested?.toLocaleString() || '---');
                    
                    // Reset to fixed price method
                    document.querySelector('input[name="priceMethod"][value="fixed"]').checked = true;
                    document.getElementById('promoDealPrice').style.display = 'block';
                    document.getElementById('promoPercentage').style.display = 'none';
                    document.getElementById('percentageSign').style.display = 'none';
                    document.getElementById('calculatedPrice').style.display = 'none';
                    document.getElementById('priceInputLabel').textContent = 'Tu precio de oferta:';
                    
                    document.getElementById('promoDealPrice').value = data.current || data.suggested || data.original;
                    document.getElementById('promoPercentage').value = '';
                    
                    document.getElementById('promoModal').style.display = 'flex';
                };

                // Toggle between fixed price and percentage
                document.querySelectorAll('input[name="priceMethod"]').forEach(radio => {
                    radio.addEventListener('change', function() {
                        const fixedInput = document.getElementById('promoDealPrice');
                        const percentInput = document.getElementById('promoPercentage');
                        const percentSign = document.getElementById('percentageSign');
                        const calcPrice = document.getElementById('calculatedPrice');
                        const label = document.getElementById('priceInputLabel');
                        
                        if (this.value === 'percentage') {
                            fixedInput.style.display = 'none';
                            percentInput.style.display = 'block';
                            percentSign.style.display = 'block';
                            calcPrice.style.display = 'block';
                            label.textContent = 'Porcentaje de descuento:';
                            // Trigger calculation if value exists
                            if (percentInput.value) {
                                updateCalculatedPrice();
                            }
                        } else {
                            fixedInput.style.display = 'block';
                            percentInput.style.display = 'none';
                            percentSign.style.display = 'none';
                            calcPrice.style.display = 'none';
                            label.textContent = 'Tu precio de oferta:';
                        }
                    });
                });

                // Calculate price from percentage
                function updateCalculatedPrice() {
                    const percentage = parseFloat(document.getElementById('promoPercentage').value);
                    if (isNaN(percentage) || percentage < 0 || percentage > 100) {
                        document.getElementById('finalPriceDisplay').textContent = '0';
                        return;
                    }
                    const originalPrice = currentPromoData.original || 0;
                    const finalPrice = Math.round(originalPrice * (1 - percentage / 100));
                    document.getElementById('finalPriceDisplay').textContent = finalPrice.toLocaleString('es-AR');
                }

                // Update calculation on input
                document.getElementById('promoPercentage').addEventListener('input', updateCalculatedPrice);

                window.closePromoModal = function() {
                    document.getElementById('promoModal').style.display = 'none';
                };

                document.getElementById('btnConfirmPromo').onclick = async function() {
                    const method = document.querySelector('input[name="priceMethod"]:checked').value;
                    let price;
                    
                    if (method === 'percentage') {
                        const percentage = parseFloat(document.getElementById('promoPercentage').value);
                        if (isNaN(percentage) || percentage < 0 || percentage > 100) {
                            return alert('Por favor ingrese un porcentaje válido (0-100).');
                        }
                        const originalPrice = currentPromoData.original || 0;
                        price = Math.round(originalPrice * (1 - percentage / 100));
                    } else {
                        price = parseFloat(document.getElementById('promoDealPrice').value);
                    }
                    
                    if (!price || isNaN(price)) return alert('Por favor ingrese un precio válido.');

                    const btn = this;
                    btn.disabled = true;
                    btn.textContent = 'Enviando...';

                    try {
                        const response = await fetch('/apply-promotion', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                item_id: currentPromoData.id,
                                promotion_id: currentPromoData.promoId,
                                promotion_type: currentPromoData.promoType,
                                deal_price: price
                            })
                        });
                        
                        const result = await response.json();
                        if (result.success) {
                            alert('¡Éxito! La promoción se ha configurado correctamente.');
                            location.reload();
                        } else {
                            alert('Error: ' + result.error);
                            btn.disabled = false;
                            btn.textContent = 'Confirmar Oferta';
                        }
                    } catch (error) {
                        alert('Error al aplicar la promoción: ' + error.message);
                        btn.disabled = false;
                        btn.textContent = 'Confirmar Oferta';
                    }
                };

                // Close modal on escape key
                window.onkeydown = function(e) {
                    if (e.key === 'Escape') closePromoModal();
                };

                // ===== SEARCH & PAGINATION FUNCTIONALITY =====
                
                // Server-side search (reloads page with search query)
                function performSearch() {
                    const query = document.getElementById('promoSearchInput').value.trim();
                    const url = new URL(window.location);
                    if (query) {
                        url.searchParams.set('search', query);
                    } else {
                        url.searchParams.delete('search');
                    }
                    url.searchParams.set('page', '1'); // Reset to page 1 on new search
                    window.location.href = url.toString();
                }

                // Clear search
                window.clearPromoSearch = function() {
                    const url = new URL(window.location);
                    url.searchParams.delete('search');
                    url.searchParams.set('page', '1');
                    window.location.href = url.toString();
                };

                // Navigate to page
                window.goToPage = function(page) {
                    if (page < 1) return;
                    const url = new URL(window.location);
                    url.searchParams.set('page', page);
                    window.location.href = url.toString();
                };

                // Apply sort order
                window.applySort = function() {
                    const sortValue = document.getElementById('sortBy').value;
                    const url = new URL(window.location);
                    url.searchParams.set('sort', sortValue);
                    url.searchParams.set('page', '1'); // Reset to page 1 on sort change
                    window.location.href = url.toString();
                };

                // Show/hide clear button based on search value
                document.addEventListener('DOMContentLoaded', function() {
                    const searchInput = document.getElementById('promoSearchInput');
                    const clearBtn = document.getElementById('clearSearchBtn');
                    
                    if (searchInput && clearBtn) {
                        // Show clear button if there's a search value
                        clearBtn.style.display = searchInput.value ? 'block' : 'none';
                        
                        // Update clear button visibility on input
                        searchInput.addEventListener('input', function() {
                            clearBtn.style.display = this.value ? 'block' : 'none';
                        });
                    }
                });
            </script>
        `;

        res.send(renderPage('Promociones', content, 'promotions'));

    } catch (error) {
        console.error('Promotions Error:', error.message);
        res.status(500).send(renderDebugError('Error en Promociones', 'No se pudieron cargar las promociones.', {
            message: error.message,
            api_response: error.response?.data
        }));
    }
});

app.post('/apply-promotion', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { item_id, promotion_id, promotion_type, deal_price } = req.body;

    const makeRequest = async (pType, status) => {
        // Use POST for candidates (creating offer), PUT for started (updating offer)
        const method = status === 'started' ? 'put' : 'post';
        const action = status === 'started' ? 'Updating' : 'Creating';

        console.log(`[Promo] ${action} offer (${method.toUpperCase()}) for status: ${status || 'unknown'}`);

        return axios[method](`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
            promotion_id,
            promotion_type: pType,
            deal_price
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
    };

    // Declare at function scope so catch block can access them
    let authoritativeType = promotion_type;
    let availablePromotions = [];
    let promoStatus = null; // Track if candidate or started

    try {
        // 1. Fetch available promotions for this item to get authoritative Type
        console.log(`[Promo] Validating data for Item: ${item_id}, Promo ID: ${promotion_id}`);

        try {
            const infoRes = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            availablePromotions = infoRes.data || [];

            // Find the matching promotion
            const matchingPromo = availablePromotions.find(p => p.id === promotion_id);
            if (matchingPromo) {
                console.log(`[Promo] Found authoritative match. Type: ${authoritativeType} -> ${matchingPromo.type}, Status: ${matchingPromo.status}`);
                authoritativeType = matchingPromo.type;
                promoStatus = matchingPromo.status; // Store status
            } else {
                console.warn(`[Promo] Warning: Promo ID ${promotion_id} not found in live item data. Using provided type.`);
            }
        } catch (fetchErr) {
            console.error('[Promo] Failed to fetch live item info:', fetchErr.message);
            // Continue with provided type as fallback
        }

        // HEURISTIC FIX: Map generic statuses to API Types
        if (authoritativeType === 'campaign') authoritativeType = 'MARKETPLACE_CAMPAIGN';

        // 2. Make the request with authoritative type and status
        let lastError;
        try {
            console.log(`[Promo] Sending request. Type: ${authoritativeType}, Status: ${promoStatus || 'unknown'}`);
            await makeRequest(authoritativeType, promoStatus);
        } catch (err1) {
            lastError = err1;
            console.error('[Promo] Attempt 1 Failed:', err1.response?.data || err1.message);

            // Attempt 2: Retry with Uppercase
            if (authoritativeType && authoritativeType !== authoritativeType.toUpperCase()) {
                try {
                    console.log(`[Promo] Retrying with uppercase type: ${authoritativeType.toUpperCase()}`);
                    await makeRequest(authoritativeType.toUpperCase(), promoStatus);
                    lastError = null; // Success
                } catch (err2) {
                    lastError = err2;
                }
            }
        }

        if (lastError) throw lastError;

        // Update DB immediately (wrapped in Promise)
        await new Promise((resolve, reject) => {
            db.run(`UPDATE items_v14 SET sale_price_amount = ?, last_updated = ? WHERE id = ?`,
                [parseFloat(deal_price), new Date().toISOString(), item_id], (err) => {
                    if (err) {
                        console.error('DB Update Error:', err);
                        // Don't fail the request if DB fails, but log it
                        resolve();
                    } else {
                        resolve();
                    }
                });
        });

        res.json({ success: true });
    } catch (error) {
        // Construct verbose error for client debugging
        const debugInfo = {
            message: error.response?.data?.message || error.message,
            tried_type: promotion_type,
            guessed_type: authoritativeType,
            available_promos: availablePromotions,
            api_error: error.response?.data
        };
        console.error('Apply Promo Final Error:', JSON.stringify(debugInfo));
        res.status(500).json({
            success: false,
            error: JSON.stringify(debugInfo) // Send JSON as string to ensure it shows in alert
        });
    }
});

app.post('/sync-listings', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    try {
        const userRes = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userId = userRes.data.id;

        // 1. Fetch all item IDs using scan (to support > 1000 items)
        let itemIds = [];
        let scrollId = null;
        let hasMore = true;

        while (hasMore) {
            const params = {
                status: 'active,paused,closed',
                search_type: 'scan',
                limit: 100
            };
            if (scrollId) params.scroll_id = scrollId;

            const searchRes = await axios.get(`https://api.mercadolibre.com/users/${userId}/items/search`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: params
            });

            const results = searchRes.data.results || [];
            if (results.length > 0) {
                itemIds = itemIds.concat(results);
                scrollId = searchRes.data.scroll_id;
            } else {
                hasMore = false;
            }

            // Safety break
            if (itemIds.length > 50000) break;
        }

        console.log(`[Sync] Found ${itemIds.length} items to sync.`);

        // 2. Process in batches of 20 (API Limit)
        const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
        const batches = chunkArray(itemIds, 20);
        let processedCount = 0;

        for (const batch of batches) {
            // A. Fetch Item Details including Attributes for Brand
            const itemsRes = await axios.get(`https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=id,title,thumbnail,price,currency_id,available_quantity,original_price,permalink,status,listing_type_id,shipping,attributes,sold_quantity`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            const strategies = itemsRes.data.map(async (r) => {
                if (!r.body || r.code !== 200) return null;
                const item = r.body;

                // B. Fetch Sale Price AND Promotion Data (Parallel)
                let salePrice = null;
                let saleOriginal = null;
                let promoId = null;
                let promoType = null;
                let promoName = null;

                try {
                    // Fetch active promotion from seller-promotions endpoint
                    const promoRes = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${item.id}?app_version=v2`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }).catch(() => ({ data: [] }));

                    // Find the active/started promotion
                    const activePromo = promoRes.data?.find(p => p.status === 'started');
                    if (activePromo) {
                        promoId = activePromo.id;
                        promoType = activePromo.type;
                        promoName = activePromo.name || activePromo.campaign_name || null;
                        salePrice = activePromo.price;
                        saleOriginal = activePromo.original_price;
                        console.log(`[Sync] Found active promo for ${item.id}: ${promoId} (${promoType}) name: ${promoName}`);
                    } else {
                        // Fallback to sale_price endpoint if no active promo found
                        const spRes = await axios.get(`https://api.mercadolibre.com/items/${item.id}/sale_price`, {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        }).catch(() => ({ data: {} }));
                        if (spRes.data?.amount) {
                            salePrice = spRes.data.amount;
                            saleOriginal = spRes.data.regular_amount;
                            promoId = spRes.data.metadata?.promotion_id;
                            promoType = spRes.data.metadata?.promotion_type;
                            promoName = spRes.data.metadata?.name || spRes.data.metadata?.campaign_name || null;
                        }
                    }
                } catch (e) {
                    console.error(`[Sync] Error fetching promo for ${item.id}:`, e.message);
                }

                // C. Extra Data
                const freeShipping = item.shipping?.free_shipping ? 1 : 0;
                const brandAttr = item.attributes?.find(a => a.id === 'BRAND')?.value_name || '';
                const soldQty = item.sold_quantity || 0;

                return {
                    id: item.id,
                    title: item.title,
                    thumbnail: item.thumbnail,
                    price: item.price,
                    currency_id: item.currency_id,
                    available_quantity: item.available_quantity,
                    original_price: item.original_price,
                    permalink: item.permalink,
                    status: item.status,
                    listing_type_id: item.listing_type_id,
                    sale_price_amount: salePrice,
                    sale_price_regular_amount: saleOriginal,
                    promotion_id: promoId,
                    promotion_type: promoType,
                    promotion_name: promoName,
                    price_to_win: 0, // Placeholder
                    last_updated: new Date().toISOString(),
                    free_shipping: freeShipping,
                    brand: brandAttr,
                    sold_quantity: soldQty
                };
            });

            const processedItems = (await Promise.all(strategies)).filter(i => i !== null);

            // D. Upsert to DB with user_id
            const stmt = db.prepare(`INSERT OR REPLACE INTO items_v14 (id, user_id, title, thumbnail, price, currency_id, available_quantity, original_price, permalink, status, listing_type_id, sale_price_amount, sale_price_regular_amount, promotion_id, promotion_type, price_to_win, last_updated, free_shipping, brand, sold_quantity, promotion_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                processedItems.forEach(item => {
                    stmt.run(item.id, userId, item.title, item.thumbnail, item.price, item.currency_id, item.available_quantity, item.original_price, item.permalink, item.status, item.listing_type_id, item.sale_price_amount, item.sale_price_regular_amount, item.promotion_id, item.promotion_type, item.price_to_win, item.last_updated, item.free_shipping, item.brand, item.sold_quantity, item.promotion_name);
                });
                db.run("COMMIT");
            });
            stmt.finalize();

            processedCount += processedItems.length;
            console.log(`[Sync] Processed ${processedCount}/${itemIds.length} items`);
        }

        res.json({ success: true, count: processedCount });

    } catch (error) {
        console.error('Sync Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Unknown Sync Error',
            details: error.response?.data
        });
    }
});

app.get('/debug-suggestions/:id', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).send('No token found. Please login first.');
    const itemId = req.params.id;
    try {
        const userRes = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userId = userRes.data.id;

        // This endpoint might be different depending on MLA or other sites, but we'll try what the user suggested
        const sugUserItemsRes = await axios.get(`https://api.mercadolibre.com/suggestions/user/${userId}/items`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        }).catch(e => ({ data: { error: e.message } }));

        const sugDetailsRes = await axios.get(`https://api.mercadolibre.com/suggestions/items/${itemId}/details`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        }).catch(e => ({ data: { error: e.message } }));

        const result = {
            userId,
            itemId,
            suggestions_user_items: sugUserItemsRes.data,
            suggestions_item_details: sugDetailsRes.data
        };

        console.log(`[Debug API] Results for ${itemId}:`, JSON.stringify(result, null, 2));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('access_token');
    res.redirect('/');
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
