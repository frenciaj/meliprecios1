const fs = require('fs');
const filePath = 'server.js';
const content = fs.readFileSync(filePath, 'utf8');

const startMarker = '// --- Add Promotion Logic ---';
// We replace until the </script> tag, preserving the tag itself.
const endMarker = '</script>';

const startIndex = content.indexOf(startMarker);
const endIndex = content.lastIndexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find markers');
    process.exit(1);
}

const newCode = `// --- Add Promotion Logic (Restored) ---
                            async function openAddPromoModal(itemId, currentPrice) {
                                console.log('Open Modal', itemId);
                                const modal = document.getElementById('add-promo-modal');
                                const listContainer = document.getElementById('promo-candidates-list');
                                const configSection = document.getElementById('promo-config-section');
                                const joinBtn = document.getElementById('btn-join-promo');
                                
                                modal.style.display = 'flex';
                                listContainer.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">Cargando...</div>';
                                configSection.style.display = 'none';
                                joinBtn.disabled = true;
                                
                                modal.dataset.itemId = itemId;
                                modal.dataset.originalPrice = currentPrice;

                                try {
                                    // Debug fetch
                                    const res = await fetch('/debug-promo/' + itemId);
                                    const promos = await res.json();
                                    
                                    // Render Debug
                                    const pre = document.createElement('pre');
                                    pre.style.fontSize = '10px';
                                    pre.style.maxHeight = '100px';
                                    pre.style.overflow = 'auto';
                                    pre.textContent = JSON.stringify(promos, null, 2);
                                    listContainer.innerHTML = '';
                                    listContainer.appendChild(pre);

                                    renderPromoCandidates(promos);
                                } catch (e) {
                                    listContainer.innerHTML = '<div style="color:red">Error: ' + e.message + '</div>';
                                }
                            }

                            function renderPromoCandidates(promos) {
                                console.log('Rendering candidates...');
                                const list = document.getElementById('promo-candidates-list');
                                const msg = document.createElement('div');
                                msg.innerHTML = '<b>Promotions fetched (Check JSON above)</b>';
                                list.appendChild(msg);
                            }

                            function selectPromoCandidate(id, type) {
                                console.log('Selected:', id, type);
                            }

                            function closeAddPromoModal() {
                                document.getElementById('add-promo-modal').style.display = 'none';
                            }

                            function submitJoinPromo() {
                                alert('Submit not implemented yet');
                            }

                            function applyListingsSort() {
                                const sortValue = document.getElementById('sortBy').value;
                                const url = new URL(window.location);
                                url.searchParams.set('sort', sortValue);
                                url.searchParams.set('page', '1');
                                window.location.href = url.toString();
                            }
                    `;

// Construct new content
// Note: We need to append the spaces before </script> to match indentation if we want, 
// but essentially we just slice and insert.
const fixedContent = content.substring(0, startIndex) + newCode + '\n' + content.substring(endIndex);

fs.writeFileSync(filePath, fixedContent);
console.log('Successfully reset JS block.');
