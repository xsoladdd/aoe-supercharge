import type { Graphics } from 'pixi.js';
import { fnv1a, type WindowLook } from '@aoe-supercharge/core/shared';
import { defaultArt, featureSpan, GLASS_H, POST_H, ropeWith } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB, type Pt } from '../iso';
import type { Palette } from '../palette';
import { ALONG, faces, floorLine, glow, onWall, onWallPts, rand, rectA, rectB, wallEllipse } from './kit';
import type { Motion, OfficeTheme, ThemeArt } from './types';

/**
 * Starship: the bridge of a ship. Deck plates with light strips, panelled hull walls, viewports onto
 * stars and a planet (its lit side by day, its dark side by night; never rain), console desks, a star
 * chart, hydroponic pods, a holo projector by your door, and a blast door that splits open.
 *
 * The glow is a pale ice blue, kept well apart from the status cyan; the indicator lights are ice,
 * amber and white, never a status red or green.
 */

const HAZARD = 0xe0a526;
const HAZARD_DARK = 0x1c1d1f;
const SPACE = 0x02040a;

const flat = (pts: Pt[]) => pts.flatMap((q) => [q.x, q.y]);

/** Clip a shape in wall coordinates ([along, up]) to the band from u0 to u1. */
function clipU(pts: [number, number][], u0: number, u1: number): [number, number][] {
  let out = pts;
  for (const [edge, keep] of [
    [u0, (u: number) => u >= u0],
    [u1, (u: number) => u <= u1],
  ] as const) {
    const next: [number, number][] = [];
    out.forEach((cur, i) => {
      const prev = out[(i + out.length - 1) % out.length]!;
      if (keep(cur[0]) !== keep(prev[0])) {
        const t = (edge - prev[0]) / (cur[0] - prev[0]);
        next.push([edge, prev[1] + (cur[1] - prev[1]) * t]);
      }
      if (keep(cur[0])) next.push(cur);
    });
    out = next;
  }
  return out;
}

/** Yellow and black hazard stripes over a band of wall, from u0 to u1 between heights h0 and h1. */
function hazard(g: Graphics, wall: 'A' | 'B', u0: number, u1: number, h0: number, h1: number) {
  quad(g, wall === 'A' ? rectA(u0, u1, h0, h1) : rectB(u0, u1, h0, h1)).fill(HAZARD);
  const step = 0.08;
  const lean = (h1 - h0) / ALONG;
  for (let u = u0 - lean; u < u1; u += step * 2) {
    const stripe = clipU(
      [
        [u, h0],
        [u + step, h0],
        [u + step + lean, h1],
        [u + lean, h1],
      ],
      u0,
      u1,
    );
    if (stripe.length >= 3) g.poly(flat(onWallPts(wall, stripe))).fill(HAZARD_DARK);
  }
}

/** Points round an ellipse at (x, y), `rx` by `ry`, tilted by `tilt` radians. */
function ellipsePts(x: number, y: number, rx: number, ry: number, tilt = 0, n = 32): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ex = Math.cos(a) * rx;
    const ey = Math.sin(a) * ry;
    out.push(x + ex * Math.cos(tilt) - ey * Math.sin(tilt), y + ex * Math.sin(tilt) + ey * Math.cos(tilt));
  }
  return out;
}

/**
 * A planet `r` px across, round as seen through the glass, centred `u` tiles along wall B at height `h`:
 * its night side from the terminator at `lit` (1: all lit, -1: all dark), and maybe a ring.
 */
function planet(g: Graphics, u: number, h: number, r: number, body: number, lit: number, ring: boolean) {
  const c = wallB(u, h);
  if (ring)
    g.poly(ellipsePts(c.x, c.y, r * 1.55, r * 0.36, -0.35)).stroke({
      width: 2.4,
      color: tint(body, 0.35),
      alpha: 0.35,
    });
  g.circle(c.x, c.y, r).fill(body);
  for (const dy of [-0.45, -0.1, 0.3]) {
    const w = Math.sqrt(1 - dy * dy) * r;
    g.moveTo(c.x - w, c.y + dy * r).lineTo(c.x + w, c.y + dy * r);
  }
  g.stroke({ width: r * 0.12, color: tint(body, 0.18), alpha: 0.6 });
  const side: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    side.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  }
  for (let i = 16; i >= 0; i--) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    side.push(c.x + lit * Math.cos(a) * r, c.y + Math.sin(a) * r);
  }
  g.poly(side).fill({ color: SPACE, alpha: 0.82 });
  g.circle(c.x, c.y, r + 1.2).stroke({ width: 1.4, color: 0x9fd8ff, alpha: 0.3 });
  // The near half of the ring, in front of the planet.
  if (ring) {
    const front: number[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI;
      const ex = Math.cos(a) * r * 1.55;
      const ey = Math.sin(a) * r * 0.36;
      front.push(
        c.x + ex * Math.cos(-0.35) - ey * Math.sin(-0.35),
        c.y + ex * Math.sin(-0.35) + ey * Math.cos(-0.35),
      );
    }
    g.moveTo(front[0]!, front[1]!);
    for (let i = 2; i < front.length; i += 2) g.lineTo(front[i]!, front[i + 1]!);
    g.stroke({ width: 2.4, color: tint(body, 0.35), alpha: 0.85 });
  }
}

/** Deep space through a viewport: stars, a faint nebula, and a planet or a moon. Space has no weather. */
function spaceView(g: Graphics, p: Palette, gy: number, look: WindowLook) {
  const u0 = gy - 0.05;
  const u1 = gy + 1.85;
  const day = p.theme === 'light';
  quad(g, rectB(u0, u1, 22, 74)).fill(mix(SPACE, 0x0c1838, day ? 0.6 + look.sky * 0.3 : 0.25));
  const seed = Math.round(gy * 10);
  g.poly(flat(wallEllipse('B', gy + 0.5, 60, 26, 9, 20))).fill({ color: 0x6a4ac4, alpha: 0.14 });
  g.poly(flat(wallEllipse('B', gy + 0.7, 56, 18, 6, 20))).fill({ color: 0x3a8ac4, alpha: 0.14 });
  for (let i = 0; i < 22; i++) {
    const r = rand(`space:${seed}:${i}`);
    const c = wallB(u0 + 0.06 + r * 1.78, 25 + rand(`space-h:${seed}:${i}`) * 46);
    g.circle(c.x, c.y, r > 0.85 ? 1.1 : 0.6).fill({ color: 0xffffff, alpha: 0.45 + (i % 3) * 0.2 });
  }
  const kind = fnv1a(`world:${seed}`) % 3;
  if (kind === 0) planet(g, gy + 1.0, 46, 13, 0xc27a4a, day ? 0.55 : -0.55, true);
  else if (kind === 1) planet(g, gy + 0.6, 42, 13, 0x3a6ea8, day ? 0.45 : -0.6, false);
  else planet(g, gy + 1.35, 58, 6, 0x9aa0a8, day ? 0.3 : -0.4, false);
}

/** A screen on a wall: a dark glass face in a frame, with a few readouts in the glow colour. */
function screen(
  g: Graphics,
  p: Palette,
  wall: 'A' | 'B',
  u0: number,
  u1: number,
  h0: number,
  h1: number,
  seed: string,
) {
  const rect = wall === 'A' ? rectA : rectB;
  quad(g, rect(u0 - 0.04, u1 + 0.04, h0 - 2, h1 + 2)).fill(p.panel.frame);
  quad(g, rect(u0, u1, h0, h1)).fill(0x06101e);
  const ice = 0x9fd8ff;
  // Bars on the left, lines of readout on the right.
  const mid = u0 + (u1 - u0) * 0.45;
  for (let u = u0 + 0.06, i = 0; u < mid - 0.05; u += 0.09, i++) {
    const top = h0 + 3 + rand(`${seed}:bar:${i}`) * (h1 - h0 - 8);
    quad(g, rect(u, u + 0.05, h0 + 3, top)).fill({ color: i % 4 === 3 ? HAZARD : ice, alpha: 0.75 });
  }
  for (let h = h1 - 5, i = 0; h > h0 + 3; h -= 4, i++) {
    const w = 0.15 + rand(`${seed}:line:${i}`) * (u1 - mid - 0.25);
    quad(g, rect(mid + 0.06, mid + 0.06 + w, h - 1.2, h)).fill({ color: ice, alpha: 0.55 });
  }
}

/** A chrome post for the rope along the line, with a light on top. */
function chromePost(g: Graphics, p: Palette, x: number, y: number) {
  const c = iso(x, y);
  g.ellipse(c.x + 1, c.y + 1, 6, 3).fill({ color: p.shadow, alpha: 0.22 });
  g.ellipse(c.x, c.y - 1, 4.8, 2.4).fill(shade(p.brass, 0.3));
  g.rect(c.x - 1.1, c.y - POST_H, 2.2, POST_H - 1).fill(p.brass);
  g.rect(c.x - 1.1, c.y - POST_H, 0.7, POST_H - 1).fill(tint(p.brass, 0.4));
  g.circle(c.x, c.y - POST_H - 1, 2.2).fill(0x9fd8ff);
}

const art: Partial<ThemeArt> = {
  // Deck plates: each tile a plate with a bevel and four bolts; a light strip across every sixth row.
  floor(g, p, x, y, tile) {
    if (tile.kind !== 'open') return defaultArt.floor(g, p, x, y, tile);
    const h = fnv1a(`deck:${x},${y}`);
    diamond(g, x, y, x + 1, y + 1).fill(mix(p.corridor[0], p.corridor[1], (h % 100) / 100));
    diamond(g, x + 0.06, y + 0.06, x + 0.94, y + 0.94).stroke({ width: 0.8, color: p.seam, alpha: 0.7 });
    floorLine(g, x + 0.06, y + 0.06, x + 0.94, y + 0.06);
    floorLine(g, x + 0.06, y + 0.06, x + 0.06, y + 0.94);
    g.stroke({ width: 0.6, color: tint(p.corridor[0], 0.25), alpha: 0.5 });
    for (const [dx, dy] of [
      [0.16, 0.16],
      [0.84, 0.16],
      [0.84, 0.84],
      [0.16, 0.84],
    ] as const) {
      const c = iso(x + dx, y + dy);
      g.ellipse(c.x, c.y, 1.1, 0.6).fill(p.seam);
    }
    if (y % 6 === 3)
      floorLine(g, x, y + 0.5, x + 1, y + 0.5).stroke({
        width: 1.4,
        color: p.glow,
        alpha: p.theme === 'dark' ? 0.45 : 0.6,
      });
  },
  // A lit edge round each team's deck, in its colour.
  rug(g, p, area, c) {
    const edge = p.theme === 'dark' ? tint(c, 0.25) : shade(c, 0.25);
    diamond(g, area.x + 0.1, area.y + 0.1, area.x + area.w - 0.1, area.y + area.h - 0.1).stroke({
      width: 3,
      color: edge,
    });
    diamond(g, area.x + 0.2, area.y + 0.2, area.x + area.w - 0.2, area.y + area.h - 0.2).stroke({
      width: 1,
      color: p.glow,
      alpha: p.theme === 'dark' ? 0.5 : 0.8,
    });
  },
  // A lit walkway to your door: light strips down both sides, chevrons pointing the way.
  runner(g, p, r) {
    for (const x of [r.x + 0.1, r.x + r.w - 0.1]) floorLine(g, x, r.y + 0.04, x, r.y + r.h - 0.1);
    g.stroke({ width: 2, color: p.runner.border });
    const c = r.x + r.w / 2;
    for (let y = r.y + 0.6; y < r.y + r.h - 0.3; y += 1) {
      const pts = [iso(c - 0.24, y + 0.1), iso(c, y - 0.14), iso(c + 0.24, y + 0.1)];
      g.moveTo(pts[0]!.x, pts[0]!.y).lineTo(pts[1]!.x, pts[1]!.y).lineTo(pts[2]!.x, pts[2]!.y);
    }
    g.stroke({ width: 1.6, color: p.runner.pattern, alpha: 0.9, cap: 'round', join: 'round' });
  },
  // Hull panels: a seam every tile and two across, a light strip under the trim.
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    for (const [wall, len, color] of [
      ['A', layout.width, p.wallRight],
      ['B', layout.height, p.wallLeft],
    ] as const) {
      const rect = wall === 'A' ? rectA : rectB;
      quad(g, rect(0, len, 30, 33)).fill(shade(color, 0.08));
      for (let u = 1; u < len; u++) {
        const a = onWall(wall, u, 6);
        const b = onWall(wall, u, 80);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      for (const h of [30, 58]) {
        const a = onWall(wall, 0, h);
        const b = onWall(wall, len, h);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 0.8, color: shade(color, 0.3), alpha: 0.7 });
      quad(g, rect(0, len, 77.5, 79)).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.5 : 0.8 });
    }
  },
  // A viewport: thick hull frame, cut corners, bolts round it.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy - 0.05, gy + 1.85, 22, 74)).fill(p.window);
    const frame = p.windowFrame;
    for (const [a, b, h0, h1] of [
      [gy - 0.22, gy + 2.02, 16, 22],
      [gy - 0.22, gy + 2.02, 74, 80],
      [gy - 0.22, gy - 0.05, 16, 80],
      [gy + 1.85, gy + 2.02, 16, 80],
    ] as const)
      quad(drapes, rectB(a, b, h0, h1)).fill(frame);
    // Cut corners, so it reads as a port, not a pane.
    for (const [u, h, du, dh] of [
      [gy - 0.05, 22, 0.22, 8],
      [gy + 1.85, 22, -0.22, 8],
      [gy - 0.05, 74, 0.22, -8],
      [gy + 1.85, 74, -0.22, -8],
    ] as const)
      drapes
        .poly(
          flat(
            onWallPts('B', [
              [u, h],
              [u + du, h],
              [u, h + dh],
            ]),
          ),
        )
        .fill(frame);
    quad(drapes, rectB(gy + 0.89, gy + 0.91, 22, 74)).fill(shade(frame, 0.2));
    for (let u = gy - 0.12; u < gy + 2; u += 0.36)
      for (const h of [19, 77]) {
        const c = wallB(u, h);
        drapes.circle(c.x, c.y, 0.9).fill(tint(frame, 0.35));
      }
    const strip = rectB(gy - 0.22, gy + 2.02, 12, 13.5);
    quad(drapes, strip).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.55 : 0.8 });
  },
  view: spaceView,
  // An airlock: a heavy frame, hazard stripes over it, a grated mat.
  entrance(g, p, e) {
    quad(g, rectB(e + 0.04, e + 0.96, 0, 64)).fill(p.metal.right);
    quad(g, rectB(e + 0.14, e + 0.86, 0, 56)).fill(shade(p.wallLeft, 0.6));
    hazard(g, 'B', e + 0.04, e + 0.96, 57, 63);
    for (const u of [e + 0.14, e + 0.86]) {
      const a = wallB(u, 0);
      const b = wallB(u, 56);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 1.2, color: p.glow, alpha: 0.7 });
    diamond(g, 0.04, e + 0.15, 0.7, e + 0.85).fill({ color: HAZARD_DARK, alpha: 0.6 });
    diamond(g, 0.04, e + 0.15, 0.7, e + 0.85).stroke({ width: 1.2, color: HAZARD });
  },
  // A star chart: a dark screen, a grid, a star with its orbits and worlds, a constellation.
  feature(g, p, x0, x1) {
    quad(g, rectA(x0 - 0.08, x1 + 0.08, 20, 76)).fill(p.panel.frame);
    quad(g, rectA(x0, x1, 23, 73)).fill(0x06101e);
    const ice = 0x9fd8ff;
    for (let u = x0 + 0.5; u < x1; u += 0.5) {
      const a = wallA(u, 23);
      const b = wallA(u, 73);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (let h = 31; h < 73; h += 8) {
      const a = wallA(x0, h);
      const b = wallA(x1, h);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 0.6, color: ice, alpha: 0.14 });
    const mid = (x0 + x1) / 2 + 0.4;
    const R = ((x1 - x0) / 2 - 0.7) * ALONG;
    for (const [k, angle] of [
      [0.35, 0.8],
      [0.62, 2.6],
      [0.9, 4.4],
    ] as const) {
      g.poly(flat(wallEllipse('A', mid, 48, R * k, 20 * k, 40))).stroke({
        width: 0.8,
        color: ice,
        alpha: 0.4,
      });
      const c = wallA(mid + (Math.cos(angle) * R * k) / ALONG, 48 + Math.sin(angle) * 20 * k);
      g.circle(c.x, c.y, 2.2).fill(k > 0.8 ? HAZARD : ice);
    }
    const sun = wallA(mid, 48);
    glow(g, sun.x, sun.y, 12, 0xffe0a0, 0.6);
    g.circle(sun.x, sun.y, 2.6).fill(0xfff4d6);
    // A constellation in the top left.
    const stars: [number, number][] = [
      [x0 + 0.3, 66],
      [x0 + 0.55, 69],
      [x0 + 0.8, 64],
      [x0 + 1.05, 67],
      [x0 + 0.9, 58],
    ];
    const pts = onWallPts('A', stars);
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (const q of pts.slice(1, 4)) g.lineTo(q.x, q.y);
    g.moveTo(pts[2]!.x, pts[2]!.y).lineTo(pts[4]!.x, pts[4]!.y);
    g.stroke({ width: 0.7, color: ice, alpha: 0.5 });
    for (const q of pts) g.circle(q.x, q.y, 1.2).fill(0xffffff);
  },
  // The bridge: hull panels, consoles either side of your door, a hazard band at the base.
  suite(g, p, s) {
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 80)).fill(p.panel.face);
    for (let u = s.x0; u < s.x1; u += 0.5) {
      const a = wallA(u, 6);
      const b = wallA(u, 80);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 0.8, color: p.panel.shadow, alpha: 0.6 });
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 6)).fill(p.panel.shadow);
    for (const [a, b] of [
      [s.x0 + 0.15, s.door - 0.4],
      [s.door + 1.4, s.x1 - 0.2],
    ] as const) {
      if (b - a < 0.4) continue;
      screen(g, p, 'A', a, b, 38, 64, `suite:${a.toFixed(1)}`);
      quad(g, rectA(a - 0.05, b + 0.05, 26, 31)).fill(p.panel.frame);
    }
    quad(g, rectA(s.x0 - 0.2, s.x1, 77.5, 79)).fill({
      color: p.glow,
      alpha: p.theme === 'dark' ? 0.6 : 0.85,
    });
  },
  // A blast door: two heavy leaves that meet in a step, hazard stripes over it; open, they slide apart.
  door(g, p, q, open) {
    quad(g, rectA(q - 0.1, q + 1.1, 0, 72)).fill(p.doorFrame);
    hazard(g, 'A', q - 0.1, q + 1.1, 66, 72);
    if (open) {
      quad(g, rectA(q + 0.04, q + 0.96, 0, 64)).fill(0x0a1220);
      const c = wallA(q + 0.5, 30);
      g.ellipse(c.x, c.y, 20, 26).fill({ color: p.glow, alpha: 0.22 });
      quad(g, rectA(q + 0.2, q + 0.8, 0, 2)).fill({ color: p.glow, alpha: 0.7 });
      for (const [a, b] of [
        [q + 0.04, q + 0.12],
        [q + 0.88, q + 0.96],
      ] as const)
        quad(g, rectA(a, b, 0, 64)).fill(p.door);
      return;
    }
    const step: [number, number][] = [
      [q + 0.5, 0],
      [q + 0.5, 26],
      [q + 0.42, 34],
      [q + 0.42, 64],
    ];
    g.poly(flat(onWallPts('A', [[q + 0.04, 0], ...step, [q + 0.04, 64]]))).fill(p.door);
    g.poly(flat(onWallPts('A', [...step, [q + 0.96, 64], [q + 0.96, 0]]))).fill(shade(p.door, 0.08));
    const seam = onWallPts('A', step);
    g.moveTo(seam[0]!.x, seam[0]!.y);
    for (const s of seam.slice(1)) g.lineTo(s.x, s.y);
    g.stroke({ width: 1.4, color: shade(p.door, 0.45) });
    for (const [a, b] of [
      [q + 0.1, q + 0.34],
      [q + 0.6, q + 0.9],
    ] as const)
      quad(g, rectA(a, b, 8, 20)).stroke({ width: 1, color: shade(p.door, 0.3) });
    quad(g, rectA(q + 0.04, q + 0.96, 62, 64)).fill({ color: p.glow, alpha: 0.8 });
  },
  // Indicator lights under the consoles and along the airlock, blinking now and then.
  extras(_g, p, layout, make) {
    const lights: [number, number][] = [];
    const s = { x0: layout.suite.x, x1: layout.width, door: layout.door.x };
    for (const [a, b] of [
      [s.x0 + 0.15, s.door - 0.4],
      [s.door + 1.4, s.x1 - 0.2],
    ] as const)
      for (let u = a + 0.1; u < b - 0.05; u += 0.12) lights.push([u, 28.5]);
    const span = featureSpan(layout);
    if (span) for (let u = span.x0 + 0.2; u < span.x1 - 0.1; u += 0.25) lights.push([u, 17]);
    const leds = make();
    const colours = [0x9fd8ff, HAZARD, 0xffffff];
    const motion: Motion = {
      g: leds,
      draw(t) {
        leds.clear();
        const beat = Math.floor(t / 500);
        lights.forEach(([u, h], i) => {
          const on = t ? fnv1a(`led:${i}:${beat}`) % 3 !== 0 : i % 3 !== 0;
          const c = wallA(u, h);
          const color = colours[i % 3]!;
          leds.circle(c.x, c.y, 1.1).fill({ color: on ? color : shade(color, 0.6), alpha: on ? 1 : 0.5 });
          if (on && p.theme === 'dark') leds.circle(c.x, c.y, 2.6).fill({ color, alpha: 0.2 });
        });
      },
    };
    return [motion];
  },
  // A pane of light glass: tinted, a rail along its top, a glowing strip at its foot.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    quad(g, [a, b, { x: b.x, y: b.y - GLASS_H }, { x: a.x, y: a.y - GLASS_H }]).fill({
      color: p.glass.pane,
      alpha: p.theme === 'dark' ? 0.14 : 0.24,
    });
    g.moveTo(a.x, a.y - GLASS_H)
      .lineTo(b.x, b.y - GLASS_H)
      .stroke({ width: 2.4, color: p.glass.rail });
    g.moveTo(a.x, a.y - 1)
      .lineTo(b.x, b.y - 1)
      .stroke({ width: 1.4, color: p.glow, alpha: p.theme === 'dark' ? 0.6 : 0.9 });
    g.rect(a.x - 1.2, a.y - GLASS_H, 2.4, GLASS_H).fill(p.glass.rail);
  },
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) {
      g.rect(q.x - 2, q.y - GLASS_H - 12, 4, GLASS_H + 12).fill(p.glass.rail);
      g.rect(q.x - 0.5, q.y - GLASS_H - 8, 1, GLASS_H + 4).fill({ color: p.glow, alpha: 0.8 });
    }
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 3.4, color: p.glass.rail });
  },
  rope: ropeWith(chromePost, 2.2),
  // A hydroponic pod: a lit glass drum on a base, greens growing inside.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    box(g, x + 0.26, y + 0.26, x + 0.74, y + 0.74, 6, p.metal);
    const greens: [number, number, number, boolean][] = [
      [-5, -14, 5, false],
      [5, -15, 5, false],
      [0, -20, 6, true],
      [-3, -26, 4.5, false],
      [4, -25, 4, true],
    ];
    for (const [dx, dy, r, light] of greens)
      g.circle(c.x + dx, c.y + dy, r).fill(light ? p.plant.leafLight : p.plant.leaf);
    g.roundRect(c.x - 11, c.y - 32, 22, 26, 3).fill({
      color: p.glass.pane,
      alpha: p.theme === 'dark' ? 0.16 : 0.22,
    });
    g.roundRect(c.x - 11, c.y - 32, 22, 26, 3).stroke({ width: 1, color: p.glass.rail, alpha: 0.8 });
    g.moveTo(c.x - 7, c.y - 29)
      .lineTo(c.x - 7, c.y - 12)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    box(g, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 3, faces(p.metal.left), 32);
    glow(g, c.x, c.y - 30, 10, p.glow, p.theme === 'dark' ? 0.35 : 0.2);
  },
  // A holo projector on a side table: a cone of light and a turning world in wireframe.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    box(g, f.x + 0.22, f.y + 0.22, f.x + 0.78, f.y + 0.78, 3, p.metal, 15);
    box(g, f.x + 0.46, f.y + 0.46, f.x + 0.54, f.y + 0.54, 15, p.metal);
    box(g, f.x + 0.38, f.y + 0.38, f.x + 0.62, f.y + 0.62, 2.5, faces(0x2a2f37), 18);
    const ice = p.theme === 'dark' ? 0x9fd8ff : 0x4aa8e8;
    g.poly([c.x - 3, c.y - 21, c.x + 3, c.y - 21, c.x + 11, c.y - 36, c.x - 11, c.y - 36]).fill({
      color: ice,
      alpha: 0.16,
    });
    const o = { x: c.x, y: c.y - 40 };
    glow(g, o.x, o.y, 16, ice, p.theme === 'dark' ? 0.25 : 0.12);
    g.circle(o.x, o.y, 7).stroke({ width: 1, color: ice, alpha: 0.9 });
    g.ellipse(o.x, o.y, 7, 2.4).stroke({ width: 0.8, color: ice, alpha: 0.8 });
    g.ellipse(o.x, o.y, 2.8, 7).stroke({ width: 0.8, color: ice, alpha: 0.8 });
  },
  // A console desk: today's desk, with a lit strip along its front.
  desk(g, p, f, x, y, monitor) {
    defaultArt.desk(g, p, f, x, y, monitor);
    const a = iso(x + 0.14, y + 0.92);
    const b = iso(x + 0.86, y + 0.92);
    g.poly([a.x, a.y - 10, b.x, b.y - 10, b.x, b.y - 11.6, a.x, a.y - 11.6]).fill({
      color: p.screen,
      alpha: p.theme === 'dark' ? 0.85 : 1,
    });
  },
};

export const starship: OfficeTheme = {
  id: 'starship',
  name: 'Starship',
  blurb: 'Deck plates, consoles and stars',
  thumb: { floor: 'plates', accent: { dark: 0x9fd8ff, light: 0x4aa8e8 } },
  art,
  colours: {
    dark: {
      corridor: [0x2c3138, 0x2f343b],
      seam: 0x16191e,
      pantry: [0x283238, 0x2b363c],
      lounge: [0x1d2433, 0x1b2230],
      kitchen: {
        floor: [0x3a3e44, 0x2c3036],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x343a42,
        grout: 0x464d57,
        block: 0x5a626e,
        cabinet: { left: 0x2f353e, right: 0x272c34 },
        copper: 0xb5683f,
      },
      carpets: [
        [0x23344a, 0x25374d],
        [0x263a2e, 0x293d31],
        [0x40282e, 0x432b31],
        [0x342a44, 0x372d47],
        [0x3d3624, 0x403927],
        [0x203a3c, 0x233d3f],
      ],
      wallLeft: 0x262b33,
      wallRight: 0x2c323b,
      wallTop: 0x3a414c,
      trim: 0x4a525e,
      baseboard: 0x1c2026,
      window: SPACE,
      windowFrame: 0x4a525e,
      glass: { pane: 0x9fd0ff, rail: 0x6a7480 },
      curtain: 0x3a414c,
      wood: { top: 0x5a626e, left: 0x434a55, right: 0x363c45 },
      metal: { top: 0x6a727e, left: 0x4f5661, right: 0x40464f },
      monitor: 0x0d1014,
      screen: 0x7cc8ff,
      chair: 0x3a414c,
      plant: { pot: 0x8a929e, leaf: 0x3f9a6a, leafLight: 0x6cc48e },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x3b4452, back: 0x2f3744 },
      felt: 0x1f4a6a,
      door: 0x5a636f,
      doorFrame: 0x2a2f37,
      brass: 0xaab3be,
      sign: 0x0f1218,
      signText: 0xcfeaff,
      panel: { face: 0x2c323b, frame: 0x4a525e, shadow: 0x1c2026 },
      rope: HAZARD,
      runner: { base: 0x1a1e24, border: 0x9fd8ff, pattern: 0x9fd8ff },
      glow: 0xbfe4ff,
      map: { paper: 0x0b1424, land: 0x5aa8e0, frame: 0x4a525e },
      board: { frame: 0x4a525e },
      books: [0x3a7fc4, HAZARD, 0x5a636f, 0x9fd0ff, 0x8a5ac4, 0x3f9a6a],
      shadow: 0x000000,
    },
    light: {
      corridor: [0xd4d9df, 0xd0d5db],
      seam: 0xa9b1bb,
      pantry: [0xe4e8ec, 0xdde2e7],
      lounge: [0x1d2433, 0x1b2230],
      kitchen: {
        floor: [0xe8ebee, 0xc4cad1],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xf4f6f8,
        grout: 0xd4d9df,
        block: 0xc9d0d8,
        cabinet: { left: 0xc9d0d8, right: 0xb4bcc6 },
        copper: 0xc0703f,
      },
      carpets: [
        [0xcfe0f2, 0xc9dbee],
        [0xd2ead9, 0xcce4d3],
        [0xf0d6d6, 0xead0d0],
        [0xdcd4f0, 0xd6ceea],
        [0xf2e6c4, 0xece0be],
        [0xc9e8e8, 0xc3e2e2],
      ],
      wallLeft: 0xdfe4ea,
      wallRight: 0xeef1f5,
      wallTop: 0xffffff,
      trim: 0xc4ccd6,
      baseboard: 0x9aa4b0,
      window: SPACE,
      windowFrame: 0x7a8592,
      glass: { pane: 0x9fd0ff, rail: 0xa9b3bf },
      curtain: 0xc4ccd6,
      wood: { top: 0xe6eaef, left: 0xc9d0d8, right: 0xb4bcc6 },
      metal: { top: 0xb7bcc5, left: 0x9ea4ae, right: 0x8a909a },
      monitor: 0x1f242b,
      screen: 0x4aa8e8,
      chair: 0xd5dbe2,
      plant: { pot: 0xeef1f5, leaf: 0x3f9a6a, leafLight: 0x6cc48e },
      fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
      sofa: { seat: 0x8f9cb0, back: 0x7b889c },
      felt: 0x2a6a9a,
      door: 0xc9d0d8,
      doorFrame: 0x5a636f,
      brass: 0x9aa3ae,
      sign: 0x1f242b,
      signText: 0xe8f4ff,
      panel: { face: 0xdfe4ea, frame: 0x8a939e, shadow: 0xa9b1bb },
      rope: HAZARD,
      runner: { base: 0x2a3038, border: 0x6fc0ff, pattern: 0x6fc0ff },
      glow: 0x7cc4f5,
      map: { paper: 0x0b1424, land: 0x5aa8e0, frame: 0xa9b1bb },
      board: { frame: 0xa9b1bb },
      books: [0x3a7fc4, HAZARD, 0x5a636f, 0x9fd0ff, 0x8a5ac4, 0x3f9a6a],
      shadow: 0x2a2d35,
    },
  },
};
