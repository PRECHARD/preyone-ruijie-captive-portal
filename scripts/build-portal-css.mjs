import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'css', 'portal');
const outFile = path.join(root, 'public', 'css', 'portal.css');

// Cascade order matters. The modal partial is last so its responsive rules
// beat the generic `_responsive.css` overrides.
const order = [
  '_base.css',
  '_header.css',
  '_hero.css',
  '_forms.css',
  '_features.css',
  '_packages.css',
  '_buttons.css',
  '_success.css',
  '_terms.css',
  '_footer.css',
  '_responsive.css',
  '_modal.css',
];

const missing = order.filter((f) => !fs.existsSync(path.join(dir, f)));
if (missing.length) {
  console.error(`Missing partials: ${missing.join(', ')}`);
  process.exit(1);
}

let out = '';
for (const file of order) {
  const css = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\s*$/, '');
  out += `/* portal/${file} */\n${css}\n\n`;
}

fs.writeFileSync(outFile, out.trimEnd() + '\n');
console.log(`Built public/css/portal.css from ${order.length} partials (${out.length} bytes).`);
