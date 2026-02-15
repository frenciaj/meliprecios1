const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
// const schedule = require('node-schedule');

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

db.serialize(() => {
    db.serialize(() => {
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

        db.run(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            promotion_id TEXT,
            user_id TEXT,
            promotion_type TEXT,
            execute_at DATETIME,
            status TEXT, -- 'pending', 'completed', 'failed'
            access_token TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Migration: Add sold_quantity column if it doesn't exist
        db.run(`ALTER TABLE items_v14 ADD COLUMN sold_quantity INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                // console.error('[Migration] Error adding sold_quantity:', err.message);
            }
        });

        // Migration: Add promotion_name column if it doesn't exist
        db.run(`ALTER TABLE items_v14 ADD COLUMN promotion_name TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                // console.error('[Migration] Error adding promotion_name:', err.message);
            }
        });

        // Migration: Add access_token to scheduled_tasks
        db.run(`ALTER TABLE scheduled_tasks ADD COLUMN access_token TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                // console.error('[Migration] Error adding access_token:', err.message);
            }
        });
    });
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

// Load and helper for scheduling
// const activeJobs = new Map();

function scheduleRemovalJob(taskId, promoId, promoType, executeAt, accessToken, userId) {
    // Legacy function placeholder - removed for Serverless compatibility
    console.log(`[Schedule] Task ${taskId} saved to DB for Cron execution.`);
}

async function executeRemoval(promoId, promoType, accessToken, taskId) {
    // 1. Fetch items
    let allItems = [];
    let offset = 0;
    let limit = 50;
    let total = 0;
    let pages = 0;
    const failSafeLimit = 10;
    const pType = promoType || 'SELLER_CAMPAIGN';

    try {
        do {
            const itemsRes = await axios.get(
                `https://api.mercadolibre.com/seller-promotions/promotions/${promoId}/items?promotion_type=${pType}&status=started&app_version=v2&limit=${limit}&offset=${offset}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            const results = itemsRes.data.results || itemsRes.data || [];
            allItems = allItems.concat(results);
            total = itemsRes.data.paging?.total || results.length;
            offset += limit;
            pages++;
        } while (allItems.length < total && pages < failSafeLimit);

        console.log(`[Job ${taskId}] Found ${allItems.length} items to remove.`);

        // 2. Remove items
        let removedCount = 0;
        let errorCount = 0;
        const chunkSize = 5; // Batch requests

        for (let i = 0; i < allItems.length; i += chunkSize) {
            const chunk = allItems.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (item) => {
                const itemId = item.id || item; // Handle string vs object
                try {
                    await axios.delete(
                        `https://api.mercadolibre.com/seller-promotions/items/${itemId}?promotion_type=${pType}&promotion_id=${promoId}&app_version=v2`,
                        { headers: { Authorization: `Bearer ${accessToken}` } }
                    );
                    removedCount++;
                } catch (e) {
                    // console.error(`[Job ${taskId}] Error removing ${itemId}:`, e.message);
                    errorCount++;
                }
            }));
        }

        console.log(`[Job ${taskId}] Finished. Removed: ${removedCount}, Errors: ${errorCount}`);

        // Mark as completed
        db.run('UPDATE scheduled_tasks SET status = "completed" WHERE id = ?', [taskId]);

    } catch (error) {
        console.error(`[Job ${taskId}] Error executing:`, error.message);
        db.run('UPDATE scheduled_tasks SET status = "failed" WHERE id = ?', [taskId]);
    }
}

// On Startup, check for pending jobs (won't work well without stored tokens, but good structure)
// Since we don't store refresh tokens, persistent jobs across restarts are tricky unless we re-auth.
// For now, we'll only support in-memory duration of the process, but save to DB for record.
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
        <a href="/promotions-summary" class="tab-link ${activeTab === 'promotions_summary' ? 'active' : ''}">Promociones</a>
        <a href="/create-promotion-ui" class="tab-link ${activeTab === 'create_promotion' ? 'active' : ''}">Crear Promoción</a>
    </nav>

    <div class="container">
        ${content}
    </div>
    <footer style="text-align: center; color: #999; margin-top: 40px; font-size: 0.8rem;">
        <div>Creado por Tatan. Todos los Derechos Reservados &copy; ${new Date().getFullYear()}</div>
        <div style="margin-top: 5px;">v14.4.6 - Daily Cron Fix - ${new Date().toISOString()}</div>
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

app.get('/debug-promo/:id', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: 'No access token' });

    try {
        const { id } = req.params;
        const promoRes = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json(promoRes.data);
    } catch (error) {
        console.error('Debug Promo Error:', error.response?.data || error.message);
        res.status(500).json({ error: error.message, details: error.response?.data });
    }
});

app.post('/apply-promotion', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { item_id, promotion_id, promotion_type, deal_price } = req.body;

    if (!item_id || !promotion_id || !promotion_type) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    try {
        console.log(`[Promo] Applying ${promotion_type} (${promotion_id}) to ${item_id} at $${deal_price}`);

        const url = `https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`;

        const payload = {
            promotion_id,
            promotion_type,
            deal_price: parseFloat(deal_price)
        };

        const apiRes = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Update Local DB so UI reflects the new promo state immediately
        db.run(`UPDATE items_v14 SET promotion_id = ?, promotion_type = ? WHERE id = ?`,
            [promotion_id, promotion_type, item_id],
            (err) => {
                if (err) console.error('DB Promo Update Error:', err);
                else console.log(`[Promo] Updated local DB for ${item_id}`);
            }
        );

        res.json({ success: true, api_response: apiRes.data });

    } catch (error) {
        console.error('Apply Promo Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
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
        const sortBy = req.query.sort || 'sales';

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
            let orderByClause = 'sold_quantity DESC'; // Default: Most Sold
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
                                            <div style="display: flex; align-items: center; gap: 5px;">
                                                <div style="color: #00a650; font-weight: 700; font-size: 1.1rem;">$ <span class="promo-value-text">${currentPrice.toLocaleString('es-AR')}</span></div>
                                                <button class="add-promo-btn" onclick="openAddPromoModal('${item.id}', ${item.price})" title="Agregar Promoción" style="border: none; background: #e6f7ee; color: #00a650; font-weight: bold; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;">+</button>
                                            </div>
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
                                ` : `
                                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;">

                                        <button class="add-promo-btn" onclick="openAddPromoModal('${item.id}', ${item.price})" title="Agregar Promoción" style="border: none; background: #e6f7ee; color: #00a650; font-weight: bold; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;">+</button>
                                    </div>
                                `}
                            </td>
                            <td class="net-income-cell" id="net-income-${item.id}" data-ship-fee="${shipFee}" data-sale-fee="${saleFee}" data-current-price="${currentPrice}">
                                <span class="net-income-value">${netIncomeFormatted}</span>
                                <div class="fee-tooltip">
                                     <div class="tooltip-title">Detalle de Costos</div>
                                     <div class="tooltip-row"><span class="tooltip-label">Venta:</span><span class="tooltip-value param-price">$ ${currentPrice.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row"><span class="tooltip-label">Cargos:</span><span class="tooltip-value minus param-fee">-$ ${saleFee.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row"><span class="tooltip-label">Envío:</span><span class="tooltip-value minus param-ship">-$ ${shipFee.toLocaleString('es-AR')}</span></div>
                                     <div class="tooltip-row total"><span class="tooltip-label">Recibís:</span><span class="tooltip-value param-net" style="color: ${netIncomeColor};">${netIncomeFormatted}</span></div>
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
                        
                        <!-- Add Promo Modal -->
                        <div id="add-promo-modal" class="modal-overlay">
                            <div class="modal-box">
                                <div class="modal-header">
                                    <div class="modal-title">Agregar Promoción</div>
                                    <button class="close-modal" onclick="closeAddPromoModal()">×</button>
                                </div>
                                <div id="promo-candidates-list">
                                    <div style="text-align: center; color: #666; padding: 20px;">Cargando promociones...</div>
                                </div>
                                <div id="promo-config-section" style="display: none; border-top: 1px solid #eee; padding-top: 15px;">
                                    <h3 style="font-size: 1rem; margin-bottom: 10px;">Configurar Oferta</h3>
                                    <div style="display: flex; gap: 15px;">
                                        <div class="input-group" style="flex: 1;">
                                            <label class="input-label">Nuevo Precio</label>
                                            <div class="modal-input-wrapper">
                                                <input type="number" id="new-promo-price" class="modal-input" placeholder="0.00" oninput="syncPriceToPercentage()">
                                            </div>
                                        </div>
                                        <div class="input-group" style="flex: 1;">
                                            <label class="input-label">% Descuento</label>
                                            <div class="modal-input-wrapper no-currency" style="position: relative;">
                                                <input type="number" id="new-promo-percent" class="modal-input" placeholder="0" oninput="syncPercentageToPrice()">
                                                <span style="position: absolute; right: 15px; top: 50%; transform: translateY(-50%); color: #999;">%</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div id="promo-guidelines" style="margin-bottom: 20px; font-size: 0.85rem; color: #666; background: #f8f9fa; padding: 10px; border-radius: 6px; display: none;">
                                        <div>Original: <strong id="guideline-original">$-</strong></div>
                                        <div>Sugerido: <strong id="guideline-suggested" style="color: #00a650;">$-</strong></div>
                                    </div>
                                </div>
                                <div class="modal-footer">
                                    <button class="btn-modal btn-modal-cancel" onclick="closeAddPromoModal()">Cancelar</button>
                                    <button class="btn-modal btn-modal-confirm" onclick="submitJoinPromo()" disabled id="btn-join-promo">Unirse</button>
                                </div>
                            </div>
                        </div>


                        <script>
                            async function syncListings() {
                                const btn = document.getElementById('sync-btn');
                                const originalText = btn.innerHTML;
                                btn.disabled = true;
                                btn.innerHTML = '⏳ Syncing...';
                                
                                try {
                                    const version = 'v12.61';
                                    const footerDescription = 'Listing Manager & Repricer - Fix Button Visibility';
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
                                const container = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"]');
                                const input = container.querySelector('.price-input');
                                const newPrice = input.value;
                                const btn = container.querySelector('.save-price-btn');
                                
                                btn.disabled = true;
                                btn.innerHTML = '...';

                                try {
                                    const controller = new AbortController();
                                    const timeoutId = setTimeout(() => controller.abort(), 15000); 

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
                                        // Optmistic Update: Update DOM directly to avoid reload lag
                                        const displaySpan = container.querySelector('.price-value');
                                        const formatted = parseFloat(newPrice).toLocaleString('es-AR');
                                        displaySpan.textContent = '$ ' + formatted;
                                        
                                        // Update Input Value (for next edit)
                                        input.value = newPrice;
                                        // Also update attribute for consistency
                                        input.setAttribute('value', newPrice);

                                        cancelEdit(itemId);
                                        btn.innerHTML = '✓';
                                        
                                        // Dynamic Net Income Update
                                        updateNetIncome(itemId, parseFloat(newPrice));
                                    } else {
                                        alert('Error updating price: ' + data.error);
                                        btn.innerHTML = '✓';
                                    }
                                } catch (e) {
                                    if (e.name === 'AbortError') {
                                        alert('Error: Request timed out.');
                                    } else {
                                        alert('Error: ' + e.message);
                                    }
                                    btn.innerHTML = '✓';
                                } finally {
                                    btn.disabled = false;
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
                                        const data = await res.json();
                                        if (data.success) {
                                            const displaySpan = container.querySelector('.promo-value-text');
                                            const formatted = newPrice.toLocaleString('es-AR');
                                            displaySpan.textContent = formatted;
                                            input.value = newPrice;
                                            cancelPromoEdit(itemId);
                                            btn.innerHTML = '✓';
                                            
                                            // Dynamic Net Income Update
                                            updateNetIncome(itemId, newPrice);
                                        } else {
                                            location.reload();
                                        }
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

                            // --- Add Promotion Logic ---
                            // --- Add Promotion Logic (Safely Rewritten) ---
                            async function openAddPromoModal(itemId, currentPrice) {
                                console.log('Open Modal', itemId);
                                const modal = document.getElementById('add-promo-modal');
                                const listContainer = document.getElementById('promo-candidates-list');
                                const configSection = document.getElementById('promo-config-section');
                                const joinBtn = document.getElementById('btn-join-promo');
                                
                                document.body.style.overflow = 'hidden'; // Lock background scrolling
                                modal.style.display = 'flex';
                                listContainer.innerHTML = '';
                                const loading = document.createElement('div');
                                loading.textContent = 'Cargando promociones...';
                                loading.style.padding = '20px';
                                loading.style.textAlign = 'center';
                                listContainer.appendChild(loading);

                                configSection.style.display = 'none';
                                joinBtn.disabled = true;
                                
                                modal.dataset.itemId = itemId;
                                modal.dataset.originalPrice = currentPrice;

                                try {
                                    const res = await fetch('/debug-promo/' + itemId);
                                    const promos = await res.json();
                                    
                                    listContainer.innerHTML = ''; // Clear loading

                                    // Debug Display
                                    const debugDetails = document.createElement('details');
                                    const summary = document.createElement('summary');
                                    summary.textContent = 'Ver JSON Respuesta';
                                    summary.style.fontSize = '0.8rem';
                                    summary.style.color = '#999';
                                    summary.style.cursor = 'pointer';
                                    debugDetails.appendChild(summary);
                                    
                                    const pre = document.createElement('pre');
                                    pre.style.fontSize = '10px';
                                    pre.style.maxHeight = '100px';
                                    pre.style.overflow = 'auto';
                                    pre.textContent = JSON.stringify(promos, null, 2);
                                    debugDetails.appendChild(pre);
                                    listContainer.appendChild(debugDetails);

                                    renderPromoCandidates(promos);
                                } catch (e) {
                                    listContainer.innerHTML = '';
                                    const errDiv = document.createElement('div');
                                    errDiv.style.color = 'red';
                                    errDiv.textContent = 'Error: ' + e.message;
                                    listContainer.appendChild(errDiv);
                                }
                            }

                            function renderPromoCandidates(promos) {
                                const list = document.getElementById('promo-candidates-list');
                                // Determine array
                                let candidates = [];
                                if (Array.isArray(promos)) candidates = promos;
                                else if (promos.results && Array.isArray(promos.results)) candidates = promos.results;
                                else if (promos.id) candidates = [promos];

                                if (candidates.length === 0) {
                                    const msg = document.createElement('div');
                                    msg.textContent = 'No suitable promotions found.';
                                    msg.style.padding = '20px';
                                    msg.style.textAlign = 'center';
                                    list.appendChild(msg);
                                    return;
                                }

                                candidates.forEach(p => {
                                    const row = document.createElement('div');
                                    row.style.padding = '10px';
                                    row.style.borderBottom = '1px solid #eee';
                                    row.style.display = 'flex';
                                    row.style.justifyContent = 'space-between';
                                    row.style.alignItems = 'center';

                                    const info = document.createElement('div');
                                    const nameDiv = document.createElement('div');
                                    nameDiv.textContent = p.name || p.id || 'Promo';
                                    nameDiv.style.fontWeight = '600';
                                    
                                    const typeDiv = document.createElement('div');
                                    typeDiv.textContent = 'Type: ' + (p.type || 'N/A');
                                    typeDiv.style.fontSize = '0.8rem';
                                    typeDiv.style.color = '#666';

                                    info.appendChild(nameDiv);
                                    info.appendChild(typeDiv);

                                    const radio = document.createElement('input');
                                    radio.type = 'radio';
                                    radio.name = 'selectedPromo';
                                    radio.value = p.id;
                                    // Pass full object to handler
                                    radio.onchange = function() { selectPromoCandidate(p); };

                                    row.appendChild(info);
                                    row.appendChild(radio);
                                    list.appendChild(row);
                                });
                            }

                            function selectPromoCandidate(promo) {
                                console.log('Selected', promo);
                                const modal = document.getElementById('add-promo-modal');
                                modal.dataset.selectedPromoId = promo.id;
                                modal.dataset.selectedPromoType = promo.type;
                                modal.dataset.selectedPromoName = promo.name || promo.id;
                                
                                // Store Original Price for calculations
                                // Try to find it in promo properties (depending on API response structure)
                                // Standard items usually have original_price or we use the item's current price.
                                let originalPrice = parseFloat(modal.dataset.originalPrice) || 0;
                                if (promo.original_price) originalPrice = promo.original_price;

                                modal.dataset.calcOriginalPrice = originalPrice;
                                modal.dataset.originalPrice = originalPrice; // Ensure robust downstream use

                                // Show Guidelines
                                const guidelines = document.getElementById('promo-guidelines');
                                guidelines.style.display = 'block';
                                document.getElementById('guideline-original').textContent = '$ ' + originalPrice.toLocaleString('es-AR');
                                
                                // Suggested?
                                let suggestedValue = 0;
                                if (promo.min_discounted_price) suggestedValue = promo.min_discounted_price;
                                
                                if (suggestedValue > 0) {
                                    // User feedback: suggestedValue is the DISCOUNT AMOUNT, not the final price.
                                    // So Target Price = Original - DiscountAmount
                                    const targetPrice = originalPrice - suggestedValue;
                                    const offPercent = (suggestedValue / originalPrice) * 100;
                                    
                                    document.getElementById('guideline-suggested').innerHTML = 
                                        'Target: <strong>$' + targetPrice.toLocaleString('es-AR') + '</strong> ' +
                                        '<span style="color: #00a650;">(' + Math.round(offPercent) + '% OFF)</span> ' +
                                        '<small style="color: #999;">(Desc: $' + suggestedValue.toLocaleString('es-AR') + ')</small>';
                                } else {
                                     document.getElementById('guideline-suggested').textContent = '-';
                                }

                                document.getElementById('promo-config-section').style.display = 'block';
                                document.getElementById('btn-join-promo').disabled = false;
                                
                                // Reset inputs
                                document.getElementById('new-promo-price').value = '';
                                document.getElementById('new-promo-percent').value = '';
                                document.getElementById('new-promo-price').focus();
                            }

                            function syncPriceToPercentage() {
                                const priceInput = document.getElementById('new-promo-price');
                                const percentInput = document.getElementById('new-promo-percent');
                                const modal = document.getElementById('add-promo-modal');
                                const original = parseFloat(modal.dataset.calcOriginalPrice) || 0;

                                if (!original) return;

                                const price = parseFloat(priceInput.value);
                                if (!isNaN(price)) {
                                    // Percent = (Original - Price) / Original
                                    const percent = ((original - price) / original) * 100;
                                    percentInput.value = percent.toFixed(1); 
                                } else {
                                    percentInput.value = '';
                                }
                            }

                            function syncPercentageToPrice() {
                                const priceInput = document.getElementById('new-promo-price');
                                const percentInput = document.getElementById('new-promo-percent');
                                const modal = document.getElementById('add-promo-modal');
                                const original = parseFloat(modal.dataset.calcOriginalPrice) || 0;

                                if (!original) return;

                                const percent = parseFloat(percentInput.value);
                                if (!isNaN(percent)) {
                                    const price = original * (1 - (percent / 100));
                                    priceInput.value = Math.floor(price); // Round down to integer for safety
                                } else {
                                    priceInput.value = '';
                                }
                            }

                            function closeAddPromoModal() {
                                document.getElementById('add-promo-modal').style.display = 'none';
                                document.body.style.overflow = ''; // Restore scrolling
                            }

                            async function submitJoinPromo() {
                                const modal = document.getElementById('add-promo-modal');
                                const btn = document.getElementById('btn-join-promo');
                                const priceInput = document.getElementById('new-promo-price');
                                
                                const itemId = modal.dataset.itemId;
                                const promoId = modal.dataset.selectedPromoId;
                                const promoType = modal.dataset.selectedPromoType;
                                const dealPrice = parseFloat(priceInput.value);

                                if (!promoId || !promoType) {
                                    alert('Por favor selecciona una promoción');
                                    return;
                                }

                                if (document.getElementById('promo-config-section').style.display !== 'none' && !dealPrice) {
                                    alert('Por favor ingresa un precio para la oferta.');
                                    priceInput.focus();
                                    return;
                                }

                                btn.disabled = true;
                                btn.textContent = 'Uniéndose...';

                                try {
                                    const res = await fetch('/apply-promotion', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            item_id: itemId,
                                            promotion_id: promoId,
                                            promotion_type: promoType,
                                            deal_price: dealPrice
                                        })
                                    });

                                    const data = await res.json();
                                    
                                    if (data.success) {
                                        // Optmistic Update: Rebuild the Promo Cell
                                        const promoName = modal.dataset.selectedPromoName || 'Promoción';
                                        
                                        // Syntax Fix: Use quotes instead of backticks to avoid breaking server string
                                        const priceEditContainer = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"]');
                                        if (priceEditContainer) {
                                            const row = priceEditContainer.closest('tr');
                                            if (row) {
                                                const promoCell = row.children[3]; // 4th column
                                                const formattedPrice = dealPrice.toLocaleString('es-AR');
                                                const basePrice = modal.dataset.originalPrice || 0; 

                                                // Construct HTML using DOM API (Safe from syntax errors)
                                                promoCell.innerHTML = ''; // Clear

                                                const container = document.createElement('div');
                                                container.className = 'promo-edit-container';
                                                container.dataset.itemId = itemId;
                                                container.dataset.promoId = promoId;
                                                container.dataset.promoType = promoType;

                                                const displayDiv = document.createElement('div');
                                                displayDiv.className = 'promo-display';

                                                const headDiv = document.createElement('div');
                                                headDiv.style.cssText = 'display: flex; align-items: center; gap: 5px;';
                                                headDiv.innerHTML = '<div style="color: #00a650; font-weight: 700; font-size: 1.1rem;">$ <span class="promo-value-text">' + dealPrice.toLocaleString('es-AR') + '</span></div>';
                                                
                                                const addBtn = document.createElement('button');
                                                addBtn.className = 'add-promo-btn';
                                                addBtn.title = 'Agregar Promoción';
                                                addBtn.textContent = '+';
                                                addBtn.style.cssText = 'border: none; background: #e6f7ee; color: #00a650; font-weight: bold; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;';
                                                addBtn.onclick = function() { openAddPromoModal(itemId, basePrice); };
                                                headDiv.appendChild(addBtn);

                                                const badge = document.createElement('div');
                                                badge.textContent = 'En Promoción';
                                                badge.style.cssText = 'font-size: 0.7rem; color: #666; background: #e6f7ee; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px;';

                                                const editBtn = document.createElement('button');
                                                editBtn.className = 'edit-price-btn';
                                                editBtn.textContent = '✏️';
                                                editBtn.style.marginLeft = '5px';
                                                editBtn.onclick = function() { editPromoPrice(itemId, dealPrice); };

                                                const nameDiv = document.createElement('div');
                                                nameDiv.textContent = promoName;
                                                nameDiv.style.cssText = 'font-size: 0.75rem; color: #4da6ff; margin-top: 6px; line-height: 1.2; max-width: 180px; margin-left: auto; margin-right: auto;';

                                                displayDiv.appendChild(headDiv);
                                                displayDiv.appendChild(badge);
                                                displayDiv.appendChild(editBtn);
                                                displayDiv.appendChild(nameDiv);

                                                const formDiv = document.createElement('div');
                                                formDiv.className = 'promo-edit-form';
                                                formDiv.style.cssText = 'display: none; align-items: center; justify-content: center; gap: 5px; margin-top: 5px;';

                                                const input = document.createElement('input');
                                                input.type = 'number';
                                                input.className = 'promo-input';
                                                input.value = dealPrice;
                                                input.step = '0.01';
                                                input.style.cssText = 'width: 80px; padding: 4px;';
                                                input.onkeydown = function(e) { if(e.key === 'Enter') savePromoPrice(itemId); };

                                                const saveBtn = document.createElement('button');
                                                saveBtn.className = 'save-price-btn';
                                                saveBtn.textContent = '✓';
                                                saveBtn.onclick = function() { savePromoPrice(itemId); };

                                                const cancelBtn = document.createElement('button');
                                                cancelBtn.className = 'cancel-price-btn';
                                                cancelBtn.textContent = '✗';
                                                cancelBtn.onclick = function() { cancelPromoEdit(itemId); };

                                                formDiv.appendChild(input);
                                                formDiv.appendChild(saveBtn);
                                                formDiv.appendChild(cancelBtn);

                                                container.appendChild(displayDiv);
                                                container.appendChild(formDiv);
                                                promoCell.appendChild(container);
                                            }
                                        }

                                        alert('¡Éxito! Oferta aplicada correctamente.');
                                        closeAddPromoModal();
                                        
                                        // Dynamic Net Income Update
                                        updateNetIncome(itemId, dealPrice);
                                    } else {
                                        const errMsg = data.details?.message || data.error || 'Error desconocido';
                                        alert('Error al unirse: ' + errMsg);
                                        console.error(data);
                                    }
                                } catch (e) {
                                    alert('Error de red: ' + e.message);
                                } finally {
                                    btn.disabled = false;
                                    btn.textContent = 'Unirse';
                                }
                            }

                            function applyListingsSort() {
                                const sortValue = document.getElementById('sortBy').value;
                                const url = new URL(window.location);
                                url.searchParams.set('sort', sortValue);
                                url.searchParams.set('page', '1');
                                window.location.href = url.toString();
                            }

                            function updateNetIncome(itemId, newPrice) {
                                const cell = document.getElementById('net-income-' + itemId);
                                if (!cell) return;

                                const oldPrice = parseFloat(cell.dataset.currentPrice) || newPrice; // Fallback
                                const oldFee = parseFloat(cell.dataset.saleFee) || 0;
                                const shipFee = parseFloat(cell.dataset.shipFee) || 0;

                                // Estimate Fee Rate
                                let feeRate = 0;
                                if (oldPrice > 0) feeRate = oldFee / oldPrice;

                                // Calculate New Values
                                const newFee = newPrice * feeRate;
                                const newNet = newPrice - newFee - shipFee;

                                // Update Text
                                const netSpan = cell.querySelector('.net-income-value');
                                const formattedNet = '$ ' + newNet.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
                                if (netSpan) {
                                    netSpan.textContent = formattedNet;
                                    netSpan.style.color = newNet < 0 ? '#d32f2f' : '#00a650';
                                }

                                // Update Tooltip Params
                                const tPrice = cell.querySelector('.param-price');
                                if (tPrice) tPrice.textContent = '$ ' + newPrice.toLocaleString('es-AR');
                                
                                const tFee = cell.querySelector('.param-fee');
                                if (tFee) tFee.textContent = '-$ ' + newFee.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

                                const tNet = cell.querySelector('.param-net');
                                if (tNet) {
                                    tNet.textContent = formattedNet;
                                    tNet.style.color = newNet < 0 ? '#d32f2f' : '#00a650';
                                }

                                // Update Dataset for sequential edits
                                cell.dataset.currentPrice = newPrice;
                                cell.dataset.saleFee = newFee;
                            }
                            
                            // Expose to window for inline calls if needed, though they are in same scope
                            // window.updateNetIncome = updateNetIncome;
                        </script>
                    </div >
                    `;

                res.send(renderPage('My Listings', content, 'listings'));
            });
        });

    } catch (error) {
        console.error('Listings Error:', error.message);
        res.send(renderPage('Error', `< p > Error fetching listings: ${error.message}</p > `, 'listings'));
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

        console.log(`[Price Update]Item: ${itemId}, New Price: ${newPrice}, User: ${userId} `);

        // 2. Update API with explicit timeout
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { price: parseFloat(newPrice) }, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            timeout: 5000 // Reduced to 5s to catch latency early
        });
        console.log(`[Price Update] API Success for ${itemId}`);

        // 3. Update Local DB (wrapped in Promise to ensure completion)
        // CRITICAL: We must clear sale_price_amount so render uses the new base price!
        await new Promise((resolve, reject) => {
            db.run(`UPDATE items_v14 SET price = ?, sale_price_amount = NULL, sale_price_regular_amount = NULL, last_updated = ? WHERE id = ? AND user_id = ?`,
                [parseFloat(newPrice), new Date().toISOString(), itemId, userId],
                (err) => {
                    if (err) {
                        console.error('Local DB Update Error:', err);
                        reject(err);
                    } else {
                        console.log(`[Price Update] DB Updated for ${itemId} (Cleared stale sale prices)`);
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

// Promotions Summary
app.get('/promotions-summary', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.redirect('/');

    try {
        // Get user ID
        const userRes = await axios.get('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userId = userRes.data.id;

        // Fetch all user promotions
        const promosRes = await axios.get(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Handle different response structures
        let allPromotions = [];
        if (Array.isArray(promosRes.data)) {
            allPromotions = promosRes.data;
        } else if (promosRes.data?.results) {
            allPromotions = promosRes.data.results;
        } else if (promosRes.data?.promotions) {
            allPromotions = promosRes.data.promotions;
        }

        console.log(`[Promotions Summary] Found ${allPromotions.length} total promotions`);

        // Fetch pending scheduled tasks
        const pendingTasks = await new Promise((resolve, reject) => {
            db.all("SELECT promotion_id, execute_at FROM scheduled_tasks WHERE status = 'pending'", [], (err, rows) => {
                if (err) resolve([]);
                else resolve(rows);
            });
        });

        // Map promo_id -> execute_at
        const scheduledMap = new Map();
        pendingTasks.forEach(t => scheduledMap.set(t.promotion_id, t.execute_at));

        const strategies = allPromotions.map(async (promo) => {
            let itemCount = 0;
            try {
                // We must include promotion_type.
                const pType = promo.promotion_type || promo.type || 'SELLER_CAMPAIGN';

                const itemsRes = await axios.get(
                    `https://api.mercadolibre.com/seller-promotions/promotions/${promo.id}/items?promotion_type=${pType}&status=started&app_version=v2`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );

                // Try paging.total first, then fallback to results length
                itemCount = itemsRes.data?.paging?.total ?? (itemsRes.data?.results?.length || itemsRes.data?.length || 0);
                // console.log(`[Promo ${promo.id}] Items count: ${itemCount}`);
            } catch (e) {
                console.error(`[Promo ${promo.id}] Error fetching item count:`, e.message);
            }

            // Calculate days until expiration
            const finishDate = new Date(promo.finish_date);
            const now = new Date();
            const daysRemaining = Math.ceil((finishDate - now) / (1000 * 60 * 60 * 24));

            return {
                ...promo,
                item_count: itemCount,
                days_remaining: daysRemaining
            };
        });

        const promotionsWithCounts = await Promise.all(strategies);

        // Render summary cards
        const promoCards = promotionsWithCounts.map(promo => {
            const startDate = new Date(promo.start_date).toLocaleDateString('es-AR');
            const finishDate = new Date(promo.finish_date).toLocaleDateString('es-AR');
            const isActive = promo.status === 'active';
            const isExpiringSoon = promo.days_remaining > 0 && promo.days_remaining <= 3;
            const isExpired = promo.days_remaining <= 0;
            const pType = promo.promotion_type || promo.type || 'SELLER_CAMPAIGN';

            let statusBadge = '';
            let statusColor = '#00a650';
            if (isExpired) {
                statusBadge = 'Finalizada';
                statusColor = '#999';
            } else if (isExpiringSoon) {
                statusBadge = '⏰ Vence Pronto';
                statusColor = '#ff6600';
            } else if (isActive) {
                statusBadge = '✓ Activa';
                statusColor = '#00a650';
            } else {
                statusBadge = promo.status;
                statusColor = '#666';
            }

            const htmlSafeName = (promo.name || 'Campaña').replace(/"/g, '&quot;');

            // Check for scheduled task
            const scheduledAt = scheduledMap.get(promo.id);
            let scheduledBadge = '';
            let programBtnText = '⏰ Programar';

            if (scheduledAt) {
                const dateObj = new Date(scheduledAt);
                const readableDate = dateObj.toLocaleString('es-AR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                scheduledBadge = `
                    <div style="margin-top: 10px; background: #e3f2fd; color: #1565c0; padding: 6px 10px; border-radius: 4px; font-size: 0.8rem; display: flex; align-items: center; gap: 5px;">
                        <span>⏳</span>
                        <strong>Fin Programado:</strong> ${readableDate}
                    </div>
                `;
                programBtnText = '✏️ Reprogramar';
            }

            return `
                <div class="card" style="margin-bottom: 20px; border-left: 4px solid ${statusColor}; position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                        <div>
                            <h3 style="margin: 0 0 5px 0; color: #333;">${promo.name || 'Sin nombre'}</h3>
                            <div style="font-size: 0.85rem; color: #999;">ID: ${promo.id}</div>
                        </div>
                        <div style="background: ${statusColor}; color: white; padding: 5px 12px; border-radius: 12px; font-size: 0.85rem; font-weight: 500;">
                            ${statusBadge}
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 5px;">
                        <div>
                            <div style="font-size: 0.75rem; color: #999; margin-bottom: 3px;">INICIO</div>
                            <div style="font-weight: 500;">${startDate}</div>
                        </div>
                        <div>
                            <div style="font-size: 0.75rem; color: #999; margin-bottom: 3px;">FIN</div>
                            <div style="font-weight: 500;">${finishDate}</div>
                        </div>
                    </div>
                    
                    ${scheduledBadge}

                    <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 15px; margin-top: 10px; border-top: 1px solid #eee;">
                        <div>
                            <span style="font-size: 0.85rem; color: #666;">Productos participando:</span>
                            <span style="font-weight: 700; font-size: 1.1rem; color: #3483fa; margin-left: 8px;">${promo.item_count}</span>
                        </div>
                        <div>
                        ${promo.item_count > 0 ? `
                            <div style="display: flex; gap: 5px;">
                                <button data-id="${promo.id}" data-type="${pType}" data-name="${htmlSafeName}" onclick="removeAllItems(this)" 
                                        style="background: #fff0f0; color: #d93025; border: 1px solid #ffcccc; border-radius: 4px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer;">
                                    🗑️ Vaciar
                                </button>
                                <button data-id="${promo.id}" data-type="${pType}" data-name="${htmlSafeName}" onclick="openScheduleModal(this)" 
                                        style="background: #f0f4ff; color: #3483fa; border: 1px solid #cce0ff; border-radius: 4px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer;">
                                    ${programBtnText}
                                </button>
                            </div>
                        ` : ''}
                        ${!isExpired ? `
                            <span style="font-size: 0.85rem; color: ${isExpiringSoon ? statusColor : '#666'};">
                                ${promo.days_remaining > 0 ? `${promo.days_remaining} días restantes` : 'Hoy vence'}
                            </span>
                        ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        const content = `
            <div style="max-width: 900px; margin: 0 auto;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
                    <h2 style="margin: 0;">Mis Promociones</h2>
                    <a href="/create-promotion-ui" class="btn-primary" style="text-decoration: none; display: inline-block;">
                        + Nueva Promoción
                    </a>
                </div>

                ${promotionsWithCounts.length > 0 ? promoCards : `
                    <div class="card" style="text-align: center; padding: 60px;">
                        <div style="font-size: 3rem; margin-bottom: 15px;">🏷️</div>
                        <h3 style="color: #666; font-weight: 400;">No tienes promociones activas</h3>
                        <p style="color: #999; margin-bottom: 20px;">Crea tu primera campaña de descuentos</p>
                        <a href="/create-promotion-ui" class="btn-primary" style="text-decoration: none; display: inline-block;">
                            Crear Promoción
                        </a>
                    </div>
                `}
            </div>

            <!-- Modal for Scheduling -->
            <div id="scheduleModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
                <div style="background: white; padding: 25px; border-radius: 8px; width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h3 style="margin-top: 0;">Programar Fin de Campaña</h3>
                    <p id="schedulePromoName" style="color: #666; margin-bottom: 20px; font-size: 0.9rem;"></p>
                    
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: 500;">Fecha y Hora de Finalización</label>
                        <input type="datetime-local" id="scheduleDate" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                        <small style="color: #999;">Los productos se quitarán automáticamente en este horario.</small>
                    </div>

                    <div style="text-align: right;">
                        <button onclick="closeScheduleModal()" style="background: none; border: none; cursor: pointer; color: #666; margin-right: 15px;">Cancelar</button>
                        <button onclick="confirmSchedule()" class="btn-primary">Confirmar</button>
                    </div>
                </div>
            </div>

            <script>
                let currentPromoId = null;
                let currentPromoType = null;

                function openScheduleModal(btn) {
                    const id = btn.dataset.id;
                    const type = btn.dataset.type;
                    const name = btn.dataset.name;
                    
                    currentPromoId = id;
                    currentPromoType = type;
                    document.getElementById('schedulePromoName').innerText = 'Campaña: ' + name;
                    document.getElementById('scheduleModal').style.display = 'flex';
                    
                    // Set default to tomorrow same time
                    const now = new Date();
                    now.setDate(now.getDate() + 1);
                    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
                    document.getElementById('scheduleDate').value = now.toISOString().slice(0,16);
                }

                function closeScheduleModal() {
                    document.getElementById('scheduleModal').style.display = 'none';
                    currentPromoId = null;
                }

                async function confirmSchedule() {
                    const dateVal = document.getElementById('scheduleDate').value;
                    if (!dateVal) return alert('Selecciona una fecha válida');

                    const executeAt = new Date(dateVal);
                    if (executeAt < new Date()) return alert('La fecha debe ser en el futuro');

                    try {
                        const res = await fetch('/schedule-remove-items', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                promotion_id: currentPromoId, 
                                promotion_type: currentPromoType,
                                execute_at: executeAt.toISOString()
                            })
                        });
                        
                        const data = await res.json();
                        if (data.success) {
                            alert('✅ Tarea programada correctamente para el ' + executeAt.toLocaleString());
                            closeScheduleModal();
                            window.location.reload();
                        } else {
                            alert('Error: ' + data.error);
                        }
                    } catch (e) {
                        alert('Error de conexión: ' + e.message);
                    }
                }

                async function removeAllItems(btn) {
                    const promoId = btn.dataset.id;
                    const promoType = btn.dataset.type;
                    const promoName = btn.dataset.name;

                    if (!confirm('¿Estás seguro de que deseas quitar TODOS los productos de la campaña "' + promoName + '"?\\n\\nEsta acción no se puede deshacer.')) {
                        return;
                    }

                    const originalText = btn.innerHTML;
                    btn.disabled = true;
                    btn.innerHTML = '⏳ Vaciando...';

                    try {
                        const res = await fetch('/remove-all-promotion-items', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ promotion_id: promoId, promotion_type: promoType })
                        });
                        
                        const data = await res.json();
                        
                        if (data.success) {
                            alert('Se quitaron ' + data.removed_count + ' productos exitosamente.' + (data.error_count > 0 ? ' (Hubo ' + data.error_count + ' errores)' : ''));
                            window.location.reload();
                        } else {
                            alert('Error: ' + (data.error || 'Desconocido'));
                            btn.disabled = false;
                            btn.innerHTML = originalText;
                        }
                    } catch (e) {
                        alert('Error de conexión: ' + e.message);
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                    }
                }
            </script>
        `;

        res.send(renderPage('Promociones', content, 'promotions_summary'));
    } catch (error) {
        res.send(renderPage('Error', `<div class="card"><p>Error cargando promociones: ${error.message}</p></div>`, 'promotions_summary'));
    }
});

// Remove All Items from Promotion
app.post('/remove-all-promotion-items', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { promotion_id, promotion_type } = req.body;
    const pType = promotion_type || 'SELLER_CAMPAIGN';

    console.log(`[Bulk Remove] Starting removal for ${promotion_id} (${pType})`);

    try {
        // Reuse the logic? Or just fix it here. Let's fix it here for immediacy.
        let allItems = [];
        let offset = 0;
        let limit = 50;
        let total = 0;
        let pages = 0;
        const failSafeLimit = 10;

        do {
            const itemsRes = await axios.get(
                `https://api.mercadolibre.com/seller-promotions/promotions/${promotion_id}/items?promotion_type=${pType}&status=started&app_version=v2&limit=${limit}&offset=${offset}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            const results = itemsRes.data.results || itemsRes.data || [];
            allItems = allItems.concat(results);
            total = itemsRes.data.paging?.total || results.length;
            offset += limit;
            pages++;

        } while (allItems.length < total && pages < failSafeLimit);

        console.log(`[Bulk Remove] Found ${allItems.length} items to remove.`);

        if (allItems.length === 0) {
            return res.json({ success: true, message: 'No items to remove.', removed_count: 0 });
        }

        let removedCount = 0;
        let errorCount = 0;
        const chunkSize = 5;

        for (let i = 0; i < allItems.length; i += chunkSize) {
            const chunk = allItems.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (item) => {
                const itemId = item.id || item; // Fix: Handle potential string vs object
                try {
                    await axios.delete(
                        `https://api.mercadolibre.com/seller-promotions/items/${itemId}?promotion_type=${pType}&promotion_id=${promotion_id}&app_version=v2`,
                        { headers: { Authorization: `Bearer ${accessToken}` } }
                    );
                    removedCount++;
                } catch (e) {
                    console.error(`[Bulk Remove] Error removing ${itemId}:`, e.message);
                    errorCount++;
                }
            }));
        }

        console.log(`[Bulk Remove] Finished. Removed: ${removedCount}, Errors: ${errorCount}`);
        res.json({ success: true, removed_count: removedCount, error_count: errorCount });

    } catch (error) {
        console.error('[Bulk Remove] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Schedule Removal
app.post('/schedule-remove-items', (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { promotion_id, promotion_type, execute_at, promotion_name } = req.body;
    const pType = promotion_type || 'SELLER_CAMPAIGN';

    // Get user ID (needed for DB record)
    // Quick hack: decode JWT or just store blindly? We'll rely on memory token.
    // Ideally we fetch /users/me but for speed lets assume valid.

    const stmt = db.prepare('INSERT INTO scheduled_tasks (promotion_id, promotion_type, execute_at, status, access_token) VALUES (?, ?, ?, ?, ?)');
    stmt.run(promotion_id, promotion_type, execute_at, 'pending', accessToken, function (err) {
        if (err) {
            console.error('Schedule Error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        const taskId = this.lastID;
        // Also schedule in-memory for immediate servers
        scheduleRemovalJob(taskId, promotion_id, promotion_type, execute_at, accessToken);

        res.json({ success: true, task_id: taskId, message: 'Tarea programada exitosamente.' });
    });
    stmt.finalize();
});

// Vercel Cron Endpoint
app.get('/api/cron/process-queue', (req, res) => {
    console.log('[Cron] Checking for pending tasks...');

    // Find tasks that are pending and should have executed by now (or up to 1 min in future to be safe)
    db.all(`SELECT * FROM scheduled_tasks WHERE status = 'pending' AND execute_at <= datetime('now', '+1 minute')`, [], async (err, rows) => {
        if (err) {
            console.error('[Cron] DB Error:', err);
            return res.status(500).json({ error: err.message });
        }

        if (rows.length === 0) {
            return res.json({ message: 'No pending tasks to execute.' });
        }

        console.log(`[Cron] Found ${rows.length} pending tasks.`);
        const results = [];

        for (const task of rows) {
            console.log(`[Cron] Executing Task ${task.id} for Promo ${task.promotion_id}`);
            try {
                // Double check status before running to avoid race conditions
                // (Optimistic locking strategy could be better but simply running is probably fine for this scale)

                await executeRemoval(task.promotion_id, task.promotion_type, task.access_token, task.id);
                results.push({ id: task.id, status: 'completed' });
            } catch (e) {
                console.error(`[Cron] Task ${task.id} Failed:`, e.message);
                results.push({ id: task.id, status: 'failed', error: e.message });
            }
        }

        res.json({ success: true, results });
    });
});

// Create Promotion UI
app.get('/create-promotion-ui', (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.redirect('/');

    const content = `
        <div class="card" style="max-width: 600px; margin: 40px auto;">
            <h2 style="margin-bottom: 20px; color: #333;">Crear Nueva Promoción</h2>
            <p style="color: #666; margin-bottom: 30px;">Crea una campaña de descuento para tus productos. Luego, podrás agregar productos a esta campaña desde la pestaña "Listados".</p>
            
            <div id="create-promo-form">
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Nombre de la Campaña</label>
                    <input type="text" id="promoName" class="search-input" placeholder="Ej: Ofertas Enero" style="width: 100%; box-sizing: border-box;">
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Porcentaje de Descuento Sugerido</label>
                    <input type="number" id="promoPercent" class="search-input" placeholder="Ej: 10" style="width: 100%; box-sizing: border-box;" min="5" max="80" step="1">
                    <small style="color: #999;">Descuento de referencia. Podrás ajustar el % por producto al agregarlo.</small>
                </div>

                <div style="margin-bottom: 30px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Duración (Días)</label>
                    <input type="number" id="promoDays" class="search-input" value="7" style="width: 100%; box-sizing: border-box;" min="1" max="365">
                    <small style="color: #999;">La campaña comenzará hoy.</small>
                </div>

                <button onclick="submitNewPromo()" class="btn-primary" style="width: 100%;">Crear Campaña</button>
            </div>
            
            <div id="promo-success" style="display: none; text-align: center; color: #00a650;">
                <h3 style="margin-bottom: 10px;">¡Campaña Creada!</h3>
                <p>Ahora ve a "Listados" y usa el botón (+) para agregar productos.</p>
                <a href="/listings" class="btn-primary" style="display: inline-block; margin-top: 20px;">Ir a Listados</a>
            </div>
        </div>

        <script>
            async function submitNewPromo() {
                const name = document.getElementById('promoName').value;
                const percent = parseFloat(document.getElementById('promoPercent').value);
                const days = parseInt(document.getElementById('promoDays').value);

                if (!name || !percent || !days) {
                    alert('Por favor completa todos los campos.');
                    return;
                }

                if (percent < 5 || percent > 80) {
                    alert('El descuento debe ser entre 5% y 80%.');
                    return;
                }

                const btn = document.querySelector('button');
                btn.disabled = true;
                btn.textContent = 'Creando...';

                try {
                    const res = await fetch('/create-promotion', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, percent, days })
                    });
                    
                    const data = await res.json();
                    
                    if (data.success) {
                        document.getElementById('create-promo-form').style.display = 'none';
                        document.getElementById('promo-success').style.display = 'block';
                    } else {
                        alert('Error al crear: ' + (data.error || 'Desconocido'));
                        btn.disabled = false;
                        btn.textContent = 'Crear Campaña';
                    }
                } catch (e) {
                    alert('Error de conexión: ' + e.message);
                    btn.disabled = false;
                    btn.textContent = 'Crear Campaña';
                }
            }
        </script>
    `;

    res.send(renderPage('Crear Promoción', content, 'create_promotion'));
});

// Create Promotion API
app.post('/create-promotion', async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { name, percent, days } = req.body;

    // Calculate dates
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + days);

    const payload = {
        promotion_type: 'SELLER_CAMPAIGN',
        sub_type: 'FLEXIBLE_PERCENTAGE',
        name: name,
        start_date: startDate.toISOString().split('.')[0],
        finish_date: endDate.toISOString().split('.')[0]
    };

    console.log('[Create Promo] Payload:', payload);

    try {
        const createRes = await axios.post('https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2', payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        console.log('[Create Promo] Success:', createRes.data);
        res.json({ success: true, data: createRes.data });
    } catch (error) {
        console.error('[Create Promo] Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
    }
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
