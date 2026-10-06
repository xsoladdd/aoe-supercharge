import type { Graphics } from 'pixi.js';

/** Isometric 2:1 projection. A tile (x, y) spans [x, x+1) × [y, y+1); its centre is (x+0.5, y+0.5). */
export const TILE_W = 64;
export const TILE_H = 32;
export const WALL_H = 86;

export interface Pt {
  x: number;
  y: number;
}

export function iso(x: number, y: number): Pt {
  return { x: ((x - y) * TILE_W) / 2, y: ((x + y) * TILE_H) / 2 };
}

/** Draw order for something standing at grid point (x, y): further back draws first. */
export function depth(x: number, y: number): number {
  return Math.round((x + y) * 100);
}

/** The inverse of `iso`: the grid point under a world point. */
export function toGrid(px: number, py: number): Pt {
  const a = px / (TILE_W / 2);
  const b = py / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

export interface BoxColors {
  top: number;
  left: number;
  right: number;
}

const flat = (pts: Pt[]) => pts.flatMap((p) => [p.x, p.y]);
const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });

/**
 * A box on the floor spanning grid [x0, x1] × [y0, y1], `h` px tall, lifted `elev` px. Only the faces a
 * viewer can see are drawn: the top, the face towards +y (left on screen) and the face towards +x.
 */
export function box(
  g: Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h: number,
  c: BoxColors,
  elev = 0,
  alpha = 1,
) {
  const A = up(iso(x0, y0), elev);
  const B = up(iso(x1, y0), elev);
  const C = up(iso(x1, y1), elev);
  const D = up(iso(x0, y1), elev);
  g.poly(flat([D, C, up(C, h), up(D, h)])).fill({ color: c.left, alpha });
  g.poly(flat([C, B, up(B, h), up(C, h)])).fill({ color: c.right, alpha });
  g.poly(flat([up(A, h), up(B, h), up(C, h), up(D, h)])).fill({ color: c.top, alpha });
}

/** A flat diamond on the floor (or lifted `elev` px). */
export function diamond(g: Graphics, x0: number, y0: number, x1: number, y1: number, elev = 0): Graphics {
  return g.poly(flat([iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)].map((p) => up(p, elev))));
}

/** A point on the back wall along y = 0 (wall A), `h` px up. */
export function wallA(gx: number, h: number): Pt {
  return up(iso(gx, 0), h);
}

/** A point on the back wall along x = 0 (wall B), `h` px up. */
export function wallB(gy: number, h: number): Pt {
  return up(iso(0, gy), h);
}

export function quad(g: Graphics, pts: Pt[]): Graphics {
  return g.poly(flat(pts));
}

/** Mix two 0xRRGGBB colours; t = 0 gives a. */
export function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

export const shade = (c: number, t: number) => mix(c, 0x000000, t);
export const tint = (c: number, t: number) => mix(c, 0xffffff, t);
