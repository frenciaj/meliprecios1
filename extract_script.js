const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('<script>'));
const end = lines.findIndex(l => l.includes('</script>'));
if (start === -1 || end === -1) {
    console.log('Script tag not found');
    process.exit(1);
}
const script = lines.slice(start + 1, end).join('\n');
fs.writeFileSync('debug_sync.js', script);
console.log(`Extracted lines ${start + 1} to ${end}`);
