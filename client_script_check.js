
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

                            // --- Add Promotion Logic ---
                            async function openAddPromoModal(itemId, currentPrice) {
                                const modal = document.getElementById('add-promo-modal');
                                const listContainer = document.getElementById('promo-candidates-list');
                                const configSection = document.getElementById('promo-config-section');
                                const joinBtn = document.getElementById('btn-join-promo');
                                
                                modal.style.display = 'flex';
                                listContainer.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">Cargando promociones...</div>';
                                configSection.style.display = 'none';
                                joinBtn.disabled = true;
                                
                                // Store current item context
                                modal.dataset.itemId = itemId;
                                modal.dataset.originalPrice = currentPrice;

                                try {
                                    // Use debug-promo as proxy for "get eligible" for now
                                    const res = await fetch('/debug-promo/' + itemId);
                                    const promos = await res.json();
                                    
                                    // DEBUG: Dump raw JSON to check structure
                                    const debugDisplay = document.createElement('pre');
                                    debugDisplay.style.fontSize = '0.7rem';
                                    debugDisplay.style.background = '#f5f5f5';
                                    debugDisplay.style.padding = '10px';
                                    debugDisplay.style.maxHeight = '100px';
                                    debugDisplay.style.overflow = 'auto';
                                    debugDisplay.textContent = JSON.stringify(promos, null, 2);
                                    listContainer.appendChild(debugDisplay);

                                    renderPromoCandidates(promos);
                                } catch (error) {
                                    listContainer.innerHTML = '<div style="color: red; text-align: center;">Error al cargar promociones: ' + error.message + '</div>';
                                }
                            }

                            function renderPromoCandidates(promos) {
                                const listContainer = document.getElementById('promo-candidates-list');
                                // Don't clear innerHTML immediately so we keep the debug pre
                                const existingDebug = listContainer.querySelector('pre');
                                listContainer.innerHTML = '';
                                if (existingDebug) listContainer.appendChild(existingDebug);

                                let candidates = [];
                                if (Array.isArray(promos)) {
                                    candidates = promos;
                                } else if (promos && promos.results && Array.isArray(promos.results)) {
                                    candidates = promos.results;
                                } else if (promos) {
                                     // Only wrap in array if it looks like a single item (has id/type)
                                     if (promos.id || promos.type) candidates = [promos];
                                }

                                if (candidates.length === 0) {
                                    const noPromoDiv = document.createElement('div');
                                    noPromoDiv.style.textAlign = 'center';
                                    noPromoDiv.style.color = '#666';
                                    noPromoDiv.style.padding = '20px';
                                    noPromoDiv.textContent = 'No hay promociones disponibles o estructura desconocida.';
                                    listContainer.appendChild(noPromoDiv);
                                    return;
                                }

                                candidates.forEach(promo => {
                                    const div = document.createElement('div');
                                    div.style.padding = '10px';
                                    div.style.borderBottom = '1px solid #eee';
                                    div.style.cursor = 'pointer';
                                    div.style.display = 'flex';
                                    div.style.justifyContent = 'space-between';
                                    div.style.alignItems = 'center';
                                    
                                    // Try to find name/id/type
                                    const name = promo.name || promo.id || 'Promoción sin nombre';
                                    const type = promo.type || 'N/A';
                                    const offerId = promo.id || '';

                                    // Using concatenation to avoid backtick issues
                                    div.innerHTML = 
                                        '<div>' +
                                            '<div style="font-weight: 600; color: #333;">' + name + '</div>' +
                                            '<div style="font-size: 0.8rem; color: #666;">Type: ' + type + '</div>' +
                                        '</div>' +
                                        '<input type="radio" name="selectedPromo" value="' + offerId + '" onchange="selectPromoCandidate(\'' + offerId + '\', \'' + type + '\')">';
                                    
                                    listContainer.appendChild(div);
                                });
                            }

                            function selectPromoCandidate(promoId, promoType) {
                            document.getElementById('promo-config-section').style.display = 'block';
                        document.getElementById('btn-join-promo').disabled = false;
                            }

                        function closeAddPromoModal() {
                            document.getElementById('add-promo-modal').style.display = 'none';
                            }

                        function submitJoinPromo() {
                            alert("Join Promo Logic Implementation Pending");
                            }

                        function applyListingsSort() {
                                const sortValue = document.getElementById('sortBy').value;
                        const url = new URL(window.location);
                        url.searchParams.set('sort', sortValue);
                        url.searchParams.set('page', '1');
                        window.location.href = url.toString();
                            }
                    