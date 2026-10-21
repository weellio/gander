// Builds the no-install demo into ../docs/demo (GitHub Pages serves docs/).
//
//   cd web && npm run build:demo
//
// Cross-platform stand-in for `VITE_DEMO=1 vite build --config vite.demo.config.js`,
// plus the one thing Vite cannot do for us: copy the sprite sheets the Office
// floor draws from (the bridge serves them at /art/ out of assets/).
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const repo = path.resolve(web, '..');
const out = path.join(repo, 'docs', 'demo');

process.env.VITE_DEMO = '1';
await build({ configFile: path.join(web, 'vite.demo.config.js'), root: web, logLevel: 'info' });

const SHEETS = ['people_sprite_1.png', 'office_sprite_dark.png', 'general_sprite_1.png', 'general_sprite_2.png'];
fs.mkdirSync(path.join(out, 'art'), { recursive: true });
for (const f of SHEETS) fs.copyFileSync(path.join(repo, 'assets', f), path.join(out, 'art', f));
// the canned API answers (web/demo/*.json, from gen-demo-data.mjs) → docs/demo/demo/
const data = path.join(web, 'demo');
fs.mkdirSync(path.join(out, 'demo'), { recursive: true });
let n = 0;
for (const f of fs.readdirSync(data)) if (f.endsWith('.json')) { fs.copyFileSync(path.join(data, f), path.join(out, 'demo', f)); n++; }
// no Jekyll pass over the built page (harmless if Pages serves it raw anyway)
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`demo built → ${out} (${SHEETS.length} sprite sheets → art/, ${n} fixtures → demo/)`);
