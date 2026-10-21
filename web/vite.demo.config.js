import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.js';

// The no-install demo build (npm run build:demo → ../docs/demo, served by
// GitHub Pages at https://weellio.github.io/gander/demo/). Same app, three
// differences: VITE_DEMO=1 switches main.js onto the demo shim, the page lives
// under a sub-path so the few hard-coded absolute asset URLs get the base
// prefixed, and the service worker is not registered (nothing to keep fresh).
export const DEMO_BASE = process.env.DEMO_BASE || '/gander/demo/';

function demoPaths(base) {
  return {
    name: 'gander-demo-paths',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]web[\\/]src[\\/]/.test(id)) return null;
      const out = code
        .replace(/(['"`])\/art\//g, `$1${base}art/`)
        .replace(/(['"`])\/goose\.png/g, `$1${base}goose.png`)
        .replace(/(['"`])\/actions\//g, `$1${base}actions/`);
      return out === code ? null : { code: out, map: null };
    },
    transformIndexHtml(html) {
      return html
        .replace(/href="\/(goose\.png|icon\.png|manifest\.webmanifest)"/g, `href="${base}$1"`)
        .replace(/<script>\s*if \('serviceWorker' in navigator\)[\s\S]*?<\/script>/, '')
        .replace('<title>Gander · Claude Code NOC</title>', '<title>Gander · live demo</title>');
    },
  };
}

export default mergeConfig(baseConfig, defineConfig({
  base: DEMO_BASE,
  plugins: [demoPaths(DEMO_BASE)],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  build: { outDir: '../docs/demo', emptyOutDir: true },
}));
