import { SHOT_MAX_DIM } from '../../../shared/protocol';

/** Aim for photos under this size (the server accepts a little more). */
export const SHOT_TARGET_BYTES = 150 * 1024;

export interface PhotoStamp {
  /** "2026년 11월 12일" */
  date: string;
  /** "오후 3:24" */
  time: string;
  place: string;
  nickname: string;
}

export interface Photo {
  blob: Blob;
  type: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  quality: number;
  stamp: string;
}

const UI_FONT = "'Pretendard', 'Noto Sans KR', 'Noto Sans CJK KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** "2026년 11월 12일" and "오후 3:24" in Korea time. */
export function kstStamp(now = Date.now()): { date: string; time: string } {
  const d = new Date(now + 9 * 3600_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { date: `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`, time: `${h < 12 ? '오전' : '오후'} ${h12}:${m}` };
}

/**
 * 📸 In-world photo. `render` draws one frame into the WebGL canvas and we copy
 * it in the same task (the drawing buffer is still intact then), so there is no
 * preserveDrawingBuffer cost on every other frame. Only the 3D canvas is
 * copied: the HUD and sheets are DOM and never end up in
 * the photo. Downscaled to SHOT_MAX_DIM, stamped, encoded as WebP (JPEG where
 * WebP encoding is missing) and squeezed under SHOT_TARGET_BYTES.
 */
export async function takePhoto(source: HTMLCanvasElement, render: () => void, stamp: PhotoStamp): Promise<Photo> {
  render();
  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, SHOT_MAX_DIM / Math.max(sw, sh));
  const w = Math.max(16, Math.round(sw * scale));
  const h = Math.max(16, Math.round(sh * scale));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);

  // Stamp: a soft paper strip at the bottom left.
  const line1 = `${stamp.date} ${stamp.time} · ${stamp.place}`;
  const line2 = `${stamp.nickname} · QT 월드`;
  const k = Math.max(0.6, Math.min(1.4, Math.min(w, h) / 600));
  const f1 = Math.round(18 * k);
  const f2 = Math.round(14 * k);
  ctx.font = `700 ${f1}px ${UI_FONT}`;
  const w1 = ctx.measureText(line1).width;
  ctx.font = `600 ${f2}px ${UI_FONT}`;
  const w2 = ctx.measureText(line2).width;
  const pad = Math.round(10 * k);
  const bw = Math.min(w - pad * 2, Math.max(w1, w2) + pad * 2);
  const bh = f1 + f2 + pad * 2.4;
  const bx = pad;
  const by = h - bh - pad;
  ctx.fillStyle = 'rgba(42, 30, 22, 0.58)';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, Math.round(10 * k));
  ctx.fill();
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff8ea';
  ctx.font = `700 ${f1}px ${UI_FONT}`;
  ctx.fillText(line1, bx + pad, by + pad * 0.8, bw - pad * 2);
  ctx.fillStyle = '#ffd9a0';
  ctx.font = `600 ${f2}px ${UI_FONT}`;
  ctx.fillText(line2, bx + pad, by + pad * 1.4 + f1, bw - pad * 2);

  let type: 'image/webp' | 'image/jpeg' = 'image/webp';
  let blob: Blob | null = null;
  let quality = 0.7;
  for (const q of [0.7, 0.6, 0.5, 0.4, 0.3]) {
    quality = q;
    blob = await toBlob(out, 'image/webp', q);
    if (!blob || blob.type !== 'image/webp') {
      type = 'image/jpeg';
      blob = await toBlob(out, 'image/jpeg', q);
    }
    if (blob && blob.size <= SHOT_TARGET_BYTES) break;
  }
  if (!blob) throw new Error('사진을 만들지 못했어요.');
  return { blob, type, width: w, height: h, quality, stamp: `${line1} / ${line2}` };
}
