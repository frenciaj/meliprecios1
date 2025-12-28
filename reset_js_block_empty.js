const fs = require('fs');
const filePath = 'server.js';
const content = fs.readFileSync(filePath, 'utf8');

const startMarker = '// --- Add Promotion Logic ---';
const endMarker = '</script>';

const startIndex = content.indexOf(startMarker);
const endIndex = content.lastIndexOf(endMarker);

// Just empty stub
const newCode = `// --- Add Promotion Logic (Empty) ---
// Code removed for syntax check
`;

const fixedContent = content.substring(0, startIndex) + newCode + '\n' + content.substring(endIndex);

fs.writeFileSync(filePath, fixedContent);
console.log('Reset JS to empty.');
