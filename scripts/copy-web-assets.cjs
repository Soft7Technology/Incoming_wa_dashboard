const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const feature of ['google-sheets', 'google-people', 'shopify', 'credits']) {
  fs.cpSync(path.join(root, 'src/web', feature), path.join(root, 'dist/src/web', feature), { recursive: true });
}
fs.copyFileSync(path.join(root, 'swagger.json'), path.join(root, 'dist/swagger.json'));
