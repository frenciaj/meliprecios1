const fs = require('fs');
const filePath = 'server.js';
const content = fs.readFileSync(filePath, 'utf8');

const startMarker = '// --- Add Promotion Logic ---';
const endMarker = 'function selectPromoCandidate';

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find markers');
    process.exit(1);
}

const newCode = `// --- Add Promotion Logic ---
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
                                        '<input type="radio" name="selectedPromo" value="' + offerId + '" onchange="selectPromoCandidate(\\'' + offerId + '\\', \\'' + type + '\\')">';
                                    
                                    listContainer.appendChild(div);
                                });
                            }

                            `;

const fixedContent = content.substring(0, startIndex) + newCode + content.substring(endIndex);
fs.writeFileSync(filePath, fixedContent);
console.log('Successfully replaced functions.');
