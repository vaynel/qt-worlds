import * as THREE from 'three';

export const UI_FONT =
  '"Pretendard", "Noto Sans KR", "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

const SCALE = 2;

function spriteFrom(canvas: HTMLCanvasElement, worldHeight: number): THREE.Sprite {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set((worldHeight * canvas.width) / canvas.height, worldHeight, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}

/** Free a sprite made by this module. */
export function disposeSprite(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

function pill(ctx: CanvasRenderingContext2D, w: number, h: number, r: number, pointer: boolean, fill: string, stroke: string) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2 * SCALE;
  const lw = ctx.lineWidth;
  ctx.beginPath();
  ctx.roundRect(lw, lw, w - lw * 2, h - lw * 2, r);
  ctx.fill();
  ctx.stroke();
  if (pointer) {
    ctx.beginPath();
    ctx.moveTo(w / 2 - 10 * SCALE, h - lw * 1.5);
    ctx.lineTo(w / 2, h + 12 * SCALE);
    ctx.lineTo(w / 2 + 10 * SCALE, h - lw * 1.5);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * A world-space landmark name tag drawn to a canvas texture. Text is drawn
 * with fillText, so player-provided strings are never parsed as markup.
 */
export function createLabelSprite(title: string, subtitle?: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const titleFont = `700 ${30 * SCALE}px ${UI_FONT}`;
  const subFont = `500 ${17 * SCALE}px ${UI_FONT}`;

  ctx.font = titleFont;
  const titleW = ctx.measureText(title).width;
  ctx.font = subFont;
  const subW = subtitle ? ctx.measureText(subtitle).width : 0;

  const padX = 26 * SCALE;
  const width = Math.ceil(Math.max(titleW, subW) + padX * 2);
  const height = (subtitle ? 92 : 64) * SCALE;
  canvas.width = width;
  canvas.height = height + 14 * SCALE;

  pill(ctx, width, height, 22 * SCALE, true, 'rgba(255, 248, 234, 0.92)', 'rgba(176, 120, 72, 0.55)');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4a3426';
  ctx.font = titleFont;
  ctx.fillText(title, width / 2, subtitle ? 34 * SCALE : height / 2);
  if (subtitle) {
    ctx.fillStyle = '#8a6a50';
    ctx.font = subFont;
    ctx.fillText(subtitle, width / 2, 68 * SCALE);
  }
  return spriteFrom(canvas, subtitle ? 1.9 : 1.35);
}

/**
 * Paper-style nickname tag above a player. Guests get a small "손님" marker.
 * `dark` keeps the older dark pill (used for lantern owner labels).
 */
export function createNameTag(name: string, guest = false, dark = false): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `700 ${22 * SCALE}px ${UI_FONT}`;
  const small = `600 ${15 * SCALE}px ${UI_FONT}`;
  ctx.font = font;
  const nameW = ctx.measureText(name).width;
  ctx.font = small;
  const markW = guest ? ctx.measureText('손님').width + 16 * SCALE : 0;
  const gap = guest ? 8 * SCALE : 0;
  const width = Math.ceil(nameW + markW + gap + 30 * SCALE);
  const height = 40 * SCALE;
  canvas.width = width;
  canvas.height = height;
  if (dark) pill(ctx, width, height, 20 * SCALE, false, 'rgba(74, 52, 38, 0.62)', 'rgba(255, 248, 234, 0.35)');
  else pill(ctx, width, height, 20 * SCALE, false, 'rgba(255, 248, 234, 0.93)', 'rgba(176, 120, 72, 0.5)');
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = 15 * SCALE;
  ctx.font = font;
  ctx.fillStyle = dark ? '#fff8ea' : '#3f2c20';
  ctx.fillText(name, x, height / 2 + SCALE);
  if (guest) {
    x += nameW + gap;
    ctx.fillStyle = 'rgba(176, 120, 72, 0.18)';
    ctx.beginPath();
    ctx.roundRect(x, height / 2 - 11 * SCALE, markW, 22 * SCALE, 11 * SCALE);
    ctx.fill();
    ctx.font = small;
    ctx.fillStyle = '#8a6a50';
    ctx.fillText('손님', x + 8 * SCALE, height / 2 + SCALE);
  }
  return spriteFrom(canvas, 0.42);
}

/** Wrap text to lines no wider than maxWidth (character-level for Korean). */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of [...text]) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch.trimStart();
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

/** Speech bubble shown above a speaker for a few seconds. */
export function createBubble(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `500 ${21 * SCALE}px ${UI_FONT}`;
  ctx.font = font;
  const maxW = 300 * SCALE;
  const lines = wrap(ctx, text, maxW, 4);
  const lineH = 30 * SCALE;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const width = Math.ceil(Math.max(textW, 40 * SCALE) + 32 * SCALE);
  const height = lines.length * lineH + 22 * SCALE;
  canvas.width = width;
  canvas.height = height + 14 * SCALE;
  pill(ctx, width, height, 18 * SCALE, true, 'rgba(255, 252, 244, 0.96)', 'rgba(200, 100, 74, 0.45)');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#3f2c20';
  lines.forEach((l, i) => ctx.fillText(l, width / 2, 11 * SCALE + lineH * (i + 0.5)));
  return spriteFrom(canvas, 0.3 * lines.length + 0.36);
}
