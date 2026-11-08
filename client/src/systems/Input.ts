/**
 * Action-based input. Gameplay reads intents (move vector, run, look delta,
 * zoom) and never touches raw keys or pointers, so keyboard, mouse, touch and
 * a future gamepad all feed the same contract.
 */

type MoveAction = 'forward' | 'back' | 'left' | 'right' | 'run';

/** Physical key codes (layout-independent) bound to actions. */
const KEY_BINDINGS: Record<string, MoveAction> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
};

const STICK_DEADZONE = 0.12;

export interface MoveIntent {
  /** -1..1, +1 = right */
  x: number;
  /** -1..1, +1 = forward */
  y: number;
  run: boolean;
}

export class Input {
  private readonly held = new Set<MoveAction>();
  private readonly stick = { x: 0, y: 0 };
  private stickPointer: number | null = null;
  private stickCenter = { x: 0, y: 0 };
  private stickRadius = 50;

  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookDx = 0;
  private lookDy = 0;
  private zoomDelta = 0;
  private pinch: { a: number; b: number; dist: number } | null = null;
  private readonly touches = new Map<number, { x: number; y: number }>();

  /** True once any input arrives; used to fade the help hint. */
  hasMoved = false;
  isTouch: boolean;

  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];

  constructor(
    private readonly surface: HTMLElement,
    private readonly stickZone: HTMLElement,
    private readonly stickBase: HTMLElement,
    private readonly stickKnob: HTMLElement,
  ) {
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.reset());

    this.on(surface, 'pointerdown', (e) => this.onSurfaceDown(e as PointerEvent));
    this.on(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.on(window, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.on(window, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent));
    this.on(surface, 'wheel', (e) => {
      e.preventDefault();
      this.zoomDelta += Math.sign((e as WheelEvent).deltaY) * 0.8;
    }, { passive: false });
    this.on(surface, 'contextmenu', (e) => e.preventDefault());

    this.on(stickZone, 'pointerdown', (e) => this.onStickDown(e as PointerEvent));
  }

  private on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    // Leave typing alone (chat input arrives in M2).
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const action = KEY_BINDINGS[e.code];
    if (!action) return;
    e.preventDefault();
    if (down) {
      this.held.add(action);
      if (action !== 'run') this.hasMoved = true;
    } else {
      this.held.delete(action);
    }
  }

  private onSurfaceDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.isTouch = true;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // A second finger on the world turns the gesture into a pinch zoom.
      if (this.lookPointer !== null && this.lookPointer !== e.pointerId) {
        const a = this.touches.get(this.lookPointer)!;
        this.pinch = { a: this.lookPointer, b: e.pointerId, dist: Math.hypot(a.x - e.clientX, a.y - e.clientY) };
        return;
      }
    }
    if (this.lookPointer !== null) return;
    this.lookPointer = e.pointerId;
    this.lookLast = { x: e.clientX, y: e.clientY };
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events may not be capturable */
    }
  }

  private onStickDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (this.stickPointer !== null) return;
    this.isTouch = true;
    this.stickPointer = e.pointerId;
    // Floating stick: it appears where the thumb lands inside the zone.
    const zone = this.stickZone.getBoundingClientRect();
    const r = this.stickBase.offsetWidth / 2 || 56;
    const cx = Math.min(Math.max(e.clientX, zone.left + r), zone.right - r);
    const cy = Math.min(Math.max(e.clientY, zone.top + r), zone.bottom - r);
    this.stickCenter = { x: cx, y: cy };
    this.stickRadius = r * 0.8;
    this.stickBase.style.left = `${cx - zone.left}px`;
    this.stickBase.style.top = `${cy - zone.top}px`;
    this.stickBase.classList.add('active');
    try {
      this.stickZone.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.updateStick(e.clientX, e.clientY);
  }

  private onPointerMove(e: PointerEvent) {
    if (e.pointerId === this.stickPointer) {
      e.preventDefault();
      this.updateStick(e.clientX, e.clientY);
      return;
    }
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) {
      const a = this.touches.get(this.pinch.a);
      const b = this.touches.get(this.pinch.b);
      if (a && b) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomDelta += (this.pinch.dist - dist) * 0.03;
        this.pinch.dist = dist;
      }
      return;
    }
    if (e.pointerId === this.lookPointer) {
      this.lookDx += e.clientX - this.lookLast.x;
      this.lookDy += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private onPointerUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (e.pointerId === this.stickPointer) {
      this.stickPointer = null;
      this.stick.x = 0;
      this.stick.y = 0;
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
      this.stickBase.classList.remove('active');
    }
    if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) {
      const remaining = e.pointerId === this.pinch.a ? this.pinch.b : this.pinch.a;
      this.pinch = null;
      const t = this.touches.get(remaining);
      this.lookPointer = t ? remaining : null;
      if (t) this.lookLast = { ...t };
      return;
    }
    if (e.pointerId === this.lookPointer) this.lookPointer = null;
  }

  private updateStick(clientX: number, clientY: number) {
    let dx = (clientX - this.stickCenter.x) / this.stickRadius;
    let dy = (clientY - this.stickCenter.y) / this.stickRadius;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx * this.stickRadius}px), calc(-50% + ${dy * this.stickRadius}px))`;
    // Radial deadzone, rescaled so motion ramps from zero at its edge.
    const m = Math.min(1, Math.hypot(dx, dy));
    if (m < STICK_DEADZONE) {
      this.stick.x = 0;
      this.stick.y = 0;
      return;
    }
    const scaled = (m - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    this.stick.x = (dx / m) * scaled;
    this.stick.y = (-dy / m) * scaled;
    this.hasMoved = true;
  }

  readMove(out: MoveIntent): MoveIntent {
    let x = 0;
    let y = 0;
    if (this.held.has('right')) x += 1;
    if (this.held.has('left')) x -= 1;
    if (this.held.has('forward')) y += 1;
    if (this.held.has('back')) y -= 1;
    x += this.stick.x;
    y += this.stick.y;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    // Pushing the stick all the way also counts as running.
    out.run = this.held.has('run') || Math.hypot(this.stick.x, this.stick.y) > 0.95;
    return out;
  }

  /** Pixels dragged since last call. */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return r;
  }

  consumeZoom(): number {
    const z = this.zoomDelta;
    this.zoomDelta = 0;
    return z;
  }

  reset() {
    this.held.clear();
    this.stick.x = 0;
    this.stick.y = 0;
    this.lookPointer = null;
    this.stickPointer = null;
    this.pinch = null;
    this.touches.clear();
  }

  dispose() {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
  }
}
