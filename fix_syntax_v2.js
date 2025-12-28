const fs = require('fs');
const path = 'server.js';
try {
    let content = fs.readFileSync(path, 'utf8');

    // Pattern 1: Missing backticks (Current Error State)
    // matches: fetch(/debug-promo/${itemId})
    const broken1 = 'fetch(/debug-promo/${itemId})';
    const fixed = 'fetch(`/debug-promo/${itemId}`)';

    // Pattern 2: Spaces + Missing backticks
    const broken2 = 'fetch(/ debug - promo / ${ itemId })';

    let fixedContent = content;
    if (fixedContent.includes(broken1)) {
        fixedContent = fixedContent.replace(broken1, fixed);
        console.log('Fixed Pattern 1 (Missing Backticks)');
    }
    if (fixedContent.includes(broken2)) {
        fixedContent = fixedContent.replace(broken2, fixed);
        console.log('Fixed Pattern 2 (Spaces + Missing Backticks)');
    }

    // Safety: If for some reason backticks ARE there but inside is wrong
    const broken3 = 'fetch(`/ debug - promo / ${ itemId }`)';
    if (fixedContent.includes(broken3)) {
        fixedContent = fixedContent.replace(broken3, fixed);
        console.log('Fixed Pattern 3 (Spaces with Backticks)');
    }

    fs.writeFileSync(path, fixedContent);
} catch (e) {
    console.error(e);
}
