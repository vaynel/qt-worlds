/* QT 월드 service worker (hand-written; see deploy/README.md "PWA").
 *
 * The build (vite.config.ts, plugin "worlds-sw") prepends two constants:
 *   SW_VERSION  - hash of every precached file (changes on each deploy)
 *   PRECACHE    - ["/index.html", "/assets/...", icons, manifest]
 *
 * Rules:
 *   - navigations: network first; offline -> cached page (/privacy -> /privacy.html,
 *     else /index.html) -> inline offline page
 *   - /assets/* (content-hashed): cache first
 *   - other precached same-origin files (icons, manifest): cache first
 *   - everything else (/api/*, /ws, /health, /sw.js, YouTube, Google, any
 *     cross-origin URL, non-GET): not touched, straight to the network
 *   - a new version waits until the page asks (SKIP_WAITING), old caches are
 *     deleted on activate
 *   - push: show the notification; notificationclick: focus or open the app
 */
/* global SW_VERSION, PRECACHE */

const CACHE = `qt-worlds-${SW_VERSION}`;
const PREFIX = 'qt-worlds-';

const OFFLINE_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#25304d"><title>QT 월드 · 연결 끊김</title>
<style>
  html,body{margin:0;height:100%;background:#25304d;color:#f2e6cf;font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;text-align:center}
  .lamp{width:72px;height:72px}
  h1{font-size:20px;margin:6px 0 0;font-weight:700}
  p{margin:0;opacity:.85;line-height:1.6;font-size:15px}
  button{margin-top:10px;font:inherit;font-weight:700;font-size:16px;padding:12px 28px;border-radius:999px;border:0;background:#f5c26b;color:#3a2a1c;cursor:pointer}
</style></head>
<body><main id="offline-page">
  <img class="lamp" src="/favicon.svg" alt="">
  <h1>연결이 끊겼어요</h1>
  <p>다시 연결되면 자동으로 이어져요.</p>
  <button type="button" id="offline-retry">다시 시도</button>
</main>
<script>
  var go = function () { location.reload(); };
  document.getElementById('offline-retry').addEventListener('click', go);
  addEventListener('online', go);
  setInterval(function () {
    fetch('/health', { cache: 'no-store' }).then(function (r) { if (r.ok) go(); }).catch(function () {});
  }, 5000);
</script></body></html>`;

const NEVER = /^\/(api\/|ws$|ws\/|health$|sw\.js$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' so the HTTP cache never hands us a stale index.html.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
  // No skipWaiting() here: the page shows "새 버전이 있어요" and asks first.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'VERSION' && event.ports[0]) event.ports[0].postMessage({ version: SW_VERSION, precache: PRECACHE.length });
});

const offlinePage = () =>
  new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'",
    },
  });

async function navigate(request) {
  let res = null;
  try {
    res = await fetch(request);
  } catch {
    res = null;
  }
  // Behind Cloudflare a stopped server answers 502/503/504: treat as offline.
  if (res && !(res.status >= 502 && res.status <= 504)) return res;
  // Static pages (/privacy, /terms) have their own precached file.
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  const own = path && PRECACHE.includes(`${path}.html`) ? await caches.match(`${path}.html`, { cacheName: CACHE }) : null;
  if (own) return own;
  const shell = await caches.match('/index.html', { cacheName: CACHE });
  return shell || res || offlinePage();
}

async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url.pathname);
  if (hit) return hit;
  const res = await fetch(request);
  // Only content-hashed files are stored at runtime (safe forever).
  if (res.ok && url.pathname.startsWith('/assets/')) await cache.put(url.pathname, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // YouTube, Google, CDNs: never
  if (NEVER.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.search) return;
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, url));
  }
});

// ------------------------------------------------------------------ push

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'QT 월드';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    lang: 'ko',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = '/';
  try {
    const u = new URL(event.notification.data && event.notification.data.url, self.location.origin);
    if (u.origin === self.location.origin) target = u.pathname + u.search;
  } catch {
    target = '/';
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        await w.focus();
        w.postMessage({ type: 'NOTIFICATION_CLICK', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
