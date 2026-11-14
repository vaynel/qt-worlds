// Shared tablet-layout probe used by m52-test.mjs (and the before-fix capture).
export const TABLETS = [
  ['ipad-mini', 768, 1024],
  ['ipad-air', 820, 1180],
  ['ipad-pro', 1024, 1366],
  ['galaxy-tab', 800, 1280],
  ['ipad-mini-land', 1024, 768],
  ['ipad-air-land', 1180, 820],
  ['ipad-pro-land', 1366, 1024],
  ['galaxy-tab-land', 1280, 800],
];

export const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Bounding boxes of everything that must not collide with the campfire chat. */
export async function layoutBoxes(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (el.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const q = (s) => vis(document.querySelector(s));
    return {
      viewport: { width: innerWidth, height: innerHeight, vvh: visualViewport?.height ?? innerHeight },
      chat: q('#chat'),
      input: q('#chat-input'),
      log: q('#chat-log'),
      voice: q('#voice-chip'),
      joystick: q('#stick-base'),
      stickZone: q('#stick-zone'),
      tools: q('#tools'),
      place: q('.place-card'),
      clock: q('.clock-card'),
      action: q('#action-btn'),
      emote: q('#emote-btn'),
      camera: q('#camera-btn'),
      bodyClass: document.body.className,
    };
  });
}
