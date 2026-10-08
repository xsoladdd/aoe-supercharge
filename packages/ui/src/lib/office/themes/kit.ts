import type { Graphics } from 'pixi.js';
import { fnv1a } from '@aoe-supercharge/core/shared';
import { iso, mix, quad, TILE_H, TILE_W, wallA, wallB, type Pt } from '../iso';

/**
 * Small drawing helpers the office themes share: shapes on the walls, glows, and a steady hash, so a
 * theme's art is the same every time it is drawn.
 */

/** Pixels along a wall per tile. */
export const ALONG = Math.hypot(TILE_W / 2, TILE_H / 2);

/** A stretch of wall A from grid x0 to x1 between heights h0 and h1 (px). */
export const rectA = (x0: number, x1: number, h0: number, h1: number): Pt[] => [
  wallA(x0, h0),
  wallA(x1, h0),
  wallA(x1, h1),
  wallA(x0, h1),
];

/** A stretch of wall B from grid y0 to y1 between heights h0 and h1 (px). */
export const rectB = (y0: number, y1: number, h0: number, h1: number): Pt[] => [
  wallB(y0, h0),
  wallB(y1, h0),
  wallB(y1, h1),
  wallB(y0, h1),
];

/** A point on wall A or B, by which wall. */
export const onWall = (wall: 'A' | 'B', u: number, h: number): Pt =>
  wall === 'A' ? wallA(u, h) : wallB(u, h);

/** An ellipse flat on a wall: centred `u` tiles along at height `h`, `r` px across and `ry` px tall. */
export function wallEllipse(wall: 'A' | 'B', u: number, h: number, r: number, ry = r, n = 28): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(onWall(wall, u + (Math.cos(a) * r) / ALONG, h + Math.sin(a) * ry));
  }
  return pts;
}

/** A shape drawn in wall coordinates: points as [tiles along, px up]. */
export const onWallPts = (wall: 'A' | 'B', pts: [number, number][]): Pt[] =>
  pts.map(([u, h]) => onWall(wall, u, h));

/** A soft round glow: rings of light fading out. */
export function glow(
  g: Graphics,
  x: number,
  y: number,
  r: number,
  color: number,
  alpha: number,
  ry = r * 0.8,
) {
  for (const [k, a] of [
    [1, 0.35],
    [0.66, 0.6],
    [0.38, 1],
  ] as const)
    g.ellipse(x, y, r * k, ry * k).fill({ color, alpha: alpha * a });
}

/** A steady number in [0, 1) for a key. */
export const rand = (key: string) => fnv1a(key) / 2 ** 32;

/** A box's three faces from one colour: lit top, a left face a little darker, the right darker still. */
export const faces = (c: number, light = 0.12, dark = 0.22) => ({
  top: mix(c, 0xffffff, light),
  left: c,
  right: mix(c, 0x000000, dark),
});

/** The floor diamond's corner points of a tile area, lifted `elev` px. */
export const floorPts = (x0: number, y0: number, x1: number, y1: number, elev = 0): Pt[] =>
  [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)].map((p) => ({ x: p.x, y: p.y - elev }));

/** A line between two grid points on the floor (lifted `elev` px). */
export function floorLine(g: Graphics, x0: number, y0: number, x1: number, y1: number, elev = 0) {
  const a = iso(x0, y0);
  const b = iso(x1, y1);
  return g.moveTo(a.x, a.y - elev).lineTo(b.x, b.y - elev);
}

/** Courses of blocks (bricks, ashlar, logs) over a whole wall: a few odd blocks, then mortar lines and staggered joints. */
export function courses(
  g: Graphics,
  wall: 'A' | 'B',
  length: number,
  o: {
    h0: number;
    h1: number;
    course: number;
    block: number;
    mortar: number;
    alpha?: number;
    width?: number;
    odd?: number[];
    seed: string;
  },
) {
  const rows: { h: number; top: number; shift: number }[] = [];
  for (let h = o.h0, row = 0; h < o.h1 - 0.5; h += o.course, row++)
    rows.push({ h, top: Math.min(o.h1, h + o.course), shift: row % 2 ? o.block / 2 : 0 });
  const rect = wall === 'A' ? rectA : rectB;
  // A few blocks a shade off, so the wall is not flat. Filled first: a fill takes the path drawn so far.
  if (o.odd?.length)
    rows.forEach(({ h, top, shift }, row) => {
      for (let u = -shift; u < length; u += o.block) {
        const r = rand(`${o.seed}:${wall}:${row}:${Math.round(u * 100)}`);
        if (r < 0.28)
          quad(g, rect(Math.max(0, u + 0.01), Math.min(length, u + o.block - 0.01), h + 0.4, top - 0.4)).fill(
            o.odd![Math.floor(r * 1000) % o.odd!.length]!,
          );
      }
    });
  for (const { h, top, shift } of rows) {
    const a = onWall(wall, 0, h);
    const b = onWall(wall, length, h);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    for (let u = o.block - shift; u < length; u += o.block) {
      const c = onWall(wall, u, h);
      const d = onWall(wall, u, top);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
  }
  g.stroke({ width: o.width ?? 0.8, color: o.mortar, alpha: o.alpha ?? 0.8 });
}

/**
 * A diamond lattice (leaded lights, buttoned leather) on a wall from `u0`, `w` tiles wide, between heights
 * h0 and h1: diagonals every `step` px, clipped to that rectangle. Strokes nothing; the caller strokes.
 */
export function lattice(
  g: Graphics,
  wall: 'A' | 'B',
  u0: number,
  w: number,
  h0: number,
  h1: number,
  step: number,
) {
  const len = w * ALONG;
  const height = h1 - h0;
  // Lines s = c + d·t, in px along (s) and up (t) the rectangle, for d = ±1.
  for (const d of [1, -1])
    for (let c = d === 1 ? -height : 0; c <= len + (d === 1 ? 0 : height); c += step) {
      const t0 = Math.max(0, d === 1 ? -c : c - len);
      const t1 = Math.min(height, d === 1 ? len - c : c);
      if (t1 <= t0) continue;
      const a = onWall(wall, u0 + (c + d * t0) / ALONG, h0 + t0);
      const b = onWall(wall, u0 + (c + d * t1) / ALONG, h0 + t1);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
}

/** Leaded lights over a window on wall B. */
export const latticeB = (g: Graphics, gy: number, w: number, h0: number, h1: number, step: number) =>
  lattice(g, 'B', gy, w, h0, h1, step);

/** A pointed arch on wall B over a window from `gy`, `w` tiles wide: springing at `spring`, its point at `apex`. */
export function archB(gy: number, w: number, spring: number, apex: number, n = 10): Pt[] {
  const half = w / 2;
  // Each side rises straight up from its springing and meets the other at an angle: a pointed arch.
  const side = (t: number) => ({
    u: half * (1 - Math.cos((t * Math.PI) / 2)),
    h: spring + ((apex - spring) * Math.sin((t * Math.PI) / 3)) / Math.sin(Math.PI / 3),
  });
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const { u, h } = side(i / n);
    pts.push(wallB(gy + u, h));
  }
  for (let i = n - 1; i >= 0; i--) {
    const { u, h } = side(i / n);
    pts.push(wallB(gy + w - u, h));
  }
  return pts;
}
