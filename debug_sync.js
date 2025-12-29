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
                                                const basePrice = modal.dataset.originalPrice; 

                                                // Construct HTML with plain strings
                                                let newHtml = '<div class="promo-edit-container" data-item-id="' + itemId + '" data-promo-id="' + promoId + '" data-promo-type="' + promoType + '">';
                                                newHtml += '<div class="promo-display">';
                                                newHtml += '<div style="display: flex; align-items: center; gap: 5px;">';
                                                newHtml += '<div style="color: #00a650; font-weight: 700; font-size: 1.1rem;">$ <span class="promo-value-text">' + formattedPrice + '</span></div>';
                                                newHtml += '<button class="add-promo-btn" onclick="openAddPromoModal(\'' + itemId + '\', ' + basePrice + ')" title="Agregar Promoción" style="border: none; background: #e6f7ee; color: #00a650; font-weight: bold; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;">+</button>';
                                                newHtml += '</div>';
                                                newHtml += '<div style="font-size: 0.7rem; color: #666; background: #e6f7ee; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px;">En Promoción</div>';
                                                newHtml += '<button class="edit-price-btn" onclick="editPromoPrice(\'' + itemId + '\', ' + dealPrice + ')" style="margin-left: 5px;">✏️</button>';
                                                newHtml += '<div style="font-size: 0.75rem; color: #4da6ff; margin-top: 6px; line-height: 1.2; max-width: 180px; margin-left: auto; margin-right: auto;">' + promoName + '</div>';
                                                newHtml += '</div>';
                                                newHtml += '<div class="promo-edit-form" style="display: none; align-items: center; justify-content: center; gap: 5px; margin-top: 5px;">';
                                                newHtml += '<input type="number" class="promo-input" value="' + dealPrice + '" step="0.01" style="width: 80px; padding: 4px;" onkeydown="if(event.key===\'Enter\') savePromoPrice(\'' + itemId + '\')" />';
                                                newHtml += '<button class="save-price-btn" onclick="savePromoPrice(\'' + itemId + '\')">✓</button>';
                                                newHtml += '<button class="cancel-price-btn" onclick="cancelPromoEdit(\'' + itemId + '\')">✗</button>';
                                                newHtml += '</div></div>';
                                                
                                                promoCell.innerHTML = newHtml;
                                            }
                                        }

                                        alert('¡Éxito! Oferta aplicada correctamente.');
                                        closeAddPromoModal();
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