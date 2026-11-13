/**
 * 화면 품질 (render pixel-ratio budget), chosen in ⚙ → 🎨 화면.
 * Default is 선명: the owner wants good-looking graphics over battery savings.
 */
export type GraphicsQuality = 'saver' | 'normal' | 'sharp';

const KEY = 'worlds.graphics.quality';
const EVENT = 'worlds:graphics';

export const QUALITY_LABELS: Record<GraphicsQuality, { name: string; hint: string }> = {
  saver: { name: '🔋 절약', hint: '오래된 휴대폰, 배터리 아끼기' },
  normal: { name: '⚖️ 보통', hint: '화질과 배터리의 균형' },
  sharp: { name: '✨ 선명', hint: '가장 또렷한 화면 (기본)' },
};

export function graphicsQuality(): GraphicsQuality {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'saver' || v === 'normal' || v === 'sharp') return v;
  } catch {
    /* storage blocked */
  }
  return 'sharp';
}

export function setGraphicsQuality(q: GraphicsQuality) {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* storage blocked: applies for this visit only */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: q }));
}

export function onGraphicsQuality(fn: () => void) {
  window.addEventListener(EVENT, fn);
}

/**
 * Max device pixel ratio for the 3D canvas. `base` is the device class's
 * sharp budget (phones and tablets 1.5, desktop 1.75).
 */
export function maxPixelRatio(base: number, q: GraphicsQuality = graphicsQuality()): number {
  if (q === 'saver') return 1;
  if (q === 'normal') return Math.min(base, 1.25);
  return base;
}
