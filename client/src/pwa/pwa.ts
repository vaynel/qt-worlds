/**
 * PWA glue: service worker registration + "새 버전이 있어요" toast, the
 * install prompt (beforeinstallprompt / iOS 홈 화면에 추가 guide) and Web Push
 * subscription helpers. The service worker is registered only in production
 * builds (vite build / preview / the Node server), never under `vite` dev.
 */
import { button, el } from '../ui/dom';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Optional build label (WORLDS_BUILD_TAG at build time), shown as <html data-build>. */
const buildTag = __BUILD_TAG__;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((fn) => fn());

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Running as an installed app (home screen / desktop window). */
export function isStandalone(): boolean {
  return (
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches
  );
}

/** What install help we can offer here: a real prompt, the iOS guide, or nothing. */
export function installMode(): 'prompt' | 'ios' | null {
  if (installed || isStandalone()) return null;
  if (deferredPrompt) return 'prompt';
  if (isIOS()) return 'ios';
  return null;
}

export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/** Shows the browser's install dialog (must run inside a tap). */
export async function promptInstall(): Promise<boolean> {
  const ev = deferredPrompt;
  if (!ev) return false;
  deferredPrompt = null;
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice.outcome === 'accepted') installed = true;
    return choice.outcome === 'accepted';
  } catch {
    return false;
  } finally {
    notifyInstall();
  }
}

// ------------------------------------------------------------------ service worker + update toast

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;
let toastEl: HTMLElement | null = null;

function showUpdateToast(worker: ServiceWorker) {
  if (toastEl) return;
  const box = el('div', 'sw-update card');
  box.id = 'sw-update';
  box.setAttribute('role', 'status');
  box.append(el('span', 'sw-update-text', '새 버전이 있어요'));
  const go = button('새로고침', 'primary', () => {
    go.disabled = true;
    // The new worker takes over; 'controllerchange' then reloads once.
    worker.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => {
      if (!reloading) {
        reloading = true;
        location.reload();
      }
    }, 4000);
  });
  go.id = 'sw-update-reload';
  box.append(go);
  document.body.append(box);
  toastEl = box;
}

function watch(reg: ServiceWorkerRegistration) {
  // A worker already waiting from an earlier visit.
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      // Only an *update* (a controller exists); the first install is silent.
      if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(w);
    });
  });
}

async function register() {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    registration = reg;
    watch(reg);
    // Look for a new deploy now and then, and whenever the app comes back.
    const check = () => void reg.update().catch(() => undefined);
    setInterval(check, 30 * 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch (err) {
    console.warn('service worker registration failed', err);
  }
}

export function initPwa() {
  if (buildTag) document.documentElement.dataset.build = buildTag;
  window.addEventListener('beforeinstallprompt', (e) => {
    // We show our own gentle button instead of the browser's mini-infobar.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    notifyInstall();
  });
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  if (new URLSearchParams(location.search).get('nosw') === '1') return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload only when the user asked for the new version (the toast exists).
    if (reloading || !toastEl) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === 'NOTIFICATION_CLICK') window.dispatchEvent(new CustomEvent('worlds-notification-click', { detail: d.url ?? '/' }));
  });
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

// ------------------------------------------------------------------ push

export type PushSupport = 'ok' | 'ios-needs-install' | 'unsupported';

export function pushSupport(): PushSupport {
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOS() && !isStandalone()) return 'ios-needs-install';
  return ok ? 'ok' : 'unsupported';
}

export function notificationPermission(): NotificationPermission {
  return 'Notification' in window ? Notification.permission : 'denied';
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = registration ?? (await navigator.serviceWorker.getRegistration('/').catch(() => undefined)) ?? null;
  if (!reg || reg.active) return reg;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await readyRegistration();
  if (!reg?.pushManager) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask permission (call from a tap) and subscribe. Returns the permission result. */
export async function subscribePush(publicKey: string): Promise<{ permission: NotificationPermission; sub: PushSubscription | null }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { permission, sub: null };
  const reg = await readyRegistration();
  if (!reg) throw new Error('no service worker');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be reused.
  if (sub) {
    const existing = sub.options?.applicationServerKey;
    const want = keyBytes(publicKey);
    const same = existing && new Uint8Array(existing).every((b, i) => b === want[i]) && existing.byteLength === want.length;
    if (!same) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return { permission, sub };
}

