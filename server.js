const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

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
        <div class="header-content">
            <h1>Meli Connector</h1>
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
        v9.3 - UI Translation - ${new Date().toISOString()}
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

        let itemIds = [];
        let offset = 0;
        let total = 1; // Start with 1 to enter loop

        while (itemIds.length < total) {
            const searchResponse = await axios.get(`https://api.mercadolibre.com/users/${userId}/items/search`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: {
                    status: 'active,paused,closed,under_review',
                    limit: 100,
                    offset: offset,
                    search_type: 'scan'
                }
            });

            const results = searchResponse.data.results || [];
            itemIds = itemIds.concat(results);
            total = searchResponse.data.paging.total;
            offset += results.length;

            // Safety break to prevent infinite loops if total is misreported
            if (results.length === 0) break;
        }

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

        // Fetch Buy Box, Fees, and Shipping in Parallel
        const buyBoxData = new Map();
        const feeData = new Map();
        const shippingData = new Map();
        const salePriceData = new Map();

        await Promise.all(allItems.map(async (itemWrapper) => {
            if (itemWrapper.code !== 200) return;
            const item = itemWrapper.body;
            const itemId = item.id;

            // 1. Fetch Buy Box Status
            if (item.catalog_product_id) {
                try {
                    const pbRes = await axios.get(`https://api.mercadolibre.com/items/${itemId}/price_to_win`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        params: { siteId: 'MLA', version: 'v2' }
                    });
                    buyBoxData.set(itemId, { status: pbRes.data.status, priceToWin: pbRes.data.price_to_win });
                } catch (err) {
                    // console.error(`BuyBox Error (${itemId}):`, err.message);
                }
            }

            // 2. Fetch Actual Sale Price (v9.1 strategy - The most accurate)
            try {
                const spRes = await axios.get(`https://api.mercadolibre.com/items/${itemId}/sale_price`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });
                if (spRes.data && spRes.data.amount) {
                    salePriceData.set(itemId, {
                        amount: spRes.data.amount,
                        regular: spRes.data.regular_amount || item.price
                    });
                }
            } catch (err) {
                // Ignore 404/others, use base item price as fallback
            }

            // 3. Fetch Costs via Pricing Reference API (v6.0 - Unified Source)
            try {
                // We use the detail endpoint to get precise selling_fees and shipping_fees
                const detailRes = await axios.get(`https://api.mercadolibre.com/suggestions/items/${itemId}/details`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });

                if (detailRes.data && detailRes.data.costs) {
                    const c = detailRes.data.costs;
                    feeData.set(itemId, {
                        saleFee: c.selling_fees || 0,
                        financingFee: 0, // Suggestions API combines fees into selling_fees
                        isSug: true
                    });
                    shippingData.set(itemId, c.shipping_fees || 0);
                } else {
                    // Fallback to basic 15% and 0 shipping if details missing
                    feeData.set(itemId, { saleFee: item.price * 0.15, financingFee: 0, isEstimate: true });
                    shippingData.set(itemId, 0);
                }
            } catch (err) {
                // Fail-safe fallback
                feeData.set(itemId, { saleFee: item.price * 0.15, financingFee: 0, isEstimate: true });
                shippingData.set(itemId, 0);
            }
        }));


        const tableRows = allItems.map((itemWrapper, index) => {
            if (itemWrapper.code !== 200) return '';
            const item = itemWrapper.body;

            // Determine if there's an active promotion/discount (v9.1 Strategy)
            const spData = salePriceData.get(item.id);
            const currentPrice = spData ? spData.amount : item.price;
            const originalPrice = spData ? spData.regular : (item.original_price || item.base_price || item.price);
            const hasPromo = originalPrice > currentPrice;

            if (index < 5) {
                console.log(`[Item Debug v9.1] ID: ${item.id}, FinalSalePrice: ${currentPrice}, BasePrice: ${item.price}, OrigPrice: ${originalPrice}, HasPromo: ${hasPromo}`);
            }

            // Determine buy box status and price to win
            let buyBoxStatus = '';
            let buyBoxClass = 'status-na';
            let priceToWin = '-';

            if (item.catalog_product_id) {
                const data = buyBoxData.get(item.id);
                if (data) {
                    const competitionStatus = data.status;
                    if (competitionStatus === 'winning') {
                        buyBoxStatus = '🏆 Winning';
                        buyBoxClass = 'status-winning';
                    } else if (competitionStatus === 'sharing_first_place') {
                        buyBoxStatus = '🏆 Sharing 1st';
                        buyBoxClass = 'status-winning';
                    } else if (competitionStatus === 'losing') {
                        buyBoxStatus = 'Losing';
                        buyBoxClass = 'status-losing';
                    } else if (competitionStatus === 'listed') {
                        buyBoxStatus = 'Listed';
                        buyBoxClass = 'status-na';
                    }

                    if (data.priceToWin !== null && data.priceToWin !== undefined) {
                        priceToWin = `$ ${data.priceToWin.toLocaleString('es-AR')}`;
                    }
                }
            }

            const fees = feeData.get(item.id) || { saleFee: 0, financingFee: 0, isEstimate: true };
            const shipFee = Number(shippingData.get(item.id)) || 0;
            const saleFee = Number(fees.saleFee) || 0;
            const finFee = Number(fees.financingFee) || 0;

            const totalDeductions = saleFee + finFee + shipFee;
            const netIncome = currentPrice - totalDeductions;

            const netIncomeFormatted = `$ ${isFinite(netIncome) ? netIncome.toLocaleString('es-AR') : '---'}`;
            const saleFeeFormatted = `$ ${isFinite(saleFee) ? saleFee.toLocaleString('es-AR') : '0'}${fees.isEstimate ? ' (Est.)' : ''}`;
            const shipFeeFormatted = `$ ${isFinite(shipFee) ? shipFee.toLocaleString('es-AR') : '0'}`;

            return `
                <tr>
                    <td>
                        <img src="${item.thumbnail}" alt="" class="thumbnail">
                    </td>
                    <td>
                        <div style="font-weight: 500;">${item.title}</div>
                        <div style="font-size: 0.8rem; color: #999;">
                            ID: ${item.id} | Marca: ${item.attributes && item.attributes.find(a => a.id === 'BRAND') ? item.attributes.find(a => a.id === 'BRAND').value_name : 'N/A'}
                        </div>
                    </td>
                    <td>
                        <div class="price-edit-container" data-item-id="${item.id}">
                            <div class="price-display">
                                <span class="price-value">$ ${Number(item.price).toLocaleString('es-AR')}</span>
                                <button class="edit-price-btn" onclick="editPrice('${item.id}', ${item.price})">✏️</button>
                            </div>
                            <div class="price-edit-form" style="display: none;">
                                <input type="number" class="price-input" value="${item.price}" step="0.01" min="0" onkeydown="if(event.key === 'Enter') savePrice('${item.id}'); else if(event.key === 'Escape') cancelEdit('${item.id}')" />
                                <button class="save-price-btn" onclick="savePrice('${item.id}')">✓</button>
                                <button class="cancel-price-btn" onclick="cancelEdit('${item.id}')">✗</button>
                            </div>
                        </div>
                    </td>
                    <td style="text-align: center;">
                        ${hasPromo ? `
                            <div style="color: #00a650; font-weight: 700; font-size: 1.1rem;">
                                $ ${currentPrice.toLocaleString('es-AR')}
                            </div>
                            <div style="font-size: 0.7rem; color: #666; background: #e6f7ee; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px;">
                                En Promoción
                            </div>
                        ` : `
                            <span style="color: #ccc;">---</span>
                        `}
                    </td>
                    <td class="net-income-cell" style="font-weight: 600; color: #00a650;">
                        ${netIncomeFormatted}
                        <div class="fee-tooltip">
                            <div class="tooltip-title">Detalle de costos ${hasPromo ? '<span style="color: #00a650; font-size: 0.7rem; margin-left: 5px;">(Promo Activa)</span>' : ''}</div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Precio ${hasPromo ? 'Oferta' : 'Venta'}:</span>
                                <span class="tooltip-value">$ ${currentPrice.toLocaleString('es-AR')}</span>
                            </div>
                            ${hasPromo ? `
                            <div class="tooltip-row" style="font-size: 0.7rem; color: #999; padding-left: 10px;">
                                <span class="tooltip-label">Base:</span>
                                <span class="tooltip-value">$ ${originalPrice.toLocaleString('es-AR')}</span>
                            </div>
                            ` : ''}
                            <div class="tooltip-row">
                                <span class="tooltip-label">Cargo por vender:</span>
                                <span class="tooltip-value minus">-${saleFeeFormatted}</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Costo de envío:</span>
                                <span class="tooltip-value minus">-${shipFeeFormatted}</span>
                            </div>
                            <div class="tooltip-row total">
                                <span class="tooltip-label">Recibís:</span>
                                <span class="tooltip-value">${netIncomeFormatted}</span>
                            </div>
                        </div>
                    </td>
                    <td>${priceToWin}</td>
                    <td>
                        <div class="qty-edit-container" data-item-id="${item.id}">
                            <div class="qty-display">
                                <span class="qty-value">${item.available_quantity}</span>
                                <button class="edit-qty-btn" onclick="editQty('${item.id}', ${item.available_quantity})">✏️</button>
                            </div>
                            <div class="qty-edit-form" style="display: none;">
                                <input type="number" class="qty-input" value="${item.available_quantity}" step="1" min="0" onkeydown="if(event.key === 'Enter') saveQty('${item.id}'); else if(event.key === 'Escape') cancelQtyEdit('${item.id}')" />
                                <button class="save-qty-btn" onclick="saveQty('${item.id}')">✓</button>
                                <button class="cancel-qty-btn" onclick="cancelQtyEdit('${item.id}')">✗</button>
                            </div>
                        </div>
                    </td>
                    <td><span class="status-badge status-${item.status}">${item.status}</span></td>
                    <td><span class="status-badge ${buyBoxClass}">${buyBoxStatus}</span></td>
                    <td><a href="${item.permalink}" target="_blank" class="link-btn">View @ Meli</a></td>
                </tr>
            `;
        }).join('');

        const content = `
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2 style="margin: 0;">My Listings (<span id="item-count">${allItems.length}</span>)</h2>
                    <span style="color: #666;">User ID: ${userId}</span>
                </div>
                
                ${allItems.length > 0 ? `
                    <div style="margin-bottom: 20px; display: flex; gap: 10px; align-items: center;">
                        <input 
                            type="text" 
                            id="search-input" 
                            placeholder="Search by title or ID..." 
                            style="flex-grow: 1; padding: 12px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; font-family: 'Roboto', sans-serif;"
                        />
                        <select id="status-filter" style="padding: 12px; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; font-family: 'Roboto', sans-serif; background-color: white; cursor: pointer;">
                            <option value="all">All Statuses</option>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="closed">Closed</option>
                            <option value="under_review">Under Review</option>
                        </select>
                    </div>
                    
                    <table id="listings-table">
                        <thead>
                            <tr>
                                <th>Imagen</th>
                                <th onclick="sortTable(1, 'text')" style="cursor: pointer;" data-column="1">Nombre <span id="sort-icon-1"></span></th>
                                <th onclick="sortTable(2, 'number')" style="cursor: pointer;" data-column="2">Precio (Base) <span id="sort-icon-2"></span></th>
                                <th onclick="sortTable(3, 'number')" style="cursor: pointer; color: #00a650;" data-column="3">Promoción <span id="sort-icon-3"></span></th>
                                <th onclick="sortTable(4, 'number')" style="cursor: pointer;" data-column="4">Lo que recibis <span id="sort-icon-4"></span></th>
                                <th onclick="sortTable(5, 'number')" style="cursor: pointer;" data-column="5">Precio para Ganar <span id="sort-icon-5"></span></th>
                                <th onclick="sortTable(6, 'number')" style="cursor: pointer;" data-column="6">Cant <span id="sort-icon-6"></span></th>
                                <th onclick="sortTable(7, 'text')" style="cursor: pointer;" data-column="7">Status <span id="sort-icon-7"></span></th>
                                <th onclick="sortTable(8, 'text')" style="cursor: pointer;" data-column="8">Buy Box <span id="sort-icon-8"></span></th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                    
                    <script>
                        const searchInput = document.getElementById('search-input');
                        const statusFilter = document.getElementById('status-filter');
                        const table = document.getElementById('listings-table');
                        const rows = table.getElementsByTagName('tbody')[0].getElementsByTagName('tr');
                        const itemCount = document.getElementById('item-count');
                        
                        function applyFilters() {
                            const query = searchInput.value.toLowerCase();
                            const status = statusFilter.value.toLowerCase();
                            let visibleCount = 0;
                            
                            for (let i = 0; i < rows.length; i++) {
                                const row = rows[i];
                                const itemDetailsText = row.cells[1].textContent.toLowerCase(); // Contains title, ID, and brand
                                const rowStatus = row.cells[7].textContent.toLowerCase().trim();
                                
                                const matchesSearch = itemDetailsText.includes(query);
                                const matchesStatus = status === 'all' || rowStatus === status;
                                
                                if (matchesSearch && matchesStatus) {
                                    row.style.display = '';
                                    visibleCount++;
                                } else {
                                    row.style.display = 'none';
                                }
                            }
                            
                            itemCount.textContent = visibleCount;
                        }
                        
                        searchInput.addEventListener('input', applyFilters);
                        statusFilter.addEventListener('change', applyFilters);

                        
                        // Price editing functions
                        window.editPrice = function(itemId, currentPrice) {
                            const container = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"]');
                            container.querySelector('.price-display').style.display = 'none';
                            container.querySelector('.price-edit-form').style.display = 'flex';
                            container.querySelector('.price-input').focus();
                        };
                        
                        window.cancelEdit = function(itemId) {
                            const container = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"]');
                            container.querySelector('.price-display').style.display = 'flex';
                            container.querySelector('.price-edit-form').style.display = 'none';
                        };
                        
                        window.savePrice = async function(itemId) {
                            const container = document.querySelector('.price-edit-container[data-item-id="' + itemId + '"]');
                            const input = container.querySelector('.price-input');
                            const newPrice = parseFloat(input.value);
                            
                            if (isNaN(newPrice) || newPrice < 0) {
                                alert('Please enter a valid price');
                                return;
                            }
                            
                            const saveBtn = container.querySelector('.save-price-btn');
                            const originalText = saveBtn.textContent;
                            saveBtn.textContent = '⏳';
                            saveBtn.disabled = true;
                            
                            try {
                                const response = await fetch('/update-price', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ itemId: itemId, newPrice: newPrice })
                                });
                                
                                const result = await response.json();
                                
                                if (result.success) {
                                    container.querySelector('.price-value').textContent = '$ ' + newPrice.toLocaleString('es-AR');
                                    container.querySelector('.price-display').style.display = 'flex';
                                    container.querySelector('.price-edit-form').style.display = 'none';
                                } else {
                                    alert('Error: ' + result.error);
                                }
                            } catch (error) {
                                alert('Failed to update price: ' + error.message);
                            } finally {
                                saveBtn.textContent = originalText;
                                saveBtn.disabled = false;
                            }
                        };
                        
                        // Quantity editing functions
                        window.editQty = function(itemId, currentQty) {
                            const container = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"]');
                            container.querySelector('.qty-display').style.display = 'none';
                            container.querySelector('.qty-edit-form').style.display = 'flex';
                            container.querySelector('.qty-input').focus();
                        };
                        
                        window.cancelQtyEdit = function(itemId) {
                            const container = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"]');
                            container.querySelector('.qty-display').style.display = 'flex';
                            container.querySelector('.qty-edit-form').style.display = 'none';
                        };
                        
                        window.saveQty = async function(itemId) {
                            const container = document.querySelector('.qty-edit-container[data-item-id="' + itemId + '"]');
                            const input = container.querySelector('.qty-input');
                            const newQty = parseInt(input.value);
                            
                            if (isNaN(newQty) || newQty < 0) {
                                alert('Please enter a valid quantity');
                                return;
                            }
                            
                            const saveBtn = container.querySelector('.save-qty-btn');
                            const originalText = saveBtn.textContent;
                            saveBtn.textContent = '⏳';
                            saveBtn.disabled = true;
                            
                            try {
                                const response = await fetch('/update-quantity', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ itemId: itemId, newQuantity: newQty })
                                });
                                
                                const result = await response.json();
                                
                                if (result.success) {
                                    container.querySelector('.qty-value').textContent = newQty;
                                    container.querySelector('.qty-display').style.display = 'flex';
                                    container.querySelector('.qty-edit-form').style.display = 'none';
                                } else {
                                    alert('Error: ' + result.error);
                                }
                            } catch (error) {
                                alert('Failed to update quantity: ' + error.message);
                            } finally {
                                saveBtn.textContent = originalText;
                                saveBtn.disabled = false;
                            }
                        };
                        
                        // Table sorting functionality
                        let currentSortColumn = null;
                        let currentSortDirection = 'asc';
                        
                        window.sortTable = function(columnIndex, dataType) {
                            const table = document.getElementById('listings-table');
                            const tbody = table.getElementsByTagName('tbody')[0];
                            const rows = Array.from(tbody.getElementsByTagName('tr'));
                            
                            if (currentSortColumn === columnIndex) {
                                currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
                            } else {
                                currentSortDirection = 'asc';
                                currentSortColumn = columnIndex;
                            }
                            
                            for (let i = 1; i <= 8; i++) {
                                const icon = document.getElementById('sort-icon-' + i);
                                if (icon) icon.textContent = '';
                            }
                            
                            const currentIcon = document.getElementById('sort-icon-' + columnIndex);
                            if (currentIcon) {
                                currentIcon.textContent = currentSortDirection === 'asc' ? ' ▲' : ' ▼';
                            }
                            
                            rows.sort(function(a, b) {
                                let aValue = a.cells[columnIndex].textContent.trim();
                                let bValue = b.cells[columnIndex].textContent.trim();
                                
                                if (dataType === 'number') {
                                    aValue = parseFloat(aValue.replace(/[^0-9.-]/g, '')) || 0;
                                    bValue = parseFloat(bValue.replace(/[^0-9.-]/g, '')) || 0;
                                    return currentSortDirection === 'asc' ? aValue - bValue : bValue - aValue;
                                } else {
                                    return currentSortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
                                }
                            });
                            
                            rows.forEach(function(row) {
                                tbody.appendChild(row);
                            });
                        };
                    </script>
                ` : '<p>No active listings found.</p>'}
            </div>
    `;

        res.send(renderPage('My Listings', content, 'listings'));

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
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { price: parseFloat(newPrice) }, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
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
        await axios.put(`https://api.mercadolibre.com/items/${itemId}`, { available_quantity: parseInt(newQuantity) }, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
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

            const [cand, start, invit, pend] = await Promise.all([
                fetchByStatus('candidate'),
                fetchByStatus('started'),
                fetchByStatus('invitation'),
                fetchByStatus('pending')
            ]);

            const allItemsRaw = [...cand, ...start, ...invit, ...pend];
            const candidateIds = [...new Set(allItemsRaw.map(r => r.id).filter(id => id))];

            // Create a lookup map for promo status and price
            const promoInfoMap = {};
            allItemsRaw.forEach(r => {
                if (r.id) {
                    promoInfoMap[r.id] = {
                        status: r.status,
                        price: r.price, // For started items
                        min: r.min_discounted_price,
                        max: r.max_discounted_price,
                        suggested: r.suggested_discounted_price,
                        original: r.original_price
                    };
                }
            });

            console.log(`[Promotions] Found ${candidateIds.length} unique items for campaign ${activeCampaignId}`);

            if (candidateIds.length > 0) {
                const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
                const batches = chunkArray(candidateIds, 20);

                for (const batch of batches) {
                    try {
                        const itemsResponse = await axios.get(`https://api.mercadolibre.com/items`, {
                            headers: { Authorization: `Bearer ${accessToken}` },
                            params: { ids: batch.join(',') }
                        });
                        // Items multiget returns [{code: 200, body: {...}}, ...]
                        const validItems = itemsResponse.data
                            .filter(res => res.code === 200 && res.body)
                            .map(res => {
                                const body = res.body;
                                body.promo_info = promoInfoMap[body.id] || {};
                                return body;
                            });

                        candidates = candidates.concat(validItems);
                    } catch (e) {
                        console.error('Batch Item Fetch Error:', e.message);
                    }
                }
            }
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
                <div class="promo-card">
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
                        <label class="input-label">Tu precio de oferta:</label>
                        <div class="modal-input-wrapper">
                            <input type="number" id="promoDealPrice" class="modal-input" placeholder="0.00">
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
                    
                    document.getElementById('promoDealPrice').value = data.current || data.suggested || data.original;
                    
                    document.getElementById('promoModal').style.display = 'flex';
                };

                window.closePromoModal = function() {
                    document.getElementById('promoModal').style.display = 'none';
                };

                document.getElementById('btnConfirmPromo').onclick = async function() {
                    const price = parseFloat(document.getElementById('promoDealPrice').value);
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

    try {
        await axios.post(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
            promotion_id,
            promotion_type,
            deal_price
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Apply Promo Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message
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
