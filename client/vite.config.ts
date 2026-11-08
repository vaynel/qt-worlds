import { defineConfig } from 'vite';

// Dev: Vite on 5180, game/API server on 5181. The browser always talks to the
// same origin (/api, /ws) and Vite forwards both, so phones on the LAN only
// need port 5180. xfwd adds X-Forwarded-For/Proto/Host (trusted by the server
// only from 127.0.0.1); changeOrigin stays off so the Origin/Host same-origin
// check on the server sees the real host. Production doesn't use Vite: the
// Node server serves client/dist itself (see deploy/README.md).
const serverTarget = process.env.WORLDS_SERVER ?? 'http://127.0.0.1:5181';
const proxy = {
  '/ws': { target: serverTarget, ws: true, changeOrigin: false, xfwd: true },
  '/api': { target: serverTarget, changeOrigin: false, xfwd: true },
};

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    allowedHosts: ['qt.log2u.me'],
    proxy,
    // ../shared holds the protocol used by both client and server.
    fs: { allow: ['..'] },
  },
  preview: { host: '0.0.0.0', port: 5180, strictPort: true, allowedHosts: ['qt.log2u.me'], proxy },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
