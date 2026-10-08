import type { Graphics } from 'pixi.js';
import { fnv1a } from '@aoe-supercharge/core/shared';
import { bookcase, defaultArt, featureSpan, GLASS_H } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB } from '../iso';
import type { Palette } from '../palette';
import { ALONG, courses, faces, floorLine, glow, rectA, rectB, wallEllipse } from './kit';
import type { OfficeTheme, ThemeArt } from './types';

/**
 * Foundry: a converted factory loft. Exposed brick and a steel beam, a poured concrete floor with saw
 * cuts, steel factory windows, a duct along the left wall, Edison bulbs, and a riveted sliding door.
 */

/** Mortar: a pale grout by day, a dark one at night. */
const mortar = (p: Palette, wall: number) => mix(wall, p.theme === 'dark' ? 0x0b0908 : 0xe3d9cc, 0.5);

/** An Edison bulb: amber glass, a glowing filament, and its light. */
function bulb(g: Graphics, p: Palette, x: number, y: number, size = 1) {
  glow(g, x, y, 22 * size, p.glow, p.theme === 'dark' ? 0.32 : 0.16);
  g.ellipse(x, y, 3.2 * size, 4 * size).fill(mix(p.glow, 0xffffff, 0.25));
  g.moveTo(x - 1.4 * size, y + 0.6 * size)
    .lineTo(x, y - 1.6 * size)
    .lineTo(x + 1.4 * size, y + 0.6 * size)
    .stroke({ width: 0.7, color: 0xfff1c9 });
  g.rect(x - 1.6 * size, y - 6.4 * size, 3.2 * size, 2.6 * size).fill(p.brass);
}

/** A caged bulb on a wall bracket. */
function cageLamp(g: Graphics, p: Palette, wall: 'A' | 'B', u: number, h: number) {
  const at = wall === 'A' ? wallA(u, h) : wallB(u, h);
  g.rect(at.x - 1, at.y + 2, 2, 7).fill(p.metal.right);
  bulb(g, p, at.x, at.y - 2);
  // The cage: a few wire hoops round the bulb.
  g.ellipse(at.x, at.y - 2, 5, 6.5).stroke({ width: 0.8, color: shade(p.metal.right, 0.3) });
  g.moveTo(at.x, at.y - 8.5)
    .lineTo(at.x, at.y + 4.5)
    .stroke({ width: 0.8, color: shade(p.metal.right, 0.3) });
}

/** Rivets along a line on wall A, every `step` tiles. */
function rivetsA(g: Graphics, color: number, x0: number, x1: number, h: number, step = 0.25) {
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    const c = wallA(x, h);
    g.circle(c.x, c.y, 0.9).fill(color);
  }
}

const art: Partial<ThemeArt> = {
  // Poured concrete: slabs mottled tile by tile, saw cuts every two tiles, and the odd stain.
  floor(g, p, x, y, tile) {
    if (tile.kind !== 'open') return defaultArt.floor(g, p, x, y, tile);
    const h = fnv1a(`concrete:${x},${y}`);
    diamond(g, x, y, x + 1, y + 1).fill(mix(p.corridor[0], p.corridor[1], (h % 100) / 100));
    if ((h >> 8) % 9 === 0) {
      const c = iso(x + 0.3 + ((h >> 12) % 40) / 100, y + 0.3 + ((h >> 16) % 40) / 100);
      g.ellipse(c.x, c.y, 9 + ((h >> 20) % 8), 4.5).fill({ color: p.seam, alpha: 0.18 });
    }
    if (x % 2 === 0) floorLine(g, x, y, x, y + 1).stroke({ width: 0.9, color: p.seam, alpha: 0.7 });
    if (y % 2 === 0) floorLine(g, x, y, x + 1, y).stroke({ width: 0.9, color: p.seam, alpha: 0.7 });
  },
  // A ribbed rubber mat to your door.
  runner(g, p, r) {
    diamond(g, r.x + 0.1, r.y + 0.04, r.x + r.w - 0.1, r.y + r.h - 0.1).stroke({
      width: 2,
      color: p.runner.border,
    });
    for (let y = r.y + 0.2; y < r.y + r.h - 0.15; y += 0.2)
      floorLine(g, r.x + 0.2, y, r.x + r.w - 0.2, y).stroke({
        width: 1.2,
        color: p.runner.pattern,
        alpha: 0.9,
      });
  },
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    const W = layout.width;
    const H = layout.height;
    for (const [wall, length, color] of [
      ['A', W, p.wallRight],
      ['B', H, p.wallLeft],
    ] as const)
      courses(g, wall, length, {
        h0: 6,
        h1: 76,
        course: 5,
        block: 0.42,
        mortar: mortar(p, color),
        alpha: 0.75,
        odd: [shade(color, 0.14), tint(color, 0.07), mix(color, 0x3a1a10, 0.25)],
        seed: 'foundry',
      });
    // A steel I-beam along the top of both walls: flanges, a web, rivets.
    for (const [rect, wall] of [
      [rectA(0, W, 76, 84), 'A'],
      [rectB(0, H, 76, 84), 'B'],
    ] as const) {
      quad(g, rect).fill(p.trim);
      const len = wall === 'A' ? W : H;
      const at = wall === 'A' ? wallA : wallB;
      for (const h of [76.6, 83.4]) {
        const a = at(0, h);
        const b = at(len, h);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 1.4, color: tint(p.trim, 0.18) });
    }
    rivetsA(g, tint(p.trim, 0.3), 0.2, W - 0.2, 80, 0.5);
  },
  // Steel factory windows: a deep reveal, a concrete sill, and a grid of small panes.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy - 0.1, gy + 1.9, 25, 74)).fill(shade(p.wallLeft, 0.35));
    quad(g, rectB(gy, gy + 1.8, 28, 70)).fill(p.window);
    quad(drapes, rectB(gy - 0.16, gy + 1.96, 22.5, 26)).fill(p.corridor[1]);
    const frame = shade(p.windowFrame, 0.1);
    quad(drapes, rectB(gy, gy + 1.8, 28, 70)).stroke({ width: 3, color: frame });
    for (const u of [0.45, 0.9, 1.35]) {
      const a = wallB(gy + u, 28);
      const b = wallB(gy + u, 70);
      drapes.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (const h of [42, 56]) {
      const a = wallB(gy, h);
      const b = wallB(gy + 1.8, h);
      drapes.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    drapes.stroke({ width: 1.6, color: frame });
    // One pane tilted open.
    quad(drapes, rectB(gy + 0.92, gy + 1.33, 57, 69)).fill({ color: tint(p.window, 0.25), alpha: 0.5 });
  },
  entrance(g, p, e) {
    defaultArt.entrance(g, p, e);
    // A yellow and black kerb either side.
    for (const u of [e + 0.06, e + 0.86]) {
      for (let h = 0; h < 60; h += 8) quad(g, rectB(u, u + 0.08, h, h + 4)).fill(0xe0a526);
    }
  },
  // A big factory clock between two blueprints.
  feature(g, p, x0, x1) {
    const mid = (x0 + x1) / 2;
    for (const [a, b] of [
      [x0, x0 + 1.5],
      [x1 - 1.5, x1],
    ] as const) {
      quad(g, rectA(a - 0.05, b + 0.05, 28, 68)).fill(p.trim);
      quad(g, rectA(a, b, 30, 66)).fill(0x2a5585);
      for (let u = a + 0.25; u < b; u += 0.25) {
        const c = wallA(u, 30);
        const d = wallA(u, 66);
        g.moveTo(c.x, c.y).lineTo(d.x, d.y);
      }
      for (let h = 36; h < 66; h += 6) {
        const c = wallA(a, h);
        const d = wallA(b, h);
        g.moveTo(c.x, c.y).lineTo(d.x, d.y);
      }
      g.stroke({ width: 0.5, color: 0xdbe7f3, alpha: 0.3 });
      // A gear and a shaft, drawn in white.
      quad(g, wallEllipse('A', a + 0.55, 50, 9)).stroke({ width: 1, color: 0xeaf2fa, alpha: 0.85 });
      quad(g, wallEllipse('A', a + 0.55, 50, 3.5)).stroke({ width: 0.8, color: 0xeaf2fa, alpha: 0.85 });
      quad(g, rectA(a + 0.85, b - 0.15, 48.5, 51.5)).stroke({ width: 0.8, color: 0xeaf2fa, alpha: 0.85 });
    }
    // The clock: a steel rim, a cream face, ticks and hands at ten past ten.
    const h = 50;
    quad(g, wallEllipse('A', mid, h, 21, 21, 40)).fill(shade(p.trim, 0.2));
    quad(g, wallEllipse('A', mid, h, 18, 18, 40)).fill(0xf1ead8);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const r0 = k % 3 ? 14.5 : 12.5;
      const c = wallA(mid + (Math.cos(a) * r0) / ALONG, h + Math.sin(a) * r0);
      const d = wallA(mid + (Math.cos(a) * 16.5) / ALONG, h + Math.sin(a) * 16.5);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    g.stroke({ width: 1.1, color: 0x22201c });
    const hand = (angle: number, len: number, width: number) => {
      const c = wallA(mid, h);
      const d = wallA(mid + (Math.cos(angle) * len) / ALONG, h + Math.sin(angle) * len);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ width, color: 0x22201c, cap: 'round' });
    };
    hand(Math.PI * (5 / 6), 9, 2);
    hand(Math.PI / 6, 13, 1.4);
    const c = wallA(mid, h);
    g.circle(c.x, c.y, 1.6).fill(0xb3392f);
  },
  // Your corner: riveted steel plates, steel shelving with binders, caged bulbs.
  suite(g, p, s) {
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 76)).fill(p.panel.face);
    for (let x = s.x0; x <= s.x1; x += 1) {
      const a = wallA(x - 0.2, 0);
      const b = wallA(x - 0.2, 76);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    const a = wallA(s.x0 - 0.2, 38);
    const b = wallA(s.x1, 38);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.2, color: p.panel.frame });
    for (const h of [4, 34, 42, 72]) rivetsA(g, tint(p.panel.frame, 0.25), s.x0 - 0.1, s.x1 - 0.1, h, 0.34);
    bookcase(g, p, s.x0, s.door - 0.3, 36, 76, 'left');
    bookcase(g, p, s.door + 1.3, s.x1 - 0.15, 36, 76, 'right');
    cageLamp(g, p, 'A', s.door - 0.18, 52);
    cageLamp(g, p, 'A', s.door + 1.18, 52);
  },
  // A riveted steel door that slides on a track.
  door(g, p, q, open) {
    const steel = p.door;
    quad(g, rectA(q - 0.06, q + 1.06, 0, 68)).fill(p.doorFrame);
    if (open) {
      quad(g, rectA(q + 0.04, q + 0.96, 0, 66)).fill(shade(p.panel.shadow, 0.3));
      const c = wallA(q + 0.5, 30);
      g.ellipse(c.x, c.y, 18, 24).fill({ color: p.glow, alpha: 0.22 });
    }
    const x0 = open ? q + 1.0 : q + 0.02;
    const x1 = x0 + 0.96;
    quad(g, rectA(x0, x1, 0, 66)).fill(steel);
    for (const [h0, h1] of [
      [18, 22],
      [44, 48],
    ] as const)
      quad(g, rectA(x0, x1, h0, h1)).fill(shade(steel, 0.25));
    const d0 = wallA(x0 + 0.05, 22);
    const d1 = wallA(x1 - 0.05, 44);
    g.moveTo(d0.x, d0.y)
      .lineTo(d1.x, d1.y)
      .stroke({ width: 3, color: shade(steel, 0.2) });
    for (const h of [3, 20, 46, 63]) rivetsA(g, tint(steel, 0.35), x0 + 0.06, x1 - 0.06, h, 0.15);
    quad(g, rectA(x0 + 0.1, x0 + 0.14, 26, 42)).fill(tint(steel, 0.3));
    // The track and its rollers.
    quad(g, rectA(q - 0.2, q + 2.05, 68, 72)).fill(shade(p.metal.right, 0.2));
    for (const u of [x0 + 0.15, x1 - 0.15]) {
      const c = wallA(u, 70);
      g.circle(c.x, c.y, 2.4).fill(p.metal.top);
    }
  },
  // A duct along the left wall, and bulbs hanging off the beam where the back wall is bare.
  extras(g, p, layout) {
    const H = layout.height;
    quad(g, rectB(0.2, H - 0.2, 64, 74)).fill(p.metal.left);
    quad(g, rectB(0.2, H - 0.2, 70, 73)).fill({ color: tint(p.metal.top, 0.2), alpha: 0.8 });
    quad(g, rectB(0.2, H - 0.2, 64, 66)).fill({ color: shade(p.metal.right, 0.2), alpha: 0.8 });
    for (let y = 1; y < H - 0.5; y += 1.6) {
      quad(g, rectB(y, y + 0.06, 63, 75)).fill(shade(p.metal.right, 0.15));
      quad(g, rectB(y + 0.02, y + 0.04, 75, 76)).fill(p.trim);
    }
    const span = featureSpan(layout);
    const ka = layout.kitchen.area;
    const spots: number[] = [];
    if (span) {
      if (span.x0 - (ka.x + ka.w) >= 1.4) spots.push((ka.x + ka.w + span.x0) / 2);
      if (layout.board.x0 - span.x1 >= 1.4) spots.push((span.x1 + layout.board.x0) / 2);
    }
    for (const x of spots) {
      const top = wallA(x, 76);
      const end = wallA(x, 62);
      g.moveTo(top.x, top.y).lineTo(end.x, end.y).stroke({ width: 0.8, color: 0x1b1c1e });
      bulb(g, p, end.x, end.y + 6, 1.1);
    }
  },
  // Black steel frames with wired glass.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    quad(g, [a, b, { x: b.x, y: b.y - GLASS_H }, { x: a.x, y: a.y - GLASS_H }]).fill({
      color: p.glass.pane,
      alpha: p.theme === 'dark' ? 0.14 : 0.2,
    });
    const at = (t: number, h: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - h });
    for (const h of [GLASS_H, GLASS_H / 2, 0.5]) {
      const c = at(0, h);
      const d = at(1, h);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    g.stroke({ width: 2, color: p.glass.rail });
    for (const t of [0, 0.5]) g.rect(at(t, 0).x - 1.1, at(t, 0).y - GLASS_H, 2.2, GLASS_H).fill(p.glass.rail);
    const m = at(0.2, 6);
    const n = at(0.32, GLASS_H - 6);
    g.moveTo(m.x, m.y)
      .lineTo(n.x, n.y)
      .stroke({ width: 1, color: 0xffffff, alpha: p.theme === 'dark' ? 0.14 : 0.35 });
  },
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) g.rect(q.x - 2, q.y - GLASS_H - 12, 4, GLASS_H + 12).fill(p.glass.rail);
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 5, color: p.glass.rail });
    g.moveTo(a.x, a.y - GLASS_H - 14)
      .lineTo(b.x, b.y - GLASS_H - 14)
      .stroke({ width: 1, color: tint(p.glass.rail, 0.25) });
  },
  // A snake plant in a galvanised bucket.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    box(g, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 14, faces(p.plant.pot, 0.25, 0.25));
    for (const h of [4, 10]) {
      const l = iso(x + 0.3, y + 0.7);
      const r = iso(x + 0.7, y + 0.7);
      const k = iso(x + 0.7, y + 0.3);
      g.moveTo(l.x, l.y - h)
        .lineTo(r.x, r.y - h)
        .lineTo(k.x, k.y - h);
    }
    g.stroke({ width: 0.8, color: shade(p.plant.pot, 0.3) });
    const leaves: [number, number, number, boolean][] = [
      [-7, 30, -3, false],
      [-3, 42, -1, true],
      [2, 46, 1, false],
      [6, 36, 3, true],
      [9, 28, 5, false],
      [-1, 34, 0, false],
    ];
    for (const [dx, tall, lean, light] of leaves) {
      const bx = c.x + dx;
      const by = c.y - 13;
      g.poly([bx - 2.6, by, bx + 2.6, by, bx + lean + 0.6, by - tall, bx + lean - 0.6, by - tall]).fill(
        light ? p.plant.leafLight : p.plant.leaf,
      );
      g.moveTo(bx, by - 2)
        .lineTo(bx + lean * 0.9, by - tall + 4)
        .stroke({ width: 0.6, color: mix(p.plant.leafLight, 0xf1e9a0, 0.4), alpha: 0.7 });
    }
  },
  // A steel side table with a pipe lamp and a bare bulb.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y + 1, 22, 10).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.1 : 0.05 });
    box(g, f.x + 0.2, f.y + 0.2, f.x + 0.8, f.y + 0.8, 3, p.wood, 15);
    for (const [u, v] of [
      [0.24, 0.76],
      [0.72, 0.76],
      [0.72, 0.24],
    ] as const)
      box(g, f.x + u, f.y + v - 0.04, f.x + u + 0.04, f.y + v, 15, p.metal);
    const base = { x: c.x + 2, y: c.y - 18 };
    g.moveTo(base.x, base.y)
      .lineTo(base.x, base.y - 20)
      .lineTo(base.x - 8, base.y - 24)
      .stroke({ width: 2.2, color: shade(p.metal.right, 0.25), join: 'round' });
    bulb(g, p, base.x - 8, base.y - 18, 1.15);
  },
};

export const foundry: OfficeTheme = {
  id: 'foundry',
  name: 'Foundry',
  blurb: 'Brick, steel and concrete',
  thumb: { floor: 'slabs', accent: { dark: 0x2a5585, light: 0x2a5585 } },
  art,
  colours: {
    dark: {
      corridor: [0x3a3b3c, 0x414243],
      seam: 0x232425,
      pantry: [0x3d332b, 0x382f28],
      lounge: [0x3a2427, 0x362125],
      kitchen: {
        floor: [0x34383c, 0x26292c],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x2e3336,
        grout: 0x3b4044,
        block: 0x8a6a48,
        cabinet: { left: 0x2b2f33, right: 0x22262a },
        copper: 0xb5683f,
      },
      carpets: [
        [0x2a3138, 0x2d353c],
        [0x2c3329, 0x30372c],
        [0x3a2a24, 0x3e2d27],
        [0x2f2a36, 0x332d3a],
        [0x3a3222, 0x3e3625],
        [0x23312f, 0x263533],
      ],
      wallLeft: 0x4f2c22,
      wallRight: 0x5a3327,
      wallTop: 0x2f3134,
      trim: 0x2b2d30,
      baseboard: 0x1e1f21,
      window: 0x1b2633,
      windowFrame: 0x1c1d1f,
      glass: { pane: 0x8fb0c4, rail: 0x1f2124 },
      curtain: 0x3a3c3f,
      wood: { top: 0x7a5a3e, left: 0x5f4530, right: 0x4e3826 },
      metal: { top: 0x4a4e54, left: 0x383b40, right: 0x2c2f33 },
      monitor: 0x141517,
      screen: 0x3d7fc4,
      chair: 0x2b2622,
      plant: { pot: 0x6f777e, leaf: 0x3b7a4c, leafLight: 0x56a067 },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x7a4a2c, back: 0x63391f },
      felt: 0x2f6f4a,
      door: 0x41464b,
      doorFrame: 0x1f2124,
      brass: 0xb9824a,
      sign: 0x1b1c1e,
      signText: 0xe8dcc0,
      panel: { face: 0x2c2f33, frame: 0x3a3e43, shadow: 0x1a1c1f },
      rope: 0x8a6a42,
      runner: { base: 0x232527, border: 0x3a3d41, pattern: 0x303336 },
      glow: 0xffb24d,
      map: { paper: 0xd9cdb5, land: 0x7a5a3e, frame: 0x2b2d30 },
      board: { frame: 0x2b2d30 },
      books: [0x6b3b22, 0x2f4a5c, 0x8c6a28, 0x4a4e54, 0x7a2b22, 0x3a5a3a],
      shadow: 0x000000,
    },
    light: {
      corridor: [0xbab7b1, 0xb1aea7],
      seam: 0x8f8c85,
      pantry: [0xcdb08a, 0xc5a882],
      lounge: [0xd2a596, 0xcc9f90],
      kitchen: {
        floor: [0xdedad2, 0xa3a8ad],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xeceae6,
        grout: 0xcfccc6,
        block: 0xc28d5c,
        cabinet: { left: 0x3a3d41, right: 0x2e3135 },
        copper: 0xc0703f,
      },
      carpets: [
        [0xd8d2c4, 0xd2ccbd],
        [0xc9cfbf, 0xc3c9b8],
        [0xd9c2ae, 0xd3bca8],
        [0xc8cfd6, 0xc2c9d0],
        [0xd8c8c0, 0xd2c2ba],
        [0xcfccc2, 0xc9c6bc],
      ],
      wallLeft: 0x9a4f3c,
      wallRight: 0xa85a44,
      wallTop: 0x4a4d52,
      trim: 0x3a3d41,
      baseboard: 0x2b2d30,
      window: 0xcfe3ef,
      windowFrame: 0x26282b,
      glass: { pane: 0xa9c8d8, rail: 0x2b2d30 },
      curtain: 0x8a8e93,
      wood: { top: 0xa8825a, left: 0x8c6a48, right: 0x765a3c },
      metal: { top: 0x9ca2a9, left: 0x868c93, right: 0x737980 },
      monitor: 0x2b2e35,
      screen: 0x8fc4f5,
      chair: 0x3a2e26,
      plant: { pot: 0x9aa2a8, leaf: 0x3f9a5c, leafLight: 0x62bb7c },
      fridge: { top: 0xe4e6e8, left: 0xcfd2d6, right: 0xbcc0c5 },
      sofa: { seat: 0x8a5634, back: 0x74462a },
      felt: 0x3f8f5f,
      door: 0x4a4e53,
      doorFrame: 0x2b2d30,
      brass: 0xb9824a,
      sign: 0x26282b,
      signText: 0xf1e6c8,
      panel: { face: 0x3a3d41, frame: 0x4c5056, shadow: 0x2b2d30 },
      rope: 0x9a7a4e,
      runner: { base: 0x26282b, border: 0x4c5056, pattern: 0x3a3d41 },
      glow: 0xffc06a,
      map: { paper: 0xe9dfca, land: 0x8c6a48, frame: 0x2b2d30 },
      board: { frame: 0x3a3d41 },
      books: [0x6b3b22, 0x2f4a5c, 0x8c6a28, 0x4a4e54, 0x7a2b22, 0x3a5a3a],
      shadow: 0x2a2d35,
    },
  },
};
