const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.cpSync(path.join(root, 'src/web/facebook'), path.join(root, 'dist/src/web/facebook'), { recursive: true });
