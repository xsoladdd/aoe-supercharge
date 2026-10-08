import type { Graphics } from 'pixi.js';
import { fnv1a, type WindowLook } from '@aoe-supercharge/core/shared';
import { defaultArt, GLASS_H, POST_H, ropeWith, skyColour, weather } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB } from '../iso';
import type { Palette } from '../palette';
import { faces, floorLine, glow, onWall, rand, rectA, rectB } from './kit';
import type { OfficeTheme, ThemeArt } from './types';

/**
 * Fjord: Nordic and plain. Wide pale birch, white board walls, big black-framed windows onto a fjord
 * (with the northern lights after dark), birch slat screens round the rooms, a woven wall hanging,
 * olive trees in white pots, and a pendant lamp.
 */

/** The landscape's height `u` tiles along the left wall: one range across all the windows. */
const ridge = (u: number, k: number) =>
  Math.sin(u * 1.7 + k) * 6 + Math.sin(u * 4.3 + k * 2) * 3 + Math.sin(u * 0.6 + k * 3) * 5;

/** The fjord out of a window: sky, mountains with snow, the water, a red cabin now and then; aurora by night. */
function fjordView(g: Graphics, p: Palette, gy: number, look: WindowLook) {
  const u0 = gy - 0.1;
  const u1 = gy + 1.9;
  const sky = skyColour(p, look);
  const night = p.theme === 'dark' || look.sky < 0.45;
  quad(g, rectB(u0, u1, 16, 76)).fill(sky);
  quad(g, rectB(u0, u1, 34, 50)).fill({ color: night ? 0x1f5a6a : 0xffffff, alpha: night ? 0.18 : 0.22 });
  if (night) {
    for (let i = 0; i < 14; i++) {
      const r = rand(`star:${gy}:${i}`);
      const c = wallB(u0 + r * 2, 54 + rand(`star-h:${gy}:${i}`) * 20);
      g.circle(c.x, c.y, r > 0.8 ? 1 : 0.6).fill({ color: 0xffffff, alpha: 0.8 });
    }
    // The northern lights: two soft curtains.
    for (const [base, color, alpha] of [
      [56, 0x5af2a0, 0.32],
      [62, 0x42d6c8, 0.22],
    ] as const) {
      const top: { x: number; y: number }[] = [];
      const bottom: { x: number; y: number }[] = [];
      for (let u = u0; u <= u1 + 0.01; u += 0.1) {
        const w = Math.sin(u * 3.1 + base) * 4;
        top.push(wallB(u, base + 12 + w));
        bottom.push(wallB(u, base + w * 0.5));
      }
      g.poly([...top, ...bottom.reverse()].flatMap((q) => [q.x, q.y])).fill({ color, alpha });
    }
  }
  const dim = (c: number) => (night ? mix(c, 0x0b1524, 0.55) : mix(c, sky, 0.1));
  // Far mountains, then near ones with snow on their tops.
  for (const [k, base, color, snow] of [
    [0, 44, 0x8aa2b8, false],
    [1.3, 36, 0x4e6478, true],
  ] as const) {
    const pts: { x: number; y: number }[] = [wallB(u0, 30)];
    for (let u = u0; u <= u1 + 0.01; u += 0.08) pts.push(wallB(u, base + ridge(u, k)));
    pts.push(wallB(u1, 30));
    g.poly(pts.flatMap((q) => [q.x, q.y])).fill(dim(color));
    if (snow)
      for (let u = u0; u < u1; u += 0.08) {
        const h = base + ridge(u, k);
        if (h > base + 6) {
          const a = wallB(u, h);
          const b = wallB(u + 0.08, base + ridge(u + 0.08, k));
          g.moveTo(a.x, a.y).lineTo(b.x, b.y);
        }
      }
    g.stroke({ width: 2, color: dim(0xf4f6f8), alpha: 0.85 });
  }
  // The water, with a band of light on it.
  quad(g, rectB(u0, u1, 16, 30)).fill(dim(night ? 0x1a3346 : 0x3b6e8f));
  for (const h of [24, 27]) {
    const a = wallB(u0 + 0.3, h);
    const b = wallB(u1 - 0.5, h);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  g.stroke({ width: 0.8, color: night ? 0x5af2a0 : 0xffffff, alpha: night ? 0.25 : 0.4 });
  if (fnv1a(`cabin:${Math.round(gy * 10)}`) % 2 === 0) {
    const c = wallB(gy + 1.3, 31);
    g.rect(c.x - 4, c.y - 4, 8, 4).fill(dim(0xa8322a));
    g.poly([c.x - 5, c.y - 4, c.x + 5, c.y - 4, c.x, c.y - 8]).fill(dim(0x2a2b2d));
    if (night) g.rect(c.x - 1, c.y - 3, 2, 1.6).fill(p.glow);
  }
  weather(g, u0, look, 16, 76, 2);
}

/** A white wall lamp: a black arm and a dome shade, its light on the wall. */
function domeLamp(g: Graphics, p: Palette, u: number, h: number) {
  const c = wallA(u, h);
  glow(g, c.x, c.y + 6, 22, p.glow, p.theme === 'dark' ? 0.3 : 0.12);
  g.moveTo(c.x, c.y - 10)
    .lineTo(c.x, c.y - 3)
    .stroke({ width: 1, color: 0x1c1d1f });
  g.poly([c.x - 7, c.y + 3, c.x + 7, c.y + 3, c.x + 3, c.y - 3, c.x - 3, c.y - 3]).fill(0xf6f5f1);
  g.ellipse(c.x, c.y + 3, 7, 1.6).fill(mix(p.glow, 0xffffff, 0.5));
}

/** A small vase or bowl on a shelf at (u, h) on wall A. */
function ceramic(g: Graphics, u: number, h: number, color: number, tall: boolean) {
  const c = wallA(u, h);
  if (tall) g.roundRect(c.x - 2.2, c.y - 10, 4.4, 10, 2).fill(color);
  else g.ellipse(c.x, c.y - 2, 4, 2.6).fill(color);
}

/** A black steel post for the rope along the line. */
function steelPost(g: Graphics, p: Palette, x: number, y: number) {
  const c = iso(x, y);
  g.ellipse(c.x + 1, c.y + 1, 6, 3).fill({ color: p.shadow, alpha: 0.22 });
  g.ellipse(c.x, c.y - 1, 4.6, 2.3).fill(0x1c1d1f);
  g.rect(c.x - 1.1, c.y - POST_H, 2.2, POST_H - 1).fill(0x2a2b2d);
  g.rect(c.x - 1.1, c.y - POST_H, 0.7, POST_H - 1).fill(0x55575a);
  g.rect(c.x - 2, c.y - POST_H - 2, 4, 2.4).fill(0x1c1d1f);
}

const art: Partial<ThemeArt> = {
  // Wide birch boards: two to a tile, with staggered ends.
  floor(g, p, x, y, tile) {
    if (tile.kind !== 'open') return defaultArt.floor(g, p, x, y, tile);
    for (const k of [0, 0.5]) {
      const h = fnv1a(`birch:${x},${y},${k}`);
      diamond(g, x, y + k, x + 1, y + k + 0.5).fill(mix(p.corridor[0], p.corridor[1], (h % 100) / 100));
    }
    for (const k of [0, 0.5]) floorLine(g, x, y + k, x + 1, y + k);
    g.stroke({ width: 0.7, color: p.seam, alpha: 0.5 });
    const e = fnv1a(`birch-end:${x},${y}`) % 3;
    if (e < 2)
      floorLine(g, x + 0.3 + e * 0.4, y + e * 0.5, x + 0.3 + e * 0.4, y + e * 0.5 + 0.5).stroke({
        width: 0.7,
        color: p.seam,
        alpha: 0.4,
      });
  },
  // Wool rugs: a band in their colour and a stitched line.
  rug(g, p, area, c) {
    const edge = p.theme === 'dark' ? tint(c, 0.1) : shade(c, 0.1);
    diamond(g, area.x + 0.12, area.y + 0.12, area.x + area.w - 0.12, area.y + area.h - 0.12).stroke({
      width: 4,
      color: edge,
      alpha: 0.9,
    });
    diamond(g, area.x + 0.3, area.y + 0.3, area.x + area.w - 0.3, area.y + area.h - 0.3).stroke({
      width: 0.8,
      color: p.theme === 'dark' ? tint(c, 0.3) : 0xffffff,
      alpha: 0.6,
    });
  },
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    for (const [wall, len] of [
      ['A', layout.width],
      ['B', layout.height],
    ] as const) {
      for (let u = 0.25; u < len; u += 0.25) {
        const a = onWall(wall, u, 6);
        const b = onWall(wall, u, 80);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 0.6, color: shade(wall === 'A' ? p.wallRight : p.wallLeft, 0.12), alpha: 0.6 });
    }
  },
  // A big picture window in a thin black frame, a linen curtain to one side, candles on the sill.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy - 0.1, gy + 1.9, 16, 76)).fill(p.window);
    quad(drapes, rectB(gy - 0.1, gy + 1.9, 16, 76)).stroke({ width: 2, color: p.windowFrame });
    const m0 = wallB(gy + 0.9, 16);
    const m1 = wallB(gy + 0.9, 76);
    drapes.moveTo(m0.x, m0.y).lineTo(m1.x, m1.y).stroke({ width: 1.6, color: p.windowFrame });
    quad(drapes, rectB(gy - 0.16, gy + 1.96, 13.5, 16)).fill(p.wallTop);
    quad(drapes, [
      wallB(gy - 0.45, 12),
      wallB(gy - 0.02, 14),
      wallB(gy - 0.02, 79),
      wallB(gy - 0.45, 79),
    ]).fill({
      color: p.curtain,
      alpha: 0.92,
    });
    if (fnv1a(`candles:${Math.round(gy * 10)}`) % 2 === 0)
      for (const du of [1.35, 1.5]) {
        const c = wallB(gy + du, 16);
        drapes.rect(c.x - 1.4, c.y - 6, 2.8, 6).fill(0xf6f5f1);
        glow(drapes, c.x, c.y - 8, 10, p.glow, p.theme === 'dark' ? 0.45 : 0.2);
        drapes.ellipse(c.x, c.y - 8, 1, 2).fill(0xffd27a);
      }
  },
  view: fjordView,
  entrance(g, p, e) {
    quad(g, rectB(e + 0.12, e + 0.88, 0, 60))
      .fill(shade(p.wallLeft, 0.45))
      .stroke({ width: 2, color: p.windowFrame });
    diamond(g, 0.04, e + 0.15, 0.7, e + 0.85).fill({ color: p.runner.border, alpha: 0.6 });
  },
  // A woven hanging on a birch pole, between shelves of ceramics.
  feature(g, p, x0, x1) {
    const mid = (x0 + x1) / 2;
    const a = mid - 1.1;
    const b = mid + 1.1;
    quad(g, rectA(a, b, 20, 70)).fill(0xece5d6);
    const bands: [number, number, number][] = [
      [62, 66, 0x2a2b2d],
      [52, 55, 0xa8553a],
      [30, 33, 0x6e8a6a],
      [24, 26, 0x2a2b2d],
    ];
    for (const [h0, h1, c] of bands) quad(g, rectA(a, b, h0, h1)).fill(c);
    // A row of diamonds between the bands.
    for (let u = a + 0.15; u < b - 0.1; u += 0.3) {
      const c = wallA(u + 0.075, 43);
      g.poly([c.x, c.y - 7, c.x + 5.5, c.y, c.x, c.y + 7, c.x - 5.5, c.y]).fill(0x3b6e8f);
      g.poly([c.x, c.y - 3, c.x + 2.3, c.y, c.x, c.y + 3, c.x - 2.3, c.y]).fill(0xece5d6);
    }
    for (let u = a + 0.04; u < b; u += 0.07) {
      const c = wallA(u, 20);
      g.moveTo(c.x, c.y).lineTo(c.x, c.y + 4);
    }
    g.stroke({ width: 0.8, color: 0xd8cfbb });
    const r0 = wallA(a - 0.15, 71);
    const r1 = wallA(b + 0.15, 71);
    g.moveTo(r0.x, r0.y).lineTo(r1.x, r1.y).stroke({ width: 2.4, color: p.wood.top, cap: 'round' });
    // Shelves of ceramics either side.
    for (const [s0, s1] of [
      [x0 + 0.1, a - 0.35],
      [b + 0.35, x1 - 0.1],
    ] as const) {
      if (s1 - s0 < 0.4) continue;
      for (const h of [36, 52]) {
        quad(g, rectA(s0, s1, h, h + 2)).fill(p.wood.right);
        for (let u = s0 + 0.1, i = 0; u < s1 - 0.1; u += 0.22, i++)
          ceramic(g, u, h + 2, [0xf4f3ef, 0x9fb2a0, 0xc9b79a, 0x2a2b2d][(i + h) % 4]!, (i + h / 4) % 2 === 0);
      }
    }
  },
  // Your corner: a birch slat wall, open shelves, two dome lamps.
  suite(g, p, s) {
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 80)).fill(p.panel.face);
    for (let u = s.x0 - 0.15; u < s.x1; u += 0.1)
      quad(g, rectA(u, u + 0.03, 0, 80)).fill({ color: p.panel.shadow, alpha: 0.5 });
    for (const [a, b] of [
      [s.x0 + 0.1, s.door - 0.45],
      [s.door + 1.45, s.x1 - 0.2],
    ] as const)
      for (const h of [38, 56]) {
        quad(g, rectA(a, b, h, h + 2.2)).fill(p.wood.left);
        for (let u = a + 0.1, i = 0; u < b - 0.1; u += 0.2, i++)
          if (i % 3 === 2) ceramic(g, u, h + 2.2, [0x3b6e8f, 0xa8553a, 0xf4f3ef][i % 3]!, true);
          else quad(g, rectA(u, u + 0.12, h + 2.2, h + 13 + (i % 2) * 2)).fill(p.books[i % p.books.length]!);
      }
    domeLamp(g, p, s.door - 0.22, 60);
    domeLamp(g, p, s.door + 1.22, 60);
  },
  // A flat painted door, fjord blue, in a black frame with a black lever.
  door(g, p, q, open) {
    quad(g, rectA(q - 0.04, q + 1.04, 0, 68)).fill(p.doorFrame);
    if (open) {
      quad(g, rectA(q + 0.04, q + 0.96, 0, 66)).fill(shade(p.wallRight, 0.6));
      const c = wallA(q + 0.5, 32);
      g.ellipse(c.x, c.y, 18, 24).fill({ color: p.glow, alpha: 0.22 });
      quad(g, rectA(q + 0.04, q + 0.14, 0, 66)).fill(p.door);
      return;
    }
    quad(g, rectA(q + 0.04, q + 0.96, 0, 66)).fill(p.door);
    for (let u = q + 0.2; u < q + 0.95; u += 0.18) {
      const a = wallA(u, 2);
      const b = wallA(u + 0.03, 64);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: 0.6, color: shade(p.door, 0.12), alpha: 0.7 });
    const k = wallA(q + 0.84, 32);
    g.moveTo(k.x, k.y)
      .lineTo(k.x - 5, k.y + 2.5)
      .stroke({ width: 1.8, color: 0xe9e4da, cap: 'round' });
  },
  // Birch slat screens: see-through, with a cap along the top.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    const at = (t: number, h: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - h });
    for (let t = 0.06; t < 1; t += 0.125) {
      const c = at(t, 0);
      g.rect(c.x - 1.1, c.y - GLASS_H + 1, 2.2, GLASS_H - 1).fill(p.glass.pane);
      g.rect(c.x + 0.4, c.y - GLASS_H + 1, 0.7, GLASS_H - 1).fill({ color: 0x000000, alpha: 0.12 });
    }
    const c = at(0, GLASS_H);
    const d = at(1, GLASS_H);
    g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ width: 2, color: p.glass.rail });
  },
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) g.rect(q.x - 1.8, q.y - GLASS_H - 12, 3.6, GLASS_H + 12).fill(p.glass.rail);
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 3, color: p.glass.rail });
  },
  rope: ropeWith(steelPost, 3),
  // An olive tree in a white pot: a crooked trunk and a soft silvery crown.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    box(g, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 13, faces(p.plant.pot, 0.04, 0.14));
    g.moveTo(c.x - 1, c.y - 13)
      .quadraticCurveTo(c.x + 4, c.y - 22, c.x - 1, c.y - 30)
      .stroke({ width: 2.4, color: 0x6e6252, cap: 'round' });
    const crown: [number, number, number, boolean][] = [
      [-7, -30, 7, false],
      [6, -32, 7.5, false],
      [-1, -38, 8, false],
      [-5, -42, 5.5, true],
      [4, -41, 5.5, true],
    ];
    for (const [dx, dy, r, light] of crown)
      g.ellipse(c.x + dx, c.y + dy, r, r * 0.85).fill(light ? p.plant.leafLight : p.plant.leaf);
    for (let i = 0; i < 12; i++) {
      const dx = (rand(`olive:${x},${y}:${i}`) - 0.5) * 22;
      const dy = -28 - rand(`olive-h:${x},${y}:${i}`) * 18;
      g.ellipse(c.x + dx, c.y + dy, 2.6, 1.2).fill(tint(p.plant.leafLight, 0.25));
    }
  },
  // A birch side table with a lamp of stacked white shades.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y + 1, 22, 10).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.1 : 0.05 });
    box(g, f.x + 0.22, f.y + 0.22, f.x + 0.78, f.y + 0.78, 3, p.wood, 15);
    box(g, f.x + 0.47, f.y + 0.47, f.x + 0.53, f.y + 0.53, 15, p.wood);
    g.rect(c.x - 0.6, c.y - 34, 1.2, 16).fill(0x1c1d1f);
    glow(g, c.x, c.y - 30, 22, p.glow, p.theme === 'dark' ? 0.28 : 0.1);
    for (const [dy, rx] of [
      [-38, 10],
      [-34, 8],
      [-30, 6],
    ] as const) {
      g.ellipse(c.x, c.y + dy + 1.4, rx, rx * 0.35).fill(mix(p.glow, 0xffffff, 0.4));
      g.ellipse(c.x, c.y + dy, rx, rx * 0.35).fill(0xf6f5f1);
    }
  },
};

export const fjord: OfficeTheme = {
  id: 'fjord',
  name: 'Fjord',
  blurb: 'Birch, wool and a view',
  thumb: { floor: 'planks', accent: { dark: 0x5af2a0, light: 0x3b6e8f } },
  art,
  colours: {
    dark: {
      corridor: [0x4a4034, 0x4e4437],
      seam: 0x2e281f,
      pantry: [0x3e352b, 0x3a3128],
      lounge: [0x2e3033, 0x2b2d30],
      kitchen: {
        floor: [0x3a3c3e, 0x2f3133],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x3a3e44,
        grout: 0x4a4e54,
        block: 0x8a7a62,
        cabinet: { left: 0x2b3036, right: 0x23272c },
        copper: 0xb5683f,
      },
      carpets: [
        [0x2f3a40, 0x323d44],
        [0x33392f, 0x363c32],
        [0x40302a, 0x43332d],
        [0x37323d, 0x3a3540],
        [0x403a2a, 0x433d2d],
        [0x2c3a38, 0x2f3d3b],
      ],
      wallLeft: 0x2b3036,
      wallRight: 0x313740,
      wallTop: 0x3a4048,
      trim: 0x3e444c,
      baseboard: 0x23272c,
      window: 0x0e1a2a,
      windowFrame: 0x141516,
      glass: { pane: 0x8a7a62, rail: 0x5e5444 },
      curtain: 0x6b6660,
      wood: { top: 0x8a7a62, left: 0x6e6250, right: 0x5a5042 },
      metal: { top: 0x5a5e67, left: 0x43464d, right: 0x383b41 },
      monitor: 0x15171b,
      screen: 0x3d7fc4,
      chair: 0x6e6a62,
      plant: { pot: 0x9a9a96, leaf: 0x5a7a5a, leafLight: 0x7a9a78 },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x55575a, back: 0x47494c },
      felt: 0x2f6f4a,
      door: 0x46586a,
      doorFrame: 0x141516,
      brass: 0xb59a6a,
      sign: 0x1f2226,
      signText: 0xece6da,
      panel: { face: 0x6e6250, frame: 0x5a5042, shadow: 0x3a342c },
      rope: 0x8a8780,
      runner: { base: 0x2a2c2f, border: 0x4a4c50, pattern: 0x3a3c40 },
      glow: 0xffc98a,
      map: { paper: 0xe6dfd2, land: 0x6e6250, frame: 0x5a5042 },
      board: { frame: 0x5a5042 },
      books: [0x3b6e8f, 0xc9b79a, 0x8a5a44, 0x5a6a5a, 0xd8d2c4, 0x2a2b2d],
      shadow: 0x000000,
    },
    light: {
      corridor: [0xe6d6b8, 0xe0d0b2],
      seam: 0xc2b08e,
      pantry: [0xf0ebe2, 0xe8e2d6],
      lounge: [0xd8d6d0, 0xd2d0ca],
      kitchen: {
        floor: [0xeeeae4, 0xc9ccd0],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xf6f5f1,
        grout: 0xdedad2,
        block: 0xd9c3a0,
        cabinet: { left: 0x9fb2a0, right: 0x8ea291 },
        copper: 0xc0703f,
      },
      carpets: [
        [0xd0dde6, 0xcad7e0],
        [0xd6e0d2, 0xd0dacc],
        [0xe8d6cc, 0xe2d0c6],
        [0xdcd6e2, 0xd6d0dc],
        [0xece2c8, 0xe6dcc2],
        [0xcfe0dc, 0xc9dad6],
      ],
      wallLeft: 0xeceae4,
      wallRight: 0xf6f5f1,
      wallTop: 0xffffff,
      trim: 0xe2dfd8,
      baseboard: 0xd8d4cc,
      window: 0xdcecf6,
      windowFrame: 0x1c1d1f,
      glass: { pane: 0xd9c7a6, rail: 0xb59f7a },
      curtain: 0xe9e4da,
      wood: { top: 0xd9c3a0, left: 0xc4ad88, right: 0xb09874 },
      metal: { top: 0xb7bcc5, left: 0x9ea4ae, right: 0x8a909a },
      monitor: 0x2b2e35,
      screen: 0x8fc4f5,
      chair: 0xe0dacd,
      plant: { pot: 0xf4f3ef, leaf: 0x6e8a6a, leafLight: 0x93ad8c },
      fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
      sofa: { seat: 0x9a9c9e, back: 0x86888b },
      felt: 0x3f8f5f,
      door: 0x6f8797,
      doorFrame: 0x1c1d1f,
      brass: 0xb59a6a,
      sign: 0x2a2b2d,
      signText: 0xf3efe6,
      panel: { face: 0xd9c3a0, frame: 0xb09874, shadow: 0x9a8464 },
      rope: 0x9a968e,
      runner: { base: 0xd2cdc3, border: 0xb8b2a6, pattern: 0xc4beb2 },
      glow: 0xffd9a0,
      map: { paper: 0xf6f2ea, land: 0xc4ad88, frame: 0xb09874 },
      board: { frame: 0xc4ad88 },
      books: [0x3b6e8f, 0xc9b79a, 0x8a5a44, 0x5a6a5a, 0xd8d2c4, 0x2a2b2d],
      shadow: 0x2a2d35,
    },
  },
};
