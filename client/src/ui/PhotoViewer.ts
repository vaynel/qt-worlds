import { button, el, Modal } from './dom';

export interface ViewerPhoto {
  src: string;
  /** Date and place line under the photo. */
  caption: string;
  /** File name for 📥 저장; only set for the viewer's own photos. */
  download?: string;
}

const SWIPE_PX = 50;

/**
 * Full-screen photo viewer, shared by 오늘 앨범, the diary photo picker and the
 * book reader's polaroids. ✕ / backdrop / Esc close it, and so does the
 * Android back gesture: opening pushes a history entry and `popstate` closes.
 * Swipe or ← → moves through the photos; double-tap (or double-click) zooms 2×
 * around the tapped point. The page viewport stays `user-scalable=no` for the
 * game, so zoom is ours.
 */
export function openPhotoViewer(photos: ViewerPhoto[], start: number): void {
  if (!photos.length) return;
  document.getElementById('photo-viewer')?.remove();
  let index = Math.max(0, Math.min(photos.length - 1, start));

  const root = el('div', 'photo-viewer');
  root.id = 'photo-viewer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '사진 크게 보기');
  const stage = el('div', 'pv-stage');
  const img = el('img', 'pv-img');
  img.alt = 'QT 월드에서 찍은 사진';
  img.draggable = false;
  stage.append(img);

  const top = el('div', 'pv-top');
  const counter = el('span', 'pv-count');
  counter.id = 'pv-count';
  const save = el('a', 'pv-btn pv-save', '📥 저장');
  save.id = 'pv-save';
  const close = button('✕', 'pv-btn pv-close', () => done());
  close.id = 'pv-close';
  close.setAttribute('aria-label', '닫기');
  top.append(counter, el('span', 'pv-spacer'), save, close);

  const prev = button('‹', 'pv-nav pv-prev', () => go(-1));
  prev.setAttribute('aria-label', '이전 사진');
  const next = button('›', 'pv-nav pv-next', () => go(1));
  next.setAttribute('aria-label', '다음 사진');
  const caption = el('p', 'pv-caption');
  caption.id = 'pv-caption';
  root.append(stage, top, prev, next, caption);

  let zoomed = false;
  const setZoom = (on: boolean, x = 0.5, y = 0.5) => {
    zoomed = on;
    img.style.transformOrigin = `${x * 100}% ${y * 100}%`;
    root.classList.toggle('zoomed', on);
  };

  const show = () => {
    const p = photos[index];
    setZoom(false);
    img.src = p.src;
    caption.textContent = p.caption;
    counter.textContent = `${index + 1} / ${photos.length}`;
    counter.hidden = photos.length < 2;
    prev.hidden = next.hidden = photos.length < 2;
    save.hidden = !p.download;
    if (p.download) {
      save.href = p.src;
      save.download = p.download;
    } else save.removeAttribute('href');
  };
  const go = (d: number) => {
    if (photos.length < 2) return;
    index = (index + d + photos.length) % photos.length;
    show();
  };

  // Swipe (touch/pen drag) vs. tap vs. double-tap.
  let sx = 0;
  let sy = 0;
  let swiped = false;
  let lastTap = 0;
  stage.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
    swiped = false;
  });
  stage.addEventListener('pointerup', (e) => {
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!zoomed && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      go(dx < 0 ? 1 : -1);
    }
  });
  /** Inside the drawn picture (object-fit: contain leaves dark bands inside the img box)? */
  const onPicture = (x: number, y: number) => {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth || r.width;
    const nh = img.naturalHeight || r.height;
    const k = Math.min(r.width / nw, r.height / nh);
    const w = nw * k;
    const h = nh * k;
    const left = r.left + (r.width - w) / 2;
    const top = r.top + (r.height - h) / 2;
    return x >= left && x <= left + w && y >= top && y <= top + h;
  };
  stage.addEventListener('click', (e) => {
    if (swiped) return;
    const now = performance.now();
    const onImg = zoomed || onPicture(e.clientX, e.clientY);
    if (onImg && now - lastTap < 320) {
      lastTap = 0;
      const r = img.getBoundingClientRect();
      if (zoomed) setZoom(false);
      else setZoom(true, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      return;
    }
    lastTap = onImg ? now : 0;
    // A tap on the dark area (not the photo) closes.
    if (!onImg && !zoomed) done();
  });
  // Keep pointer events away from the game and the sheet under us.
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') done();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Back gesture / button closes the viewer instead of leaving the app.
  const marker = { photoViewer: Date.now() };
  history.pushState(marker, '');
  const onPop = () => finish();

  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    Modal.layerOpen = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    root.remove();
  }
  function done() {
    if (closed) return;
    const ours = (history.state as { photoViewer?: number } | null)?.photoViewer === marker.photoViewer;
    finish();
    if (ours) history.back();
  }

  Modal.layerOpen = true;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  show();
  document.body.append(root);
  close.focus({ preventScroll: true });
}

/** `qt-world-2026-11-14-12`; no extension, so the browser names it from the served type (WebP or JPEG). */
export function photoFileName(date: string, id: number): string {
  return `qt-world-${date}-${id}`;
}
