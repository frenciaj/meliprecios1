const fs = require('fs');
const filePath = 'server.js';
let content = fs.readFileSync(filePath, 'utf8');

const targetContext = '// Use debug-promo as proxy for "get eligible" for now';
const lines = content.split('\n');
let fixed = false;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(targetContext)) {
        // Check next line for fetch
        if (lines[i + 1] && lines[i + 1].includes('fetch')) {
            console.log('Found target line at ' + (i + 2) + ': ' + lines[i + 1]);
            // Preserve indentation roughly (36 spaces)
            lines[i + 1] = "                                    const res = await fetch('/debug-promo/' + itemId);";
            fixed = true;
            console.log('Replaced with: ' + lines[i + 1]);
        }
    }
}

if (fixed) {
    fs.writeFileSync(filePath, lines.join('\n'));
    console.log('File updated successfully.');
} else {
    console.log('Context not found. Dumping nearby lines for debugging:');
    const idx = lines.findIndex(l => l.includes('debug-promo'));
    if (idx !== -1) {
        console.log(lines.slice(idx - 2, idx + 3).join('\n'));
    }
}
