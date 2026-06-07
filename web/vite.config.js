import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Builds the dashboard into ../dashboard/dist, which the bridge serves.
// During dev (`npm run dev`), /api is proxied to the running bridge on 3131.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  build: {
    outDir: '../dashboard/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3131' },
  },
});
