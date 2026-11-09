/* QT 월드 service worker KILL SWITCH.
 * Build with WORLDS_SW_KILL=1 (see deploy/README.md) to ship this as /sw.js.
 * Browsers that check for an update install it; it deletes every qt-worlds
 * cache, unregisters itself and reloads open tabs so they come straight from
 * the network again. Nothing else is intercepted.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('qt-worlds-')) await caches.delete(key);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
    })(),
  );
});
