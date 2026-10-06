/**
 * The office camera (SPEC §14.5): drag to pan with a little glide, wheel or pinch to zoom at the
 * pointer, and an eased fly-to for the area chips. It only says where to look; the scene asks it
 * each frame whether it is still moving, and stops drawing when nothing is.
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
const FLY_MS = 650;
const FRICTION = 0.9; // per 16 ms frame
const EDGE = 120; // px of slack past the office edge

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export class Camera {
  /** World point at the centre of the screen, and the scale. */
  x = 0;
  y = 0;
  zoom = 1;
  width = 1;
  height = 1;
  bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private vx = 0;
  private vy = 0;
  private fly: { from: View; to: View; start: number; ms: number } | null = null;
  /** Follow a moving target: the scene sets this each frame. */
  follow: (() => { x: number; y: number }) | null = null;

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.clamp();
  }

  /** Flying or gliding. Following only moves while its target does, so it does not count. */
  get moving(): boolean {
    return !!this.fly || Math.abs(this.vx) > 0.02 || Math.abs(this.vy) > 0.02;
  }

  /** Where the camera is heading: the end of a fly, or here. Repeated zoom clicks build on it. */
  get target(): View {
    return this.fly ? { ...this.fly.to } : { x: this.x, y: this.y, zoom: this.zoom };
  }

  /** The zoom that fits a world rectangle on screen, with a margin. */
  fitZoom(w: number, h: number, margin = 48): number {
    return clampZoom(
      Math.min((this.width - margin * 2) / Math.max(1, w), (this.height - margin * 2) / Math.max(1, h)),
    );
  }

  toWorld(sx: number, sy: number) {
    return { x: this.x + (sx - this.width / 2) / this.zoom, y: this.y + (sy - this.height / 2) / this.zoom };
  }

  stop() {
    this.vx = this.vy = 0;
    this.fly = null;
  }

  panBy(dx: number, dy: number) {
    this.fly = null;
    this.follow = null;
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Release after a drag: keep gliding at the drag's speed (screen px per ms). */
  fling(vx: number, vy: number) {
    this.vx = (-vx * 16) / this.zoom;
    this.vy = (-vy * 16) / this.zoom;
  }

  /** Zoom by `factor`, keeping the world point under screen point (sx, sy) where it is. */
  zoomAt(factor: number, sx: number, sy: number) {
    this.fly = null;
    const before = this.toWorld(sx, sy);
    this.zoom = clampZoom(this.zoom * factor);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  /** Ease to a view; `instant` snaps (reduced motion). */
  flyTo(to: View, now: number, instant: boolean, ms = FLY_MS) {
    this.vx = this.vy = 0;
    const target = { x: to.x, y: to.y, zoom: clampZoom(to.zoom) };
    if (instant) {
      this.fly = null;
      Object.assign(this, target);
      this.clamp();
      return;
    }
    this.fly = { from: { x: this.x, y: this.y, zoom: this.zoom }, to: target, start: now, ms };
  }

  /** Advance one frame. Returns true while the view changed. */
  step(now: number, dt: number): boolean {
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / this.fly.ms);
      const k = ease(t);
      const { from, to } = this.fly;
      // Zoom in log space so it feels even.
      this.zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
      this.x = from.x + (to.x - from.x) * k;
      this.y = from.y + (to.y - from.y) * k;
      if (t >= 1) this.fly = null;
      this.clamp();
      return true;
    }
    if (this.follow) {
      const p = this.follow();
      const k = 1 - Math.pow(0.82, dt / 16);
      const dx = p.x - this.x;
      const dy = p.y - 30 - this.y;
      this.x += dx * k;
      this.y += dy * k;
      this.clamp();
      return Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3;
    }
    if (Math.abs(this.vx) > 0.02 || Math.abs(this.vy) > 0.02) {
      const f = Math.pow(FRICTION, dt / 16);
      this.x += (this.vx * dt) / 16;
      this.y += (this.vy * dt) / 16;
      this.vx *= f;
      this.vy *= f;
      this.clamp();
      return true;
    }
    this.vx = this.vy = 0;
    return false;
  }

  /** Keep some of the office on screen. */
  clamp() {
    const b = this.bounds;
    const halfW = this.width / 2 / this.zoom;
    const halfH = this.height / 2 / this.zoom;
    const fit = (v: number, lo: number, hi: number, half: number) => {
      const min = lo - EDGE + half;
      const max = hi + EDGE - half;
      return min > max ? (lo + hi) / 2 : Math.min(max, Math.max(min, v));
    };
    this.x = fit(this.x, b.minX, b.maxX, halfW);
    this.y = fit(this.y, b.minY, b.maxY, halfH);
  }
}
