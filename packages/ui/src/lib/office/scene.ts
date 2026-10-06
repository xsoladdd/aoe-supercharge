// The dashboard's CSP forbids eval; this swaps Pixi's generated shader code for plain functions.
import 'pixi.js/unsafe-eval';
import { Application, Container } from 'pixi.js';
import { findPath, fnv1a, officeLayout, type OfficeLayout, type Tile } from '@aoe-supercharge/core/shared';
import type { OfficeModel, OfficeWorker } from '@/lib/office';
import { buildStatic, type StaticOffice } from './art';
import { Camera } from './camera';
import { Character, type Hands, type Stance } from './character';
import { depth, iso, toGrid, WALL_H, type Pt } from './iso';
import { makePalette, type Palette } from './palette';

/**
 * The drawn office (SPEC §14.5). It draws only while something moves: a worker walking, the camera
 * flying or gliding, a bubble popping. Then it stops, so an office with nobody moving costs nothing.
 *
 * Where a worker stands is decided by the model (`buildOffice`); this only walks it there.
 */

export interface SceneEvents {
  select(key: string | null): void;
  /** The area the camera was sent to; `free` once you pan or zoom yourself. */
  focus(area: string): void;
  walking(count: number): void;
  door(): void;
  zoom(zoom: number): void;
}

export interface SceneOptions {
  theme: 'dark' | 'light';
  reducedMotion: boolean;
  doorLabel: string;
  events: SceneEvents;
}

/** Where a character goes, and how it settles there. */
interface Spot {
  tile: Tile;
  stance: Stance;
  hands: Hands;
  face: [number, number];
  /** Fade out on arrival: through your door, or out of the entrance. */
  vanish?: 'door' | 'exit';
}

interface Walker {
  key: string;
  worker: OfficeWorker;
  ch: Character;
  /** Feet, in grid coordinates. */
  pos: Pt;
  path: Pt[];
  speed: number;
  phase: number;
  spot: Spot | null;
  spotKey: string;
  /** Hidden behind your door or out of the building, and where it went. */
  hidden: 'door' | 'exit' | null;
  fade: { from: number; to: number; start: number } | null;
  leaving: boolean;
}

/** Tiles per second. Long walks speed up so none takes longer than LONGEST_WALK_S. */
const SPEED = 4.5;
const LONGEST_WALK_S = 6;
const FADE_MS = 280;
const POP_MS = 240;
/** Names show over every head from this zoom; below it only on hover or selection. */
const NAMES_AT = 1.15;
const DRAG_PX = 5;

const centre = (t: Tile): Pt => ({ x: t.x + 0.5, y: t.y + 0.5 });
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function handsFor(w: OfficeWorker): Hands {
  const s = w.spot;
  if (w.zone === 'desk') {
    if (s.zone !== 'desk') return 'down';
    return s.pose === 'typing'
      ? 'typing'
      : s.pose === 'sketching'
        ? 'paper'
        : s.pose === 'inspecting'
          ? 'magnifier'
          : 'down';
  }
  if (w.zone === 'pantry') return s.prop === 'letter' ? 'letter' : 'mug';
  return 'down';
}

function plateName(w: OfficeWorker) {
  return w.role === 'lead' ? `${w.project} lead` : w.name;
}

export class OfficeScene {
  private layout: OfficeLayout = officeLayout([]);
  private layoutKey = '';
  private palette: Palette;
  private world = new Container();
  private ground = new Container();
  private objects = new Container();
  private overlay = new Container();
  private office: StaticOffice | null = null;
  private walkers = new Map<string, Walker>();
  private pantrySeat = new Map<string, number>();
  private model: OfficeModel | null = null;
  private called: string | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private following: string | null = null;
  private namesShown = false;
  private camera = new Camera();
  /** Screen px the followed worker sits right of centre, so the card does not cover it. */
  private shift = 0;
  private focusName = 'office';
  private moved = false;
  private raf = 0;
  private last = 0;
  private walking = 0;
  private lastZoom = 0;
  private placed = false;
  private destroyed = false;
  /** Frames drawn so far, on the host as `data-frames`: tests check it stays put while nothing moves. */
  private frames = 0;
  private resize: ResizeObserver;
  private pointers = new Map<number, Pt>();
  private drag: { x: number; y: number; t: number; vx: number; vy: number; moved: boolean } | null = null;
  private pinch: number | null = null;

  static async create(host: HTMLElement, opts: SceneOptions): Promise<OfficeScene> {
    await document.fonts?.ready;
    const app = new Application();
    await app.init({
      autoStart: false,
      preference: ['webgl', 'canvas'],
      antialias: true,
      backgroundAlpha: 0,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
    });
    return new OfficeScene(app, host, opts);
  }

  private constructor(
    readonly app: Application,
    private host: HTMLElement,
    private opts: SceneOptions,
  ) {
    app.ticker?.stop();
    this.palette = makePalette(opts.theme);
    this.objects.sortableChildren = true;
    this.world.addChild(this.ground, this.objects, this.overlay);
    app.stage.addChild(this.world);
    const canvas = app.canvas as HTMLCanvasElement;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    this.camera.resize(host.clientWidth, host.clientHeight);
    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDouble);
    this.rebuild();
  }

  get renderer(): string {
    return this.app.renderer.name;
  }

  // ---- Model ----------------------------------------------------------------------------------

  setModel(model: OfficeModel) {
    this.model = model;
    this.apply();
  }

  /** The worker you called in walks through your door; null sends them back to the line. */
  setCalled(key: string | null) {
    if (key === this.called) return;
    this.called = key;
    this.apply();
  }

  private apply() {
    const model = this.model;
    if (!model || this.destroyed) return;
    const teams = model.teams.map((t) => ({ project: t.project, desks: t.desks }));
    const key = JSON.stringify(teams);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = officeLayout(teams);
      this.rebuild();
      // Furniture may have moved under someone: walk on from the nearest free tile.
      for (const w of this.walkers.values()) w.spotKey = '';
    }
    const now = performance.now();
    const spots = this.assign(model);
    const live = new Set<string>();
    for (const worker of model.everyone) {
      const spot = spots.get(worker.key);
      if (!spot) continue;
      live.add(worker.key);
      let w = this.walkers.get(worker.key);
      if (!w) w = this.spawn(worker);
      w.worker = worker;
      w.leaving = false;
      w.ch.setName(plateName(worker));
      const prop = worker.zone === worker.spot.zone || worker.zone === 'door' ? worker.spot.prop : null;
      w.ch.setProp(worker.zone === 'away' ? null : prop, worker.zone === 'pantry', now);
      this.goTo(w, spot, now);
    }
    // Done or deleted: out of the building.
    for (const w of this.walkers.values())
      if (!live.has(w.key) && !w.leaving) {
        w.leaving = true;
        w.ch.setProp(null, false, now);
        this.goTo(
          w,
          { tile: this.layout.entrance, stance: 'stand', hands: 'down', face: [-1, 0], vanish: 'exit' },
          now,
        );
      }
    // "Back later" cards on the desks of workers who stepped away.
    const away = new Set(model.away.filter((w) => w.desk).map((w) => `${w.project}/${w.desk}`));
    for (const [k, sign] of this.office?.awaySigns ?? []) sign.visible = away.has(k);
    this.office?.door.setOpen(!!this.called && this.walkers.has(this.called));
    if (this.selected && !live.has(this.selected)) this.select(null);
    if (this.following && !live.has(this.following)) this.follow(null);
    this.placed = true;
    this.wake();
  }

  private assign(model: OfficeModel): Map<string, Spot> {
    const L = this.layout;
    const out = new Map<string, Spot>();

    // The line at your door, front first: on the club chairs, then standing on the runner. The one you
    // called in steps through your door.
    let i = 0;
    for (const w of model.door) {
      if (w.key === this.called) {
        out.set(w.key, { tile: L.door, stance: 'stand', hands: 'down', face: [0, -1], vanish: 'door' });
        continue;
      }
      const at = Math.min(i, L.queue.length - 1);
      const tile = L.queue[at]!;
      if (at < L.queueSeats) {
        out.set(w.key, { tile, stance: 'sit', hands: 'down', face: [0, 1] });
      } else {
        // Standing on the runner: turned towards your door, face to the room.
        out.set(w.key, { tile, stance: 'stand', hands: 'down', face: [1, 0] });
      }
      i++;
    }

    // Desks. A worker without a desk number yet stands in its team's walkway.
    for (const team of model.teams) {
      const plan = L.teams.find((t) => t.project === team.project);
      if (!plan) continue;
      let spare = 0;
      for (const w of model.everyone) {
        if (w.project !== team.project || w.zone !== 'desk') continue;
        const hands = handsFor(w);
        if (w.role === 'lead') {
          out.set(w.key, { tile: plan.leadSeat, stance: 'sit', hands, face: [0, 1] });
          continue;
        }
        const desk = plan.desks.find((d) => d.n === w.desk);
        if (desk) out.set(w.key, { tile: desk.seat, stance: 'sit', hands, face: [0, 1] });
        else
          out.set(w.key, {
            tile: plan.spare[spare++ % plan.spare.length]!,
            stance: 'stand',
            hands: 'down',
            face: [0, 1],
          });
      }
    }

    // The pantry: everyone keeps the spot they took until they leave it.
    const inPantry = new Set(model.pantry.map((w) => w.key));
    for (const k of [...this.pantrySeat.keys()]) if (!inPantry.has(k)) this.pantrySeat.delete(k);
    const used = new Set(this.pantrySeat.values());
    const spots = L.pantry.spots;
    for (const w of model.pantry) {
      if (!this.pantrySeat.has(w.key)) {
        const free = spots.map((_, n) => n).filter((n) => !used.has(n));
        const n = free.length ? free[fnv1a(w.key) % Math.min(free.length, 16)]! : spots.length - 1;
        this.pantrySeat.set(w.key, n);
        used.add(n);
      }
      const s = spots[Math.min(this.pantrySeat.get(w.key)!, spots.length - 1)]!;
      out.set(w.key, {
        tile: s.tile,
        stance: s.seat === 'stand' ? 'stand' : 'sit',
        hands: handsFor(w),
        face: this.pantryFace(s),
      });
    }

    // Away: out of the entrance.
    for (const w of model.away)
      out.set(w.key, { tile: L.entrance, stance: 'stand', hands: 'down', face: [-1, 0], vanish: 'exit' });
    return out;
  }

  private pantryFace(s: OfficeLayout['pantry']['spots'][number]): [number, number] {
    const L = this.layout;
    const t = s.tile;
    if (s.seat === 'sofa') return [0, 1];
    if (s.seat === 'chair') {
      const tables = L.furniture.filter((f) => f.kind === 'table');
      const near = tables.reduce((a, b) =>
        Math.hypot(b.x - t.x, b.y - t.y) < Math.hypot(a.x - t.x, a.y - t.y) ? b : a,
      );
      return [sign(near.x - t.x), sign(near.y - t.y)];
    }
    const a = L.pantry.area;
    // By the foosball table: playing. Anywhere else: facing into the room.
    if (t.y === a.y + a.h - 1) return [0, -1];
    return [sign(a.x + a.w / 2 - 0.5 - t.x) || 1, sign(a.y + a.h / 2 - 0.5 - t.y) || 1];
  }

  private spawn(worker: OfficeWorker): Walker {
    const ch = new Character(worker.outfit, plateName(worker), this.palette);
    const w: Walker = {
      key: worker.key,
      worker,
      ch,
      pos: centre(this.layout.entrance),
      path: [],
      speed: SPEED,
      phase: 0,
      spot: null,
      spotKey: '',
      // Workers already here when the office opens are at their places; later ones walk in.
      hidden: this.placed ? 'exit' : null,
      fade: null,
      leaving: false,
    };
    this.objects.addChild(ch.root);
    this.overlay.addChild(ch.overlay);
    this.walkers.set(w.key, w);
    this.decorate(w);
    return w;
  }

  private goTo(w: Walker, spot: Spot, now: number) {
    const key = `${spot.tile.x},${spot.tile.y},${spot.stance},${spot.hands},${spot.face},${spot.vanish ?? ''}`;
    if (key === w.spotKey) return;
    const sameTile = !!w.spot && w.spot.tile.x === spot.tile.x && w.spot.tile.y === spot.tile.y;
    w.spot = spot;
    w.spotKey = key;
    const instant = this.opts.reducedMotion || !this.placed;

    if (w.hidden && !spot.vanish) {
      // Back from behind your door, or in through the entrance.
      w.pos = centre(w.hidden === 'door' ? this.layout.door : this.layout.entrance);
      w.hidden = null;
      w.ch.root.visible = w.ch.overlay.visible = true;
      w.ch.root.alpha = w.ch.overlay.alpha = instant ? 1 : 0;
      w.fade = instant ? null : { from: 0, to: 1, start: now };
    } else if (w.hidden && spot.vanish) {
      // Still out of sight; it just changed which way it went.
      w.pos = centre(spot.tile);
      w.path = [];
      if (w.leaving) this.remove(w);
      return;
    }

    if (instant) {
      w.pos = centre(spot.tile);
      w.path = [];
      this.arrive(w, now, true);
      return;
    }
    if (sameTile && !w.path.length) {
      this.arrive(w, now, false);
      return;
    }
    const from = { x: Math.floor(w.pos.x), y: Math.floor(w.pos.y) };
    const tiles = findPath(this.layout.grid, from, spot.tile);
    if (!tiles) {
      w.pos = centre(spot.tile);
      w.path = [];
      this.arrive(w, now, false);
      return;
    }
    w.path = tiles.slice(1).map(centre);
    // From mid-tile, head for the tile's centre first only if the path turns back through it.
    if (!w.path.length) w.path = [centre(spot.tile)];
    let length = 0;
    let prev = w.pos;
    for (const p of w.path) {
      length += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    w.speed = Math.max(SPEED, length / LONGEST_WALK_S);
    w.ch.pose('stand', 'down');
    this.decorate(w);
  }

  /** Settle into the spot's pose; vanish if it is a way out. */
  private arrive(w: Walker, now: number, instant: boolean) {
    const s = w.spot;
    if (!s) return;
    w.ch.pose(s.stance, s.hands);
    w.ch.face(s.face[0], s.face[1]);
    w.ch.still();
    if (s.vanish) {
      if (instant) this.hide(w, s.vanish);
      else w.fade = { from: 1, to: 0, start: now };
    }
    this.decorate(w);
  }

  private hide(w: Walker, how: 'door' | 'exit') {
    w.hidden = how;
    w.fade = null;
    w.ch.root.visible = w.ch.overlay.visible = false;
    if (w.leaving) this.remove(w);
  }

  private remove(w: Walker) {
    this.walkers.delete(w.key);
    this.pantrySeat.delete(w.key);
    w.ch.destroy();
  }

  /** Position, draw order and overlay for one character. */
  private decorate(w: Walker) {
    const p = iso(w.pos.x, w.pos.y);
    w.ch.root.position.set(p.x, p.y);
    w.ch.root.zIndex = depth(w.pos.x, w.pos.y) + 10;
    w.ch.syncOverlay(p.x, p.y);
  }

  // ---- Frames ---------------------------------------------------------------------------------

  private wake() {
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.last ? Math.min(50, now - this.last) : 16;
    this.last = now;
    let busy = this.camera.step(now, dt);
    let walking = 0;
    for (const w of [...this.walkers.values()]) {
      if (this.step(w, now, dt)) busy = true;
      if (w.path.length) walking++;
    }
    this.view();
    this.app.render();
    this.host.dataset.frames = String(++this.frames);
    if (walking !== this.walking) {
      this.walking = walking;
      this.opts.events.walking(walking);
    }
    if (busy || this.camera.moving) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  /** One frame for one character. True while it still has something to do. */
  private step(w: Walker, now: number, dt: number): boolean {
    let busy = false;
    if (w.path.length) {
      let left = (w.speed * dt) / 1000;
      while (left > 0 && w.path.length) {
        const t = w.path[0]!;
        const dx = t.x - w.pos.x;
        const dy = t.y - w.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) w.ch.face(sign(Math.round(dx * 4)), sign(Math.round(dy * 4)));
        if (d <= left) {
          w.pos = { ...t };
          w.path.shift();
          left -= d;
        } else {
          w.pos = { x: w.pos.x + (dx / d) * left, y: w.pos.y + (dy / d) * left };
          left = 0;
        }
      }
      // About two steps per tile.
      w.phase += ((w.speed * dt) / 1000) * Math.PI * 2;
      w.ch.stride(w.phase);
      if (!w.path.length) this.arrive(w, now, false);
      busy = true;
    }
    if (w.fade) {
      const t = Math.min(1, (now - w.fade.start) / FADE_MS);
      const a = w.fade.from + (w.fade.to - w.fade.from) * t;
      w.ch.root.alpha = w.ch.overlay.alpha = a;
      if (t >= 1) {
        const out = w.fade.to === 0;
        w.fade = null;
        if (out && w.spot?.vanish) this.hide(w, w.spot.vanish);
      } else busy = true;
    }
    if (!this.walkers.has(w.key)) return busy;
    const pop = (now - w.ch.bubbleSince) / POP_MS;
    if (!this.opts.reducedMotion && pop < 1) {
      w.ch.popBubble(pop);
      busy = true;
    } else w.ch.popBubble(1);
    this.decorate(w);
    return busy;
  }

  /** Apply the camera to the world, and keep names readable at this zoom. */
  private view() {
    const c = this.camera;
    this.world.scale.set(c.zoom);
    this.world.position.set(c.width / 2 - c.x * c.zoom, c.height / 2 - c.y * c.zoom);
    const s = Math.max(1 / Math.sqrt(c.zoom), 0.95 / c.zoom);
    const names = c.zoom >= NAMES_AT;
    for (const w of this.walkers.values()) {
      w.ch.scaleOverlay(s);
      if (names !== this.namesShown) this.paintSelection(w);
    }
    this.namesShown = names;
    if (Math.abs(c.zoom - this.lastZoom) > 0.004) {
      this.lastZoom = c.zoom;
      this.opts.events.zoom(c.zoom);
    }
  }

  private paintSelection(w: Walker) {
    w.ch.setSelected(w.key === this.selected, w.key === this.hovered, this.camera.zoom >= NAMES_AT);
  }

  // ---- Static office --------------------------------------------------------------------------

  private rebuild() {
    if (this.office) {
      for (const p of this.office.pieces) p.destroy({ children: true });
      this.office.floor.destroy();
      this.office.walls.destroy({ children: true });
    }
    this.office = buildStatic(this.layout, this.palette, this.opts.doorLabel);
    this.ground.removeChildren();
    this.ground.addChild(this.office.floor, this.office.walls);
    this.objects.addChild(...this.office.pieces);
    this.office.door.setOpen(!!this.called && this.walkers.has(this.called));
    const L = this.layout;
    const corners = [iso(0, 0), iso(L.width, 0), iso(0, L.height), iso(L.width, L.height)];
    this.camera.bounds = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)) - WALL_H,
      maxY: Math.max(...corners.map((c) => c.y)),
    };
    if (!this.moved) this.focus(this.focusName, true);
    this.wake();
  }

  setTheme(theme: 'dark' | 'light') {
    if (theme === this.opts.theme) return;
    this.opts.theme = theme;
    this.palette = makePalette(theme);
    for (const w of this.walkers.values()) w.ch.setPalette(this.palette);
    this.rebuild();
    this.apply();
  }

  setDoorLabel(label: string) {
    if (label === this.opts.doorLabel) return;
    this.opts.doorLabel = label;
    this.rebuild();
    this.apply();
  }

  setReducedMotion(reduced: boolean) {
    this.opts.reducedMotion = reduced;
  }

  // ---- Camera ---------------------------------------------------------------------------------

  /** World rectangle of an area: its floor, plus the wall behind it when it backs onto one. */
  private areaBox(name: string) {
    const r = this.layout.areas[name] ?? this.layout.areas.office!;
    const pts = [iso(r.x, r.y), iso(r.x + r.w, r.y), iso(r.x, r.y + r.h), iso(r.x + r.w, r.y + r.h)];
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)) - (r.y === 0 || r.x === 0 ? WALL_H : 50);
    const maxY = Math.max(...pts.map((p) => p.y)) + 12;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  /** Fly to an area: `office`, `door`, `pantry` or a project. */
  focus(name: string, instant = false) {
    const b = this.areaBox(name);
    const zoom =
      name === 'office'
        ? this.camera.fitZoom(b.w, b.h, 24)
        : Math.min(1.8, this.camera.fitZoom(b.w, b.h, 40));
    this.following = null;
    this.camera.follow = null;
    this.camera.flyTo({ x: b.x, y: b.y, zoom }, performance.now(), instant || this.opts.reducedMotion);
    this.setFocus(name);
    this.moved = false;
    this.wake();
  }

  /** Fly to a worker. `shift` moves it that many screen px right of centre, clear of the card. */
  focusWorker(key: string, shift = 0) {
    const w = this.walkers.get(key);
    if (!w) return;
    const p = iso(w.pos.x, w.pos.y);
    const zoom = Math.max(this.camera.target.zoom, 1.6);
    this.shift = shift;
    this.camera.flyTo(
      { x: p.x - shift / zoom, y: p.y - 30, zoom },
      performance.now(),
      this.opts.reducedMotion,
    );
    this.setFocus(key);
    this.moved = true;
    this.wake();
  }

  /** Keep the camera on a worker as it walks; null stops. */
  follow(key: string | null) {
    this.following = key;
    const w = key ? this.walkers.get(key) : null;
    if (!w) {
      this.camera.follow = null;
      return;
    }
    this.focusWorker(w.key, this.shift);
    this.camera.follow = () => {
      const cur = this.walkers.get(w.key);
      if (!cur) return { x: this.camera.x, y: this.camera.y + 30 };
      const p = iso(cur.pos.x, cur.pos.y);
      return { x: p.x - this.shift / this.camera.zoom, y: p.y };
    };
    this.wake();
  }

  zoomBy(factor: number) {
    const t = this.camera.target;
    this.camera.flyTo({ ...t, zoom: t.zoom * factor }, performance.now(), this.opts.reducedMotion, 180);
    this.userMoved();
    this.wake();
  }

  /** Pan by screen pixels (keyboard). */
  nudge(dx: number, dy: number) {
    const t = this.camera.target;
    this.camera.follow = null;
    this.following = null;
    this.camera.flyTo(
      { x: t.x + dx / t.zoom, y: t.y + dy / t.zoom, zoom: t.zoom },
      performance.now(),
      this.opts.reducedMotion,
      160,
    );
    this.userMoved();
    this.wake();
  }

  private userMoved() {
    this.moved = true;
    this.setFocus('free');
  }

  private setFocus(name: string) {
    this.focusName = name;
    this.opts.events.focus(name);
  }

  select(key: string | null) {
    if (key === this.selected) return;
    this.selected = key;
    for (const w of this.walkers.values()) this.paintSelection(w);
    this.wake();
  }

  // ---- Pointer --------------------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent | MouseEvent): Pt {
    const r = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The character under a screen point, front-most first. */
  private hit(sx: number, sy: number): Walker | null {
    const p = this.camera.toWorld(sx, sy);
    const pad = 4 / this.camera.zoom;
    let best: Walker | null = null;
    for (const w of this.walkers.values()) {
      if (w.hidden || w.leaving) continue;
      const f = iso(w.pos.x, w.pos.y);
      if (p.x < f.x - 13 - pad || p.x > f.x + 13 + pad || p.y < f.y - 50 - pad || p.y > f.y + 4 + pad)
        continue;
      if (!best || w.ch.root.zIndex > best.ch.root.zIndex) best = w;
    }
    return best;
  }

  private onDown = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.camera.stop();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      this.drag = null;
      return;
    }
    this.drag = { x: p.x, y: p.y, t: e.timeStamp, vx: 0, vy: 0, moved: false };
  };

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      this.camera.zoomAt(d / this.pinch, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      this.pinch = d;
      this.userMoved();
      this.wake();
      return;
    }
    const d = this.drag;
    if (d) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      if (!d.moved) {
        d.moved = true;
        this.camera.follow = null;
        this.following = null;
        this.userMoved();
        this.host.dataset.dragging = 'true';
      }
      const dt = Math.max(1, e.timeStamp - d.t);
      d.vx = d.vx * 0.6 + (dx / dt) * 0.4;
      d.vy = d.vy * 0.6 + (dy / dt) * 0.4;
      d.x = p.x;
      d.y = p.y;
      d.t = e.timeStamp;
      this.camera.panBy(dx, dy);
      this.wake();
      return;
    }
    // Hover: a hand cursor and a nameplate over whoever is under the pointer.
    const w = this.hit(p.x, p.y);
    const overDoor = !w && inPolygon(this.camera.toWorld(p.x, p.y), this.office?.door.hit ?? []);
    (this.app.canvas as HTMLCanvasElement).style.cursor = w || overDoor ? 'pointer' : 'grab';
    const key = w?.key ?? null;
    if (key !== this.hovered) {
      const before = this.hovered;
      this.hovered = key;
      for (const k of [before, key]) {
        const x = k ? this.walkers.get(k) : null;
        if (x) this.paintSelection(x);
      }
      this.wake();
    }
  };

  private onUp = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const d = this.drag;
    this.drag = null;
    delete this.host.dataset.dragging;
    if (!d || e.type === 'pointercancel') return;
    if (d.moved) {
      // A quick flick keeps gliding.
      if (e.timeStamp - d.t < 80 && !this.opts.reducedMotion) this.camera.fling(d.vx, d.vy);
      this.wake();
      return;
    }
    const w = this.hit(p.x, p.y);
    if (w) {
      this.opts.events.select(w.key);
      return;
    }
    if (inPolygon(this.camera.toWorld(p.x, p.y), this.office?.door.hit ?? [])) {
      this.opts.events.door();
      return;
    }
    this.opts.events.select(null);
  };

  private onLeave = () => {
    if (this.hovered && !this.drag) {
      const w = this.walkers.get(this.hovered);
      this.hovered = null;
      if (w) this.paintSelection(w);
      this.wake();
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) * unit >= 40 || e.deltaX === 0) {
      // Pinch on a trackpad arrives as ctrl+wheel with small deltas; a mouse wheel as big steps.
      const k = e.ctrlKey ? 0.012 : 0.0016;
      this.camera.zoomAt(Math.exp(-e.deltaY * unit * k), p.x, p.y);
    } else {
      this.camera.panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
    this.camera.follow = null;
    this.following = null;
    this.userMoved();
    this.wake();
  };

  /** Double-click: zoom into the area under the pointer, or onto a worker. */
  private onDouble = (e: MouseEvent) => {
    const p = this.local(e);
    const w = this.hit(p.x, p.y);
    if (w) return this.focusWorker(w.key);
    const world = this.camera.toWorld(p.x, p.y);
    const g = toGrid(world.x, world.y);
    const L = this.layout;
    const inside = (r: { x: number; y: number; w: number; h: number }) =>
      g.x >= r.x && g.y >= r.y && g.x < r.x + r.w && g.y < r.y + r.h;
    for (const name of ['door', 'pantry', ...L.teams.map((t) => t.project)])
      if (L.areas[name] && inside(L.areas[name]!)) return this.focus(name);
    this.camera.zoomAt(1.6, p.x, p.y);
    this.userMoved();
    this.wake();
  };

  private onResize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h || this.destroyed) return;
    this.app.renderer.resize(w, h);
    this.camera.resize(w, h);
    if (!this.moved && this.focusName !== 'free') this.focus(this.focusName, true);
    this.view();
    this.app.render();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    canvas.removeEventListener('pointerleave', this.onLeave);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('dblclick', this.onDouble);
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }
}
