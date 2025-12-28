const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const start = content.indexOf('<script>') + 8;
const end = content.indexOf('</script>');
const scriptContent = content.substring(start, end);
fs.writeFileSync('client_script_check.js', scriptContent);
console.log(' extracted js length:', scriptContent.length);
