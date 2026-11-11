import {
  HAIR_COLORS,
  HAIR_STYLES,
  ROBE_COLORS,
  SCARF_COLORS,
  SKIN_COLORS,
  validateAppearance,
  validateOutfitPixels,
  type Appearance,
} from '../../../shared/protocol';
import type { AvatarLook } from '../entities/Avatar';

/** Palette indices (what the server stores) to the colours Avatar draws. */
export function avatarLook(a: Appearance): AvatarLook {
  return {
    robe: ROBE_COLORS[a.r],
    scarf: SCARF_COLORS[a.s],
    skin: SKIN_COLORS[a.k],
    hair: HAIR_COLORS[a.h],
    hairStyle: HAIR_STYLES[a.y],
  };
}

/** A look from the network, re-validated (never trust indices blindly). */
export function safeAppearance(raw: unknown): Appearance | null {
  if (!raw || typeof raw !== 'object') return null;
  const { r, s, k, h, y } = raw as Record<string, unknown>;
  return validateAppearance({ r, s, k, h, y });
}

/**
 * Outfit pixels by id. Requests made in the same moment are batched into one
 * GET /api/outfits?ids=…, and each id is fetched once per page load (outfit
 * rows are immutable: editing makes a new id). Data is validated before use.
 */
export class OutfitCache {
  private readonly pixels = new Map<number, string>();
  private readonly waiting = new Map<number, ((pixels: string | null) => void)[]>();
  private timer = 0;
  requests = 0;

  get(id: number): string | undefined {
    return this.pixels.get(id);
  }

  /** Known pixels right away, or fetched soon. null = not available (hidden, gone, offline). */
  load(id: number, done: (pixels: string | null) => void) {
    const hit = this.pixels.get(id);
    if (hit) return done(hit);
    const list = this.waiting.get(id);
    if (list) return void list.push(done);
    this.waiting.set(id, [done]);
    if (!this.timer) this.timer = window.setTimeout(() => void this.flush(), 40);
  }

  /** Seed the cache with pixels we already hold (our own saved slots). */
  remember(id: number, pixels: string) {
    const ok = validateOutfitPixels(pixels);
    if (ok) this.pixels.set(id, ok);
  }

  private async flush() {
    this.timer = 0;
    const ids = [...this.waiting.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      let got: { id: number; pixels: string }[] = [];
      try {
        this.requests++;
        const res = await fetch(`/api/outfits?ids=${chunk.join(',')}`, { credentials: 'same-origin' });
        if (res.ok) got = ((await res.json()) as { outfits?: { id: number; pixels: string }[] }).outfits ?? [];
      } catch {
        /* offline: leave it plain */
      }
      for (const o of got) {
        const ok = Number.isInteger(o.id) ? validateOutfitPixels(o.pixels) : null;
        if (ok) this.pixels.set(o.id, ok);
      }
      for (const id of chunk) {
        const cbs = this.waiting.get(id) ?? [];
        this.waiting.delete(id);
        const px = this.pixels.get(id) ?? null;
        for (const cb of cbs) cb(px);
      }
    }
  }
}

export const outfitCache = new OutfitCache();
