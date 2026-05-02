
// --- LAZY LOAD ALL ITEM PROMOS ---
const PROMO_STATUS_COLORS = {
    started: { bg: '#e6f7ee', text: '#00a650', label: 'Activa' },
    active: { bg: '#e6f7ee', text: '#00a650', label: 'Activa' },
    candidate: { bg: '#fff7e0', text: '#b8860b', label: 'Candidata' }
};

async function loadItemPromos(itemId) {
    const container = document.getElementById('promos-' + itemId);
    if (!container) return;
    try {
        const res = await fetch('/api/item-promos/' + itemId);
        const data = await res.json();
        if (!data.success || !data.promos.length) {
            container.innerHTML = '<span style="color:#ccc;font-size:0.75rem;">—</span>';
            return;
        }
        container.innerHTML = data.promos.map(p => {
            const c = PROMO_STATUS_COLORS[p.status] || { bg: '#f5f5f5', text: '#999', label: p.status };
            const pct = p.discount_pct ? ` <strong>-${p.discount_pct}%</strong>` : '';
            const price = p.price ? ' · $' + Number(p.price).toLocaleString('es-AR') : '';
            return `<div style="background:${c.bg};color:${c.text};border-radius:6px;padding:3px 7px;font-size:0.72rem;margin-bottom:3px;line-height:1.4;max-width:160px;word-break:break-word;text-align:left;">
                        <span style="font-weight:600;">${p.name}</span>${pct}${price}
                    </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = '<span style="color:#ccc;font-size:0.7rem;">err</span>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const cells = document.querySelectorAll('.promo-cell');
    cells.forEach((cell, idx) => {
        const id = cell.dataset.itemId;
        if (id) setTimeout(() => loadItemPromos(id), idx * 80); // stagger 80ms each to avoid rate limits
    });
});

// --- TOAST NOTIFICATIONS ---

function showToast(message, type = 'info') {
    let tContainer = document.getElementById('toast-container');
    if (!tContainer) {
        tContainer = document.createElement('div');
        tContainer.id = 'toast-container';
        tContainer.style.position = 'fixed';
        tContainer.style.top = '20px';
        tContainer.style.right = '20px';
        tContainer.style.zIndex = '100000';
        tContainer.style.display = 'flex';
        tContainer.style.flexDirection = 'column';
        tContainer.style.gap = '10px';
        document.body.appendChild(tContainer);
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.background = message.includes('Error') || message.includes('⚠️') ? '#d32f2f' : '#00a650';
    toast.style.color = 'white';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    toast.style.fontWeight = '600';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    toast.style.transition = 'all 0.3s ease';
    tContainer.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-20px)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function showConfirm(message) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed'; overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.width = '100%'; overlay.style.height = '100%'; overlay.style.background = 'rgba(0,0,0,0.5)'; overlay.style.zIndex = '100000'; overlay.style.display = 'flex'; overlay.style.alignItems = 'center'; overlay.style.justifyContent = 'center';
        const box = document.createElement('div');
        box.style.background = 'white'; box.style.padding = '30px'; box.style.borderRadius = '12px'; box.style.maxWidth = '400px'; box.style.textAlign = 'center';
        box.innerHTML = '<div style="font-size:1.1rem;font-weight:600;margin-bottom:20px;">' + message + '</div>';
        const btnContainer = document.createElement('div'); btnContainer.style.display = 'flex'; btnContainer.style.gap = '10px'; btnContainer.style.justifyContent = 'center';
        const btnYes = document.createElement('button'); btnYes.textContent = 'Aceptar'; btnYes.style.background = '#3483fa'; btnYes.style.color = 'white'; btnYes.style.padding = '10px 24px'; btnYes.style.borderRadius = '6px'; btnYes.style.border = 'none'; btnYes.style.cursor = 'pointer'; btnYes.onclick = () => { overlay.remove(); resolve(true); };
        const btnNo = document.createElement('button'); btnNo.textContent = 'Cancelar'; btnNo.style.background = '#eee'; btnNo.style.color = '#333'; btnNo.style.padding = '10px 24px'; btnNo.style.borderRadius = '6px'; btnNo.style.border = 'none'; btnNo.style.cursor = 'pointer'; btnNo.onclick = () => { overlay.remove(); resolve(false); };
        btnContainer.append(btnNo, btnYes); box.appendChild(btnContainer); overlay.appendChild(box); document.body.appendChild(overlay);
    });
}

// ===== BULK SELECTION & PROMO =====
function toggleSelectAll(masterCb) {
    document.querySelectorAll('.item-checkbox').forEach(cb => {
        cb.checked = masterCb.checked;
    });
    updateSelectionBar();
}

function updateSelectionBar() {
    const checked = document.querySelectorAll('.item-checkbox:checked');
    const bar = document.getElementById('bulk-bar');
    const countEl = document.getElementById('bulk-count');
    if (checked.length > 0) {
        bar.style.display = 'block';
        countEl.textContent = checked.length;
    } else {
        bar.style.display = 'none';
    }
}

function clearSelection() {
    document.querySelectorAll('.item-checkbox').forEach(cb => cb.checked = false);
    const masterCb = document.getElementById('select-all-cb');
    if (masterCb) masterCb.checked = false;
    updateSelectionBar();
}

async function bulkApplyPromo() {
    const campaignSelect = document.getElementById('bulk-campaign-select');
    const discountInput = document.getElementById('bulk-discount');
    const selectedOption = campaignSelect.options[campaignSelect.selectedIndex];

    const promotionId = campaignSelect.value;
    const promotionType = selectedOption?.dataset?.type || 'SELLER_CAMPAIGN';
    const discountPercent = parseFloat(discountInput.value);

    if (!promotionId) return showToast('⚠️ Por favor elige una campaña.');
    if (!discountPercent || discountPercent <= 0 || discountPercent >= 100) return showToast('⚠️ Ingresá un porcentaje válido (1–99).');

    const checkedBoxes = document.querySelectorAll('.item-checkbox:checked');
    if (checkedBoxes.length === 0) return showToast('⚠️ No hay productos seleccionados.');

    const items = Array.from(checkedBoxes).map(cb => ({
        item_id: cb.dataset.itemId,
        base_price: parseFloat(cb.dataset.itemPrice)
    }));

    if (!await showConfirm('¿Aplicar ' + discountPercent + '% de descuento en ' + items.length + ' productos?')) return;

    const applyBtn = document.querySelector('#bulk-bar button');
    const originalText = applyBtn.innerHTML;
    applyBtn.disabled = true;
    applyBtn.innerHTML = '⏳ Aplicando...';

    try {
        const res = await fetch('/bulk-apply-promotion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, promotion_id: promotionId, promotion_type: promotionType, discount_percent: discountPercent })
        });
        const data = await res.json();
        if (data.success) {
            const msg = '✅ Listo!\n' +
                '• Aplicado: ' + data.applied + ' productos\n' +
                (data.failed > 0 ? '• Fallaron: ' + data.failed + ' productos' : '');
            showToast(msg);
            clearSelection();
            location.reload();
        } else {
            showToast('Error: ' + (data.error || 'Desconocido'));
        }
    } catch (e) {
        showToast('Error de red: ' + e.message);
    } finally {
        applyBtn.disabled = false;
        applyBtn.innerHTML = originalText;
    }
}

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
            showToast('Sync Complete! Processed ' + data.count + ' items.'); setTimeout(() => location.reload(), 2000);
        } else {
            showToast('Sync Error: ' + data.error);
        }
    } catch (e) {
        showToast('Sync Failed: ' + e.message);
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
            showToast('Error updating price: ' + data.error);
            btn.innerHTML = '✓';
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            showToast('Error: Request timed out.');
        } else {
            showToast('Error: ' + e.message);
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
            showToast('Error updating quantity: ' + data.error);
            btn.disabled = false;
            btn.innerHTML = '✓';
        }
    } catch (e) {
        showToast('Error: ' + e.message);
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
        showToast('Error: Missing promotion data');
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

            showToast('Error updating promo: ' + errorMsg);
            btn.disabled = false;
            btn.innerHTML = '✓';
        }
    } catch (e) {
        showToast('Error: ' + e.message);
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
        radio.onchange = function () { selectPromoCandidate(p); };

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
        showToast('Por favor selecciona una promoción');
        return;
    }

    if (document.getElementById('promo-config-section').style.display !== 'none' && !dealPrice) {
        showToast('Por favor ingresa un precio para la oferta.');
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
                    addBtn.onclick = function () { openAddPromoModal(itemId, basePrice); };
                    headDiv.appendChild(addBtn);

                    const badge = document.createElement('div');
                    badge.textContent = 'En Promoción';
                    badge.style.cssText = 'font-size: 0.7rem; color: #666; background: #e6f7ee; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px;';

                    const editBtn = document.createElement('button');
                    editBtn.className = 'edit-price-btn';
                    editBtn.textContent = '✏️';
                    editBtn.style.marginLeft = '5px';
                    editBtn.onclick = function () { editPromoPrice(itemId, dealPrice); };

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
                    input.onkeydown = function (e) { if (e.key === 'Enter') savePromoPrice(itemId); };

                    const saveBtn = document.createElement('button');
                    saveBtn.className = 'save-price-btn';
                    saveBtn.textContent = '✓';
                    saveBtn.onclick = function () { savePromoPrice(itemId); };

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'cancel-price-btn';
                    cancelBtn.textContent = '✗';
                    cancelBtn.onclick = function () { cancelPromoEdit(itemId); };

                    formDiv.appendChild(input);
                    formDiv.appendChild(saveBtn);
                    formDiv.appendChild(cancelBtn);

                    container.appendChild(displayDiv);
                    container.appendChild(formDiv);
                    promoCell.appendChild(container);
                }
            }

            showToast('¡Éxito! Oferta aplicada correctamente.');
            closeAddPromoModal();

            // Dynamic Net Income Update
            updateNetIncome(itemId, dealPrice);
        } else {
            const errMsg = data.details?.message || data.error || 'Error desconocido';
            showToast('Error al unirse: ' + errMsg);
            console.error(data);
        }
    } catch (e) {
        showToast('Error de red: ' + e.message);
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
