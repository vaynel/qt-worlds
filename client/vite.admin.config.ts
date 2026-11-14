import { defineConfig } from 'vite';

/**
 * 운영자 통계 dashboard (/admin): a separate, tiny build into dist/admin/ so the game
 * bundle, its chunks and the service worker's precache list stay exactly as they were.
 * The Node server serves these files to admins only (404 for everyone else).
 * Runs after the main build (which empties dist/), see package.json.
 */
export default defineConfig({
  root: 'admin',
  base: '/admin/',
  publicDir: false,
  build: {
    outDir: '../dist/admin',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  server: { fs: { allow: ['..'] } },
});
