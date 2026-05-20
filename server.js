require('dotenv').config();

const path = require('path');
const fs = require('fs');

const distIndex = path.join(__dirname, 'dist', 'index.js');

if (fs.existsSync(distIndex)) {
  require(distIndex);
} else {
  console.log('[server.js] Compiled dist/index.js not found — falling back to ts-node');
  require('ts-node').register({ transpileOnly: true });
  require('./src/index.ts');
}
