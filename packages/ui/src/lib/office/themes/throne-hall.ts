import type { Graphics } from 'pixi.js';
import { fnv1a } from '@aoe-supercharge/core/shared';
import { defaultArt, featureSpan, GLASS_H, windowsOf } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB, WALL_H, type Pt } from '../iso';
import type { Palette } from '../palette';
import { ALONG, archB, courses, floorLine, glow, latticeB, onWall, rectA, rectB, wallEllipse } from './kit';
import type { Motion, OfficeTheme, ThemeArt } from './types';

/**
 * Throne Hall: a royal castle. Ashlar walls with battlements, flagstones, arched leaded windows,
 * heraldic banners and torches, a red carpet with gold edging up the line to your door, and your corner
 * the throne room: tapestries, and a great arched oak door with a throne beyond.
 */

const ROYAL_BLUE = 0x223e86;

/** A pointed arch on wall A from x0 to x1, springing at `spring`, its point at `apex`. */
function archA(x0: number, x1: number, spring: number, apex: number, n = 10): Pt[] {
  const half = (x1 - x0) / 2;
  const side = (t: number) => ({
    u: half * (1 - Math.cos((t * Math.PI) / 2)),
    h: spring + ((apex - spring) * Math.sin((t * Math.PI) / 3)) / Math.sin(Math.PI / 3),
  });
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) pts.push(wallA(x0 + side(i / n).u, side(i / n).h));
  for (let i = n - 1; i >= 0; i--) pts.push(wallA(x1 - side(i / n).u, side(i / n).h));
  return pts;
}

/** A banner hanging from a gold rod on a wall: swallowtailed, edged in gold, with a crest. */
function banner(
  g: Graphics,
  p: Palette,
  wall: 'A' | 'B',
  u: number,
  color: number,
  w = 0.5,
  top = 80,
  bottom = 36,
) {
  const at = (du: number, h: number) => onWall(wall, u + du, h);
  const half = w / 2;
  quad(g, [at(-half, top), at(half, top), at(half, bottom), at(0, bottom + 7), at(-half, bottom)]).fill(
    color,
  );
  // A gold edge, a band, and a crest: a cross in a ring.
  const edge = [
    at(-half + 0.03, top - 2),
    at(half - 0.03, top - 2),
    at(half - 0.03, bottom + 2),
    at(0, bottom + 8.5),
    at(-half + 0.03, bottom + 2),
  ];
  g.poly(
    edge.flatMap((q) => [q.x, q.y]),
    true,
  ).stroke({ width: 0.9, color: p.brass, alpha: 0.9 });
  quad(g, [at(-half, top - 8), at(half, top - 8), at(half, top - 10), at(-half, top - 10)]).fill({
    color: p.brass,
    alpha: 0.85,
  });
  const mid = (top + bottom) / 2 - 2;
  const r = (w * ALONG) / 4.2;
  quad(g, wallEllipse(wall, u, mid, r)).stroke({ width: 1.2, color: p.brass });
  const arm = (r * 0.7) / ALONG;
  const [n, s2, e, w2] = [at(0, mid + r * 0.7), at(0, mid - r * 0.7), at(arm, mid), at(-arm, mid)];
  g.moveTo(n.x, n.y)
    .lineTo(s2.x, s2.y)
    .moveTo(w2.x, w2.y)
    .lineTo(e.x, e.y)
    .stroke({ width: 1.2, color: p.brass });
  const a = at(-half - 0.06, top + 1);
  const b = at(half + 0.06, top + 1);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 2, color: p.brass, cap: 'round' });
}

/** A torch: an iron bracket, a wooden haft, and its flame (a moving bit). */
function torch(
  g: Graphics,
  p: Palette,
  wall: 'A' | 'B',
  u: number,
  h: number,
  make: () => Graphics,
  key: string,
): Motion {
  const base = onWall(wall, u, h);
  g.rect(base.x - 2, base.y - 1, 4, 5).fill(p.metal.right);
  g.moveTo(base.x, base.y + 2)
    .lineTo(base.x + (wall === 'A' ? 3 : -3), base.y - 8)
    .stroke({ width: 2.4, color: 0x4a3424, cap: 'round' });
  const tip = { x: base.x + (wall === 'A' ? 3.4 : -3.4), y: base.y - 10 };
  g.ellipse(tip.x, tip.y + 1, 3, 1.6).fill(p.metal.top);
  const flame = make();
  const phase = (fnv1a(key) % 628) / 100;
  return {
    g: flame,
    draw(t) {
      const f = t ? 1 + 0.12 * Math.sin(t / 95 + phase) + 0.07 * Math.sin(t / 41 + phase * 1.7) : 1;
      const sway = t ? 1.1 * Math.sin(t / 130 + phase) : 0;
      flame.clear();
      glow(flame, tip.x, tip.y - 6, 26 * f, p.glow, p.theme === 'dark' ? 0.34 : 0.14);
      const tear = (r: number, len: number, color: number) =>
        flame
          .moveTo(tip.x - r, tip.y)
          .quadraticCurveTo(tip.x - r, tip.y - len * 0.45, tip.x + sway, tip.y - len * f)
          .quadraticCurveTo(tip.x + r, tip.y - len * 0.45, tip.x + r, tip.y)
          .quadraticCurveTo(tip.x, tip.y + r * 0.6, tip.x - r, tip.y)
          .fill(color);
      tear(3.6, 13, 0xe8642a);
      tear(2.4, 9.5, 0xffa53a);
      tear(1.2, 6, 0xfff0b8);
    },
  };
}

/** A tapestry on wall A from x0 to x1: red with a gold border and fringe, a crown woven in. */
function tapestry(g: Graphics, p: Palette, x0: number, x1: number, h0: number, h1: number) {
  quad(g, rectA(x0, x1, h0, h1)).fill(p.panel.face);
  quad(g, rectA(x0 + 0.06, x1 - 0.06, h0 + 3, h1 - 3)).stroke({ width: 1.2, color: p.panel.frame });
  const mid = (x0 + x1) / 2;
  const h = (h0 + h1) / 2 + 2;
  const w = Math.min(0.5, (x1 - x0) / 3);
  const crown: [number, number][] = [
    [-w, h - 6],
    [w, h - 6],
    [w, h + 4],
    [w / 2, h],
    [0, h + 7],
    [-w / 2, h],
    [-w, h + 4],
  ];
  quad(
    g,
    crown.map(([du, hh]) => wallA(mid + du, hh)),
  ).fill(p.panel.frame);
  for (const du of [-w, 0, w]) {
    const c = wallA(mid + du, du ? h + 5 : h + 8);
    g.circle(c.x, c.y, 1.3).fill(0xb3392f);
  }
  // The rod, and a fringe along the bottom.
  const a = wallA(x0 - 0.05, h1 + 1);
  const b = wallA(x1 + 0.05, h1 + 1);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 2, color: p.panel.frame, cap: 'round' });
  for (let u = x0 + 0.04; u < x1; u += 0.08) {
    const c = wallA(u, h0);
    g.moveTo(c.x, c.y).lineTo(c.x, c.y + 3);
  }
  g.stroke({ width: 0.8, color: p.panel.frame });
}

const art: Partial<ThemeArt> = {
  // Flagstones: two courses of stones a tile, their joints staggered.
  floor(g, p, x, y, tile) {
    if (tile.kind !== 'open') return defaultArt.floor(g, p, x, y, tile);
    const joints: number[] = [];
    for (const k of [0, 0.5]) {
      const h = fnv1a(`flag:${x},${y},${k}`);
      const o = 0.2 + (h % 50) / 100;
      joints.push(o);
      for (const [u0, u1, j] of [
        [0, o, 1],
        [o, 1, 2],
      ] as const)
        diamond(g, x + u0, y + k, x + u1, y + k + 0.5).fill(
          mix(p.corridor[0], p.corridor[1], ((h >> (j * 7)) % 100) / 100),
        );
    }
    // Joints after the stones: a fill would take any line drawn before it.
    joints.forEach((o, i) => floorLine(g, x + o, y + i * 0.5, x + o, y + i * 0.5 + 0.5));
    floorLine(g, x, y + 0.5, x + 1, y + 0.5);
    floorLine(g, x, y, x + 1, y);
    floorLine(g, x, y, x, y + 1);
    g.stroke({ width: 1, color: p.seam, alpha: 0.75 });
  },
  // The red carpet: gold edging, and a gold lozenge down the middle.
  runner(g, p, r) {
    diamond(g, r.x + 0.08, r.y + 0.02, r.x + r.w - 0.08, r.y + r.h - 0.06).stroke({
      width: 3.2,
      color: p.runner.border,
    });
    diamond(g, r.x + 0.2, r.y + 0.12, r.x + r.w - 0.2, r.y + r.h - 0.16).stroke({
      width: 1,
      color: p.runner.border,
      alpha: 0.8,
    });
    for (let y = r.y + 0.5; y < r.y + r.h - 0.4; y += 1) {
      const c = r.x + r.w / 2;
      const pts = [iso(c, y - 0.22), iso(c + 0.16, y), iso(c, y + 0.22), iso(c - 0.16, y)];
      g.poly(pts.flatMap((q) => [q.x, q.y])).fill({ color: p.runner.pattern, alpha: 0.95 });
    }
  },
  // Ashlar, with battlements along the top.
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    const W = layout.width;
    const H = layout.height;
    for (const [wall, len, color] of [
      ['A', W, p.wallRight],
      ['B', H, p.wallLeft],
    ] as const) {
      courses(g, wall, len, {
        h0: 6,
        h1: 80,
        course: 9.25,
        block: 0.72,
        mortar: shade(color, 0.35),
        alpha: 0.85,
        odd: [shade(color, 0.08), tint(color, 0.06), mix(color, 0x6a6050, 0.2)],
        seed: 'throne',
      });
      const rect = wall === 'A' ? rectA : rectB;
      for (let u = 0.05; u < len - 0.2; u += 0.72)
        quad(g, rect(u, u + 0.38, WALL_H, WALL_H + 8)).fill(p.wallTop);
      for (let u = 0.05; u < len - 0.2; u += 0.72) {
        const a = onWall(wall, u, WALL_H + 8);
        const b = onWall(wall, u + 0.38, WALL_H + 8);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 1, color: tint(p.wallTop, 0.2) });
    }
  },
  // A pointed arch, leaded in diamonds.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy - 0.12, gy + 1.92, 24, 74)).fill(shade(p.wallLeft, 0.3));
    quad(g, rectB(gy, gy + 1.8, 28, 70)).fill(p.window);
    latticeB(drapes, gy, 1.8, 28, 70, 7);
    drapes.stroke({ width: 0.7, color: p.windowFrame, alpha: 0.7 });
    // The stone over the arch, either side of its point.
    const arch = archB(gy, 1.8, 54, 70);
    const left = [wallB(gy, 54), ...arch.slice(0, 11), wallB(gy, 70.5)];
    const right = [wallB(gy + 1.8, 54), ...arch.slice(10).reverse(), wallB(gy + 1.8, 70.5)];
    for (const side of [left, right]) quad(drapes, side).fill(p.wallLeft);
    drapes
      .poly(
        [wallB(gy, 28), ...arch, wallB(gy + 1.8, 28)].flatMap((q) => [q.x, q.y]),
        false,
      )
      .stroke({
        width: 3,
        color: p.wallTop,
      });
    quad(drapes, rectB(gy - 0.14, gy + 1.94, 24, 28)).fill(p.wallTop);
  },
  // The royal crest: a quartered shield under a crown, two swords behind.
  feature(g, p, x0, x1) {
    const mid = (x0 + x1) / 2;
    for (const d of [-1, 1]) {
      const a = wallA(mid - d * 1.25, 18);
      const b = wallA(mid + d * 1.25, 70);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 3, color: 0xc9cdd2, cap: 'round' });
      const hilt = wallA(mid - d * 1.05, 26);
      const k0 = wallA(mid - d * 1.05 - 0.14, 22);
      const k1 = wallA(mid - d * 1.05 + 0.14, 30);
      g.moveTo(k0.x, k0.y).lineTo(k1.x, k1.y).stroke({ width: 2.4, color: p.brass, cap: 'round' });
      g.circle(hilt.x, hilt.y, 1).fill(p.brass);
    }
    const w = 0.85;
    // The shield's outline in wall terms (tiles from the middle, px up): flat top, curving to a point.
    const side = (sign: 1 | -1, inset: number): [number, number][] =>
      Array.from({ length: 9 }, (_, i) => {
        const t = (i + 1) / 10;
        return [
          sign * (w - inset) * Math.cos((t * Math.PI) / 2),
          44 - (22 - inset) * Math.sin((t * Math.PI) / 2),
        ];
      });
    const shield = (inset: number): [number, number][] => [
      [-w + inset, 66 - inset],
      [w - inset, 66 - inset],
      [w - inset, 44],
      ...side(1, inset),
      [0, 22 + inset],
      ...side(-1, inset).reverse(),
      [-w + inset, 44],
    ];
    const onA = (pts: [number, number][]) => pts.map(([du, h]) => wallA(mid + du, h));
    quad(g, onA(shield(0))).fill(p.brass);
    quad(g, onA(shield(0.07))).fill(ROYAL_BLUE);
    // Two red quarters, top right and bottom left.
    quad(
      g,
      onA([
        [0, 44],
        [w - 0.07, 44],
        [w - 0.07, 65.93],
        [0, 65.93],
      ]),
    ).fill(0x8c1c24);
    quad(g, onA([[0, 44], [-w + 0.07, 44], ...side(-1, 0.07), [0, 22.07]])).fill(0x8c1c24);
    for (const [du, h] of [
      [-0.42, 56],
      [0.42, 34],
    ] as const) {
      const c = wallA(mid + du, h);
      g.poly([c.x, c.y - 6, c.x + 3, c.y, c.x, c.y + 6, c.x - 3, c.y]).fill(p.brass);
    }
    for (const [du, h] of [
      [0.42, 56],
      [-0.4, 36],
    ] as const) {
      const c = wallA(mid + du, h);
      g.circle(c.x, c.y, 3).fill(p.brass);
    }
    // The crown over it.
    const crown: [number, number][] = [
      [-0.55, 68],
      [0.55, 68],
      [0.55, 76],
      [0.3, 72.5],
      [0, 80],
      [-0.3, 72.5],
      [-0.55, 76],
    ];
    quad(
      g,
      crown.map(([du, h]) => wallA(mid + du, h)),
    ).fill(p.brass);
    for (const du of [-0.55, 0, 0.55]) {
      const c = wallA(mid + du, du ? 77 : 81);
      g.circle(c.x, c.y, 1.6).fill(0xb3392f);
    }
  },
  // The throne room's wall: tapestries either side of the door, stone pilasters by it.
  suite(g, p, s) {
    tapestry(g, p, s.x0 + 0.15, s.door - 0.55, 20, 74);
    tapestry(g, p, s.door + 1.55, s.x1 - 0.3, 20, 74);
    for (const u of [s.door - 0.3, s.door + 1.12])
      quad(g, rectA(u, u + 0.18, 0, 80)).fill(tint(p.wallRight, 0.08));
  },
  // A great arched oak door with iron straps; open, the throne beyond.
  door(g, p, q, open) {
    const surround = archA(q - 0.14, q + 1.14, 52, 76);
    quad(g, [wallA(q - 0.14, 0), ...surround, wallA(q + 1.14, 0)]).fill(p.wallTop);
    const opening = archA(q + 0.02, q + 0.98, 50, 70);
    const shape = [wallA(q + 0.02, 0), ...opening, wallA(q + 0.98, 0)];
    if (open) {
      quad(g, shape).fill(shade(p.panel.shadow, 0.4));
      const c = wallA(q + 0.5, 30);
      g.ellipse(c.x, c.y, 20, 28).fill({ color: p.glow, alpha: 0.24 });
      // The throne: a tall red back edged in gold, a crown on top, the seat.
      quad(g, rectA(q + 0.34, q + 0.66, 10, 46)).fill(p.panel.frame);
      quad(g, rectA(q + 0.38, q + 0.62, 14, 44)).fill(0x8c1c24);
      quad(g, rectA(q + 0.28, q + 0.72, 8, 14)).fill(p.panel.frame);
      const t = wallA(q + 0.5, 46);
      g.poly([
        t.x - 5,
        t.y,
        t.x + 5,
        t.y,
        t.x + 5,
        t.y - 5,
        t.x + 2.5,
        t.y - 2.5,
        t.x,
        t.y - 7,
        t.x - 2.5,
        t.y - 2.5,
        t.x - 5,
        t.y - 5,
      ]).fill(p.panel.frame);
      return;
    }
    quad(g, shape).fill(p.door);
    for (let u = q + 0.14; u < q + 0.95; u += 0.12) {
      const a = wallA(u, 0);
      const b = wallA(u, 70);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 0.8, color: shade(p.door, 0.35), alpha: 0.8 });
    quad(g, shape).stroke({ width: 1.4, color: shade(p.door, 0.4) });
    for (const h of [14, 44]) {
      quad(g, rectA(q + 0.04, q + 0.96, h, h + 3.5)).fill(0x22201d);
      for (const u of [q + 0.1, q + 0.3, q + 0.5, q + 0.7, q + 0.9]) {
        const c = wallA(u, h + 1.75);
        g.circle(c.x, c.y, 0.8).fill(0x6e6a62);
      }
    }
    for (const u of [q + 0.4, q + 0.6]) {
      const k = wallA(u, 30);
      g.ellipse(k.x, k.y + 3, 2.6, 3.2).stroke({ width: 1.2, color: 0x22201d });
    }
  },
  // Banners between the windows and either side of the crest; torches beside them and by your door.
  extras(g, p, layout, make) {
    const motion: Motion[] = [];
    const wins = windowsOf(layout);
    for (let i = 0; i + 1 < wins.length; i++) {
      const y = (wins[i]! + 1.8 + wins[i + 1]!) / 2;
      banner(g, p, 'B', y, i % 2 ? 0x8c1c24 : ROYAL_BLUE);
    }
    const span = featureSpan(layout);
    if (span) {
      banner(g, p, 'A', span.x0 - 0.1, 0x8c1c24, 0.6, 80, 30);
      banner(g, p, 'A', span.x1 + 0.1, 0x8c1c24, 0.6, 80, 30);
      motion.push(
        torch(g, p, 'A', span.x0 - 0.75, 50, make, 'f0'),
        torch(g, p, 'A', span.x1 + 0.75, 50, make, 'f1'),
      );
    }
    for (let i = 0; i < wins.length; i++) motion.push(torch(g, p, 'B', wins[i]! - 0.36, 52, make, `w${i}`));
    const d = layout.door.x;
    motion.push(torch(g, p, 'A', d - 0.2, 54, make, 'd0'), torch(g, p, 'A', d + 1.2, 54, make, 'd1'));
    return motion;
  },
  // A stone balustrade: a rail and a plinth, balusters between.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    const at = (t: number, h: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - h });
    for (let t = 0.1; t < 1; t += 0.2) {
      const c = at(t, 0);
      g.rect(c.x - 1.3, c.y - GLASS_H + 4, 2.6, GLASS_H - 8).fill(p.glass.pane);
      g.ellipse(c.x, c.y - GLASS_H / 2, 2.4, 4.5).fill(p.glass.pane);
      g.rect(c.x - 0.5, c.y - GLASS_H + 4, 0.8, GLASS_H - 8).fill({ color: 0xffffff, alpha: 0.18 });
    }
    quad(g, [at(0, 0), at(1, 0), at(1, 4), at(0, 4)]).fill(p.glass.rail);
    quad(g, [at(0, GLASS_H - 4), at(1, GLASS_H - 4), at(1, GLASS_H), at(0, GLASS_H)]).fill(p.glass.pane);
    const c = at(0, GLASS_H);
    const d = at(1, GLASS_H);
    g.moveTo(c.x, c.y)
      .lineTo(d.x, d.y)
      .stroke({ width: 1, color: tint(p.glass.pane, 0.25) });
    g.rect(a.x - 2, a.y - GLASS_H, 4, GLASS_H).fill(p.glass.rail);
  },
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) {
      g.rect(q.x - 2.8, q.y - GLASS_H - 12, 5.6, GLASS_H + 12).fill(p.glass.rail);
      g.rect(q.x - 2.8, q.y - GLASS_H - 12, 1.6, GLASS_H + 12).fill(tint(p.glass.rail, 0.15));
    }
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 5, color: p.glass.rail });
  },
  // Clipped topiary in a stone urn: a ball here, a cone there.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    const urn = p.plant.pot;
    g.poly([c.x - 5, c.y, c.x + 5, c.y, c.x + 3, c.y - 4, c.x - 3, c.y - 4]).fill(shade(urn, 0.15));
    g.poly([c.x - 3, c.y - 4, c.x + 3, c.y - 4, c.x + 8, c.y - 15, c.x - 8, c.y - 15]).fill(urn);
    g.ellipse(c.x, c.y - 15, 9, 3.4).fill(tint(urn, 0.15));
    g.ellipse(c.x, c.y - 15, 7, 2.4).fill(0x3a2a1f);
    g.rect(c.x - 1, c.y - 24, 2, 9).fill(0x4a3424);
    if ((x + y) % 2) {
      g.circle(c.x, c.y - 30, 10).fill(p.plant.leaf);
      g.circle(c.x - 3, c.y - 33, 5).fill({ color: p.plant.leafLight, alpha: 0.8 });
    } else {
      g.poly([c.x - 9, c.y - 22, c.x + 9, c.y - 22, c.x, c.y - 48]).fill(p.plant.leaf);
      g.poly([c.x - 5, c.y - 24, c.x, c.y - 24, c.x, c.y - 44]).fill({
        color: p.plant.leafLight,
        alpha: 0.7,
      });
    }
  },
  // A dark oak table with a gold candelabra.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y + 1, 22, 10).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.1 : 0.05 });
    box(g, f.x + 0.2, f.y + 0.2, f.x + 0.8, f.y + 0.8, 18, p.wood);
    const base = { x: c.x, y: c.y - 18 };
    glow(g, base.x, base.y - 24, 26, p.glow, p.theme === 'dark' ? 0.3 : 0.12);
    g.ellipse(base.x, base.y - 1, 5, 2).fill(p.brass);
    g.rect(base.x - 1, base.y - 16, 2, 15).fill(p.brass);
    g.moveTo(base.x - 9, base.y - 22)
      .quadraticCurveTo(base.x - 9, base.y - 14, base.x, base.y - 14)
      .quadraticCurveTo(base.x + 9, base.y - 14, base.x + 9, base.y - 22)
      .stroke({ width: 1.8, color: p.brass });
    for (const dx of [-9, 0, 9]) {
      const top = dx ? base.y - 22 : base.y - 26;
      g.rect(base.x + dx - 1.4, top - 7, 2.8, 7).fill(0xf3ead6);
      g.ellipse(base.x + dx, top - 10, 1.6, 3).fill(0xffb347);
      g.ellipse(base.x + dx, top - 9.4, 0.8, 1.6).fill(0xfff1c9);
    }
  },
  table(g, p, f) {
    defaultArt.table(g, p, f);
    // A goblet.
    const c = iso(f.x + 0.42, f.y + 0.4);
    g.rect(c.x - 0.6, c.y - 22, 1.2, 4).fill(p.brass);
    g.poly([c.x - 2, c.y - 26, c.x + 2, c.y - 26, c.x + 0.8, c.y - 22, c.x - 0.8, c.y - 22]).fill(p.brass);
  },
};

export const throneHall: OfficeTheme = {
  id: 'throne-hall',
  name: 'Throne Hall',
  blurb: 'Stone, banners and a red carpet',
  thumb: { floor: 'flags', accent: { dark: 0x8c1c24, light: 0x8c1c24 } },
  art,
  colours: {
    dark: {
      corridor: [0x3a3835, 0x45423e],
      seam: 0x1f1d1b,
      pantry: [0x3e2c1f, 0x3a291d],
      lounge: [0x1f2a4a, 0x1d2746],
      kitchen: {
        floor: [0x37342f, 0x2a2724],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x3d3a35,
        grout: 0x2a2825,
        block: 0x8a6a48,
        cabinet: { left: 0x3a2a1f, right: 0x2e2118 },
        copper: 0xb5683f,
      },
      carpets: [
        [0x262c4c, 0x293050],
        [0x4a1f22, 0x4e2225],
        [0x263826, 0x293c29],
        [0x3a2843, 0x3e2b47],
        [0x46371d, 0x4a3a20],
        [0x1f3838, 0x223c3c],
      ],
      wallLeft: 0x46433e,
      wallRight: 0x4f4c46,
      wallTop: 0x5c5852,
      trim: 0x34322e,
      baseboard: 0x2a2825,
      window: 0x1a2236,
      windowFrame: 0x15130f,
      glass: { pane: 0x6e6a63, rail: 0x55524c },
      curtain: 0x6b1a20,
      wood: { top: 0x5a4030, left: 0x4a3424, right: 0x3d2a1c },
      metal: { top: 0x3a3c40, left: 0x2c2e31, right: 0x232528 },
      monitor: 0x15171b,
      screen: 0x3d7fc4,
      chair: 0x5a1a20,
      plant: { pot: 0x7a766e, leaf: 0x2a5a32, leafLight: 0x3f7a44 },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x6b1a22, back: 0x581519 },
      felt: 0x2f6f4a,
      door: 0x5a3a22,
      doorFrame: 0x2f2d2a,
      brass: 0xd4a640,
      sign: 0x1f1a16,
      signText: 0xf0d78c,
      panel: { face: 0x6b1a20, frame: 0xd4a640, shadow: 0x2a1012 },
      rope: 0x8c1c24,
      runner: { base: 0x7a1820, border: 0xc9a03c, pattern: 0xb8862e },
      glow: 0xffa040,
      map: { paper: 0xd8c8a0, land: 0x6b4a2a, frame: 0x4a3424 },
      board: { frame: 0x4a3424 },
      books: [0x6b1a20, 0x223e86, 0x8c6a28, 0x3a2a1f, 0x2a4a2a, 0xd4a640],
      shadow: 0x000000,
    },
    light: {
      corridor: [0xb4afa5, 0xbcb7ad],
      seam: 0x847f76,
      pantry: [0xcdb08c, 0xc7aa86],
      lounge: [0x1c2440, 0x1a223d],
      kitchen: {
        floor: [0xc4beb3, 0xb2ada3],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xb9b3a8,
        grout: 0x8f897f,
        block: 0xc28d5c,
        cabinet: { left: 0x664630, right: 0x543a26 },
        copper: 0xc0703f,
      },
      carpets: [
        [0xb8bfd8, 0xb2b9d2],
        [0xd8b8b8, 0xd2b2b2],
        [0xbcd0b8, 0xb6cab2],
        [0xcdb8d4, 0xc7b2ce],
        [0xdcc9a0, 0xd6c39a],
        [0xb4d0cf, 0xaecac9],
      ],
      wallLeft: 0xb1aba0,
      wallRight: 0xbcb6ab,
      wallTop: 0xcfc9bd,
      trim: 0x8a857b,
      baseboard: 0x6f6a62,
      window: 0xcfe3f2,
      windowFrame: 0x4a4740,
      glass: { pane: 0xd8d2c6, rail: 0xa49e92 },
      curtain: 0x8c1c24,
      wood: { top: 0x7a5638, left: 0x664630, right: 0x543a26 },
      metal: { top: 0x5a5c60, left: 0x4a4c50, right: 0x3d3f43 },
      monitor: 0x2b2e35,
      screen: 0x8fc4f5,
      chair: 0x7a1f26,
      plant: { pot: 0xa8a296, leaf: 0x3a7a42, leafLight: 0x56a05c },
      fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
      sofa: { seat: 0x8c1c24, back: 0x741820 },
      felt: 0x3f8f5f,
      door: 0x6e4a2c,
      doorFrame: 0x5a5650,
      brass: 0xc99a35,
      sign: 0x2a1f18,
      signText: 0xf3dc98,
      panel: { face: 0x7a1a22, frame: 0xc99a35, shadow: 0x4a1014 },
      rope: 0x8c1c24,
      runner: { base: 0x5c1016, border: 0xd4a640, pattern: 0xc08a30 },
      glow: 0xffb050,
      map: { paper: 0xe8dcc0, land: 0x7a5638, frame: 0x664630 },
      board: { frame: 0x664630 },
      books: [0x6b1a20, 0x223e86, 0x8c6a28, 0x3a2a1f, 0x2a4a2a, 0xd4a640],
      shadow: 0x2a2d35,
    },
  },
};
