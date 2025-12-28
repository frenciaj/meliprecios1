const fs = require('fs');
const path = 'server.js';
try {
    let content = fs.readFileSync(path, 'utf8');
    // The previous error showed this exact string with spaces
    // We target it explicitly and replace with clean code
    const badString = '/ debug - promo / ${ itemId }';
    const goodString = '/debug-promo/${itemId}';

    if (content.includes(badString)) {
        content = content.replace(badString, goodString);
        fs.writeFileSync(path, content);
        console.log('Fixed syntax error via script.');
    } else {
        console.log('Target string not found, trying regex fallback...');
        // Fallback for variation in spaces
        content = content.replace(/\/ debug - promo \/ \$\{ itemId \}/g, '/debug-promo/${itemId}');
        fs.writeFileSync(path, content);
        console.log('Fixed (or attempted fix) via regex.');
    }
} catch (e) {
    console.error('Error fixing file:', e);
}
