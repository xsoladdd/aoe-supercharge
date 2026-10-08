import type { Graphics } from 'pixi.js';
import type { WindowLook } from '@aoe-supercharge/core/shared';
import { defaultArt, featureSpan, GLASS_H, ropeWith, skyColour, weather, windowsOf } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB } from '../iso';
import type { Palette } from '../palette';
import { ALONG, faces, floorLine, glow, onWall, rand, rectA, rectB } from './kit';
import type { OfficeTheme, ThemeArt } from './types';

/**
 * Ryokan: a Japanese inn. Tatami underfoot, plaster walls between dark posts, shoji screens round the
 * rooms, windows onto a garden, a tokonoma with a hanging scroll, bonsai, paper lanterns, and painted
 * fusuma doors on your corner.
 */

/** One tile of tatami: mats two tiles long, laid in alternating pairs, bordered in cloth along their long sides. */
function tatami(g: Graphics, p: Palette, x: number, y: number, tones: [number, number], edge: number) {
  const bx = Math.floor(x / 2);
  const by = Math.floor(y / 2);
  const along = (bx + by) % 2 === 0;
  const mat = along ? `${bx}:${y}` : `${x}:${by}`;
  diamond(g, x, y, x + 1, y + 1).fill(mix(tones[0], tones[1], rand(`tatami:${mat}`)));
  // The weave runs across the mat.
  for (let k = 1; k < 6; k++)
    if (along) floorLine(g, x + k / 6, y, x + k / 6, y + 1);
    else floorLine(g, x, y + k / 6, x + 1, y + k / 6);
  g.stroke({ width: 0.6, color: p.seam, alpha: 0.22 });
  if (along) {
    diamond(g, x, y, x + 1, y + 0.07).fill(edge);
    diamond(g, x, y + 0.93, x + 1, y + 1).fill(edge);
    if (x % 2 === 0) floorLine(g, x, y, x, y + 1).stroke({ width: 0.8, color: p.seam, alpha: 0.6 });
  } else {
    diamond(g, x, y, x + 0.07, y + 1).fill(edge);
    diamond(g, x + 0.93, y, x + 1, y + 1).fill(edge);
    if (y % 2 === 0) floorLine(g, x, y, x + 1, y).stroke({ width: 0.8, color: p.seam, alpha: 0.6 });
  }
}

/** A paper lantern hanging at (x, y) on screen: ribbed paper, black caps, its glow. */
function chochin(g: Graphics, p: Palette, x: number, y: number, color: number, size = 1) {
  glow(g, x, y, 24 * size, p.glow, p.theme === 'dark' ? 0.3 : 0.12);
  g.moveTo(x, y - 14 * size)
    .lineTo(x, y - 9 * size)
    .stroke({ width: 0.8, color: 0x1b1714 });
  g.ellipse(x, y, 6 * size, 8 * size).fill(color);
  for (const k of [-0.6, -0.2, 0.2, 0.6])
    g.ellipse(x, y + k * 8 * size, 6 * size * Math.sqrt(1 - k * k), 0.4).fill({
      color: shade(color, 0.3),
      alpha: 0.6,
    });
  g.ellipse(x - 2 * size, y - 2 * size, 1.6 * size, 3 * size).fill({ color: 0xffffff, alpha: 0.25 });
  g.rect(x - 3.5 * size, y - 9 * size, 7 * size, 2 * size).fill(0x1b1714);
  g.rect(x - 3.5 * size, y + 7 * size, 7 * size, 2 * size).fill(0x1b1714);
}

/** A sliding shoji panel on wall B from y0 to y1: paper in a wooden lattice. */
function shojiB(g: Graphics, p: Palette, y0: number, y1: number, h0: number, h1: number) {
  quad(g, rectB(y0, y1, h0, h1)).fill(p.curtain);
  for (let k = 1; k < 3; k++) {
    const a = wallB(y0 + ((y1 - y0) * k) / 3, h0);
    const b = wallB(y0 + ((y1 - y0) * k) / 3, h1);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  for (let h = h0 + 8; h < h1 - 2; h += 8) {
    const a = wallB(y0, h);
    const b = wallB(y1, h);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  g.stroke({ width: 0.8, color: p.glass.rail, alpha: 0.85 });
  quad(g, rectB(y0, y1, h0, h1)).stroke({ width: 1.6, color: p.glass.rail });
}

/** The garden out of a window: hills, moss, a pine or a maple, and a stone lantern. */
function garden(g: Graphics, p: Palette, gy: number, look: WindowLook) {
  const sky = skyColour(p, look);
  const dark = p.theme === 'dark' ? 0.55 : 0.5 * (1 - look.sky);
  const tone = (c: number) => mix(mix(c, sky, 0.15), 0x0b1524, dark);
  quad(g, rectB(gy, gy + 1.8, 28, 70)).fill(sky);
  // Distant hills.
  const hill: [number, number][] = [
    [0, 44],
    [0.3, 52],
    [0.7, 47],
    [1.1, 55],
    [1.5, 49],
    [1.8, 51],
    [1.8, 28],
    [0, 28],
  ];
  quad(
    g,
    hill.map(([u, h]) => wallB(gy + u, h)),
  ).fill(tone(mix(0x6f8a8f, sky, 0.45)));
  // Moss and a path.
  quad(g, rectB(gy, gy + 1.8, 28, 36)).fill(tone(0x557a43));
  const maple = rand(`garden:${gy}`) < 0.5;
  if (maple) {
    const t = wallB(gy + 1.15, 36);
    g.moveTo(t.x, t.y)
      .lineTo(t.x + 1, t.y - 12)
      .stroke({ width: 2.2, color: tone(0x3a2a20) });
    for (const [du, dh, r, c] of [
      [-0.18, 50, 7, 0xc2412b],
      [0.12, 54, 8, 0xd4562f],
      [0.0, 60, 6, 0xe0703a],
      [0.24, 47, 5, 0xb33a26],
    ] as const) {
      const c2 = wallB(gy + 1.15 + du, dh);
      g.circle(c2.x, c2.y, r).fill(tone(c));
    }
  } else {
    const t = wallB(gy + 1.2, 36);
    g.moveTo(t.x, t.y)
      .quadraticCurveTo(t.x - 6, t.y - 10, t.x - 2, t.y - 22)
      .stroke({ width: 2.4, color: tone(0x3a2a20) });
    for (const [du, dh, rx] of [
      [-0.05, 50, 11],
      [0.18, 57, 9],
      [0.0, 63, 7],
    ] as const) {
      const c2 = wallB(gy + 1.2 + du, dh);
      g.ellipse(c2.x, c2.y, rx, 3.6).fill(tone(0x2f5a3a));
    }
  }
  // A stone lantern.
  const l = wallB(gy + 0.45, 36);
  g.rect(l.x - 1.5, l.y - 10, 3, 10).fill(tone(0x8a8a82));
  g.rect(l.x - 4, l.y - 15, 8, 5).fill(tone(0x9a9a92));
  g.poly([l.x - 6, l.y - 15, l.x + 6, l.y - 15, l.x, l.y - 20]).fill(tone(0x7a7a72));
  if (p.theme === 'dark' || look.sky < 0.5)
    g.rect(l.x - 2, l.y - 14, 4, 3).fill({ color: p.glow, alpha: 0.9 });
  weather(g, gy, look);
}

/** Seigaiha: rows of overlapping waves, drawn on wall A from x0 to x1 between h0 and h1. */
function waves(g: Graphics, color: number, x0: number, x1: number, h0: number, h1: number, alpha: number) {
  const r = 5;
  for (let row = 0, h = h0 + r; h < h1 - 1; row++, h += r * 0.7) {
    for (let u = x0 + (row % 2 ? r / ALONG : 0); u < x1 - (r * 0.7) / ALONG; u += (2 * r) / ALONG) {
      for (const k of [1, 0.65, 0.32]) {
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i <= 10; i++) {
          const a = (i / 10) * Math.PI;
          pts.push(wallA(u + (Math.cos(a) * r * k) / ALONG, h + Math.sin(a) * r * k));
        }
        g.moveTo(pts[0]!.x, pts[0]!.y);
        for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
      }
    }
  }
  g.stroke({ width: 0.7, color, alpha });
}

/** A wooden post with a cap, for the rope beside your line. */
function stake(g: Graphics, p: Palette, x: number, y: number) {
  const c = iso(x, y);
  g.ellipse(c.x + 1, c.y + 1, 6, 3).fill({ color: p.shadow, alpha: 0.22 });
  g.rect(c.x - 1.8, c.y - 26, 3.6, 25).fill(p.panel.frame);
  g.rect(c.x - 1.8, c.y - 26, 1.2, 25).fill(tint(p.panel.frame, 0.2));
  g.rect(c.x - 2.6, c.y - 28, 5.2, 2.4).fill(shade(p.panel.frame, 0.3));
}

const art: Partial<ThemeArt> = {
  floor(g, p, x, y, tile) {
    if (tile.kind === 'open') return tatami(g, p, x, y, p.corridor, p.runner.border);
    if (tile.kind === 'carpet') return tatami(g, p, x, y, tile.tones, shade(tile.tones[0], 0.5));
    if (tile.kind === 'pantry') {
      // The engawa: long boards of dark wood.
      diamond(g, x, y, x + 1, y + 1).fill(tile.tones[(x + y) % 2]!);
      for (const k of [0, 0.5]) floorLine(g, x, y + k, x + 1, y + k);
      g.stroke({ width: 0.8, color: p.seam, alpha: 0.5 });
      return;
    }
    defaultArt.floor(g, p, x, y, tile);
  },
  rug(g, _p, area, c) {
    // The rooms are tatami already: a dark sill round their edge.
    diamond(g, area.x + 0.04, area.y + 0.04, area.x + area.w - 0.04, area.y + area.h - 0.04).stroke({
      width: 3,
      color: shade(c, 0.55),
      alpha: 0.9,
    });
  },
  runner(g, p, r) {
    // A cloth runner of plain indigo with a pale border.
    diamond(g, r.x + 0.18, r.y + 0.06, r.x + r.w - 0.18, r.y + r.h - 0.12).fill(p.runner.base);
    diamond(g, r.x + 0.26, r.y + 0.12, r.x + r.w - 0.26, r.y + r.h - 0.2).stroke({
      width: 1,
      color: p.runner.pattern,
      alpha: 0.8,
    });
  },
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    const W = layout.width;
    const H = layout.height;
    for (const [wall, len] of [
      ['A', W],
      ['B', H],
    ] as const) {
      const rect = wall === 'A' ? rectA : rectB;
      // Wainscot boards, a rail along the top of the doors (nageshi), posts every few tiles.
      quad(g, rect(0, len, 6, 20)).fill(p.panel.face);
      for (let u = 0.25; u < len; u += 0.25) {
        const a = onWall(wall, u, 6);
        const b = onWall(wall, u, 20);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({ width: 0.6, color: p.panel.shadow, alpha: 0.7 });
      quad(g, rect(0, len, 20, 22)).fill(p.trim);
      quad(g, rect(0, len, 62, 66)).fill(p.trim);
      for (let u = 3; u < len - 0.5; u += 3) quad(g, rect(u - 0.07, u + 0.07, 0, 83)).fill(p.trim);
    }
  },
  // A dark wooden frame, its shoji slid aside onto the wall.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy, gy + 1.8, 28, 70)).fill(p.window);
    quad(drapes, rectB(gy - 0.08, gy + 1.88, 24, 28)).fill(p.trim);
    quad(drapes, rectB(gy - 0.08, gy + 1.88, 70, 74)).fill(p.trim);
    quad(drapes, rectB(gy, gy + 1.8, 28, 70)).stroke({ width: 2.5, color: p.trim });
    shojiB(drapes, p, gy - 0.5, gy + 0.08, 26, 72);
    shojiB(drapes, p, gy + 1.72, gy + 2.3, 26, 72);
  },
  view: garden,
  // The tokonoma: an alcove with a hanging scroll and an arrangement, and staggered shelves beside it.
  feature(g, p, x0, x1) {
    const mid = (x0 + x1) / 2;
    const a = mid - 1.3;
    const b = mid + 1.3;
    quad(g, rectA(a, b, 14, 70)).fill(shade(p.wallRight, p.theme === 'dark' ? 0.18 : 0.06));
    quad(g, rectA(a, b, 10, 15)).fill(shade(p.panel.face, 0.2));
    quad(g, rectA(a - 0.1, b + 0.1, 66, 72)).fill(p.trim);
    quad(g, rectA(a - 0.12, a + 0.02, 0, 72)).fill(mix(p.trim, 0x8a6a48, 0.3));
    quad(g, rectA(b - 0.02, b + 0.12, 0, 72)).fill(p.trim);
    // The scroll: a mount of cloth, paper, an ink landscape and a red seal.
    const s0 = mid - 0.36;
    const s1 = mid + 0.36;
    quad(g, rectA(s0, s1, 24, 64)).fill(0x5a6e5a);
    quad(g, rectA(s0 + 0.07, s1 - 0.07, 29, 58)).fill(0xefe8d4);
    quad(g, rectA(s0 - 0.04, s1 + 0.04, 63, 65)).fill(0x3a2a1f);
    quad(g, rectA(s0 - 0.04, s1 + 0.04, 22, 24)).fill(0x3a2a1f);
    const ink = (pts: [number, number][], alpha: number) =>
      quad(
        g,
        pts.map(([u, h]) => wallA(s0 + 0.07 + u * (s1 - s0 - 0.14), 29 + h * 29)),
      ).fill({ color: 0x2a2a2a, alpha });
    ink(
      [
        [0, 0.35],
        [0.25, 0.75],
        [0.45, 0.5],
        [0.7, 0.9],
        [1, 0.45],
        [1, 0.3],
        [0, 0.3],
      ],
      0.35,
    );
    ink(
      [
        [0, 0.15],
        [0.35, 0.45],
        [0.6, 0.25],
        [1, 0.4],
        [1, 0.12],
        [0, 0.12],
      ],
      0.55,
    );
    quad(g, rectA(s1 - 0.17, s1 - 0.11, 33, 36)).fill(0xb3392f);
    // An arrangement on the alcove floor: a dark vase, a bare branch, a few blossoms.
    const v = wallA(a + 0.5, 15);
    g.roundRect(v.x - 3, v.y - 10, 6, 10, 2).fill(0x2b2622);
    g.moveTo(v.x, v.y - 10)
      .quadraticCurveTo(v.x + 2, v.y - 22, v.x + 10, v.y - 30)
      .moveTo(v.x + 1, v.y - 16)
      .lineTo(v.x - 6, v.y - 24)
      .stroke({ width: 1, color: 0x3a2a20 });
    for (const [dx, dy] of [
      [10, -30],
      [6, -26],
      [-6, -24],
      [3, -20],
    ] as const)
      g.circle(v.x + dx, v.y + dy, 1.6).fill(0xe08aa0);
    // Staggered shelves to the right, with a small box on one.
    const c0 = b + 0.5;
    for (const [u0, u1, h] of [
      [c0, c0 + 0.7, 44],
      [c0 + 0.4, c0 + 1.1, 36],
    ] as const)
      quad(g, rectA(u0, u1, h, h + 2.5)).fill(p.trim);
    quad(g, rectA(c0 + 0.1, c0 + 0.35, 46.5, 52)).fill(0x7a3b22);
  },
  // Your corner: fusuma panels painted with waves, under a carved transom.
  suite(g, p, s) {
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 80)).fill(p.panel.face);
    for (let x = s.x0 - 0.2; x < s.x1 - 0.1; x += 1) {
      const u0 = x + 0.04;
      const u1 = Math.min(s.x1, x + 0.96);
      if (u1 > s.door - 0.1 && u0 < s.door + 1.1) continue;
      quad(g, rectA(u0, u1, 4, 62)).fill(p.door);
      waves(g, p.runner.border, u0 + 0.05, u1 - 0.05, 8, 40, 0.55);
      quad(g, rectA(u0, u1, 4, 62)).stroke({ width: 1.6, color: p.panel.shadow });
      const k = wallA(u1 - 0.14, 34);
      g.ellipse(k.x, k.y, 2.4, 3).fill(p.panel.shadow).stroke({ width: 0.8, color: p.brass });
    }
    // The transom: a lattice in dark wood.
    quad(g, rectA(s.x0 - 0.2, s.x1, 66, 78)).fill(shade(p.panel.face, 0.25));
    for (let x = s.x0; x < s.x1; x += 0.25) {
      const a = wallA(x, 66);
      const b = wallA(x + 0.12, 78);
      const c = wallA(x + 0.12, 66);
      const d = wallA(x, 78);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    g.stroke({ width: 0.8, color: p.panel.frame, alpha: 0.9 });
  },
  // Fusuma: two painted sliding panels; open, they part on a lamplit room with a scroll.
  door(g, p, q, open) {
    quad(g, rectA(q - 0.06, q + 1.06, 0, 70)).fill(p.doorFrame);
    const panel = (u0: number, u1: number) => {
      quad(g, rectA(u0, u1, 0, 64)).fill(p.door);
      // A pine branch in green and gold.
      const a = wallA(u0 + (u1 - u0) * 0.2, 46);
      const b = wallA(u0 + (u1 - u0) * 0.85, 52);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.4, color: 0x4a3526 });
      for (const t of [0.35, 0.6, 0.82]) {
        const c = wallA(u0 + (u1 - u0) * t, 49 + t * 6);
        g.ellipse(c.x, c.y, 5, 2.4).fill({ color: 0x3f6e4a, alpha: 0.85 });
      }
      quad(g, rectA(u0, u1, 0, 64)).stroke({ width: 1.4, color: p.doorFrame });
      const k = wallA(u0 + (u1 - u0) * 0.5, 32);
      g.ellipse(k.x, k.y, 2.2, 2.8).fill(p.panel.shadow).stroke({ width: 0.8, color: p.brass });
    };
    if (open) {
      quad(g, rectA(q + 0.06, q + 0.94, 0, 64)).fill(shade(p.wallRight, 0.55));
      const c = wallA(q + 0.5, 30);
      g.ellipse(c.x, c.y, 18, 24).fill({ color: p.glow, alpha: 0.22 });
      quad(g, rectA(q + 0.4, q + 0.6, 22, 52)).fill({ color: 0xefe8d4, alpha: 0.6 });
      panel(q + 0.02, q + 0.22);
      panel(q + 0.78, q + 0.98);
    } else {
      panel(q + 0.02, q + 0.5);
      panel(q + 0.5, q + 0.98);
    }
    quad(g, rectA(q - 0.12, q + 1.12, 64, 70)).fill(p.trim);
  },
  // Paper lanterns: between the windows, and where the back wall is bare.
  extras(g, p, layout) {
    const wins = windowsOf(layout);
    for (let i = 0; i + 1 < wins.length; i++) {
      const y = (wins[i]! + 1.8 + wins[i + 1]!) / 2;
      const c = wallB(y, 62);
      chochin(g, p, c.x, c.y, i % 2 ? 0xf3ead6 : 0xc8402e, 1);
    }
    const span = featureSpan(layout);
    const ka = layout.kitchen.area;
    if (span) {
      for (const x of [(ka.x + ka.w + span.x0) / 2, (span.x1 + layout.board.x0) / 2]) {
        const c = wallA(x, 60);
        chochin(g, p, c.x, c.y, 0xf3ead6, 1.15);
      }
    }
  },
  // Shoji: paper in a lattice, light enough to see who is inside.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    const at = (t: number, h: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - h });
    quad(g, [at(0, 2), at(1, 2), at(1, GLASS_H), at(0, GLASS_H)]).fill({
      color: p.glass.pane,
      alpha: p.theme === 'dark' ? 0.32 : 0.42,
    });
    for (let k = 1; k < 4; k++) {
      const c = at(k / 4, 2);
      const d = at(k / 4, GLASS_H);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    for (const h of [12, 21]) {
      const c = at(0, h);
      const d = at(1, h);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    g.stroke({ width: 0.8, color: p.glass.rail, alpha: 0.85 });
    for (const h of [GLASS_H, 1.5]) {
      const c = at(0, h);
      const d = at(1, h);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y);
    }
    g.stroke({ width: 2.2, color: p.glass.rail });
    g.rect(a.x - 1.2, a.y - GLASS_H, 2.4, GLASS_H).fill(p.glass.rail);
  },
  // Wooden posts and a lintel, with a short indigo noren.
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) g.rect(q.x - 1.8, q.y - GLASS_H - 12, 3.6, GLASS_H + 12).fill(p.glass.rail);
    const top = (k: number, h: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k - h });
    for (const [k0, k1] of [
      [0.08, 0.33],
      [0.37, 0.63],
      [0.67, 0.92],
    ] as const)
      quad(g, [
        top(k0, GLASS_H + 11),
        top(k1, GLASS_H + 11),
        top(k1, GLASS_H + 4),
        top(k0, GLASS_H + 4),
      ]).fill(p.runner.border);
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 3.4, color: p.glass.rail });
  },
  // A bonsai: a shallow glazed pot, a twisting trunk, pads of foliage.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    box(g, x + 0.22, y + 0.3, x + 0.78, y + 0.7, 6, faces(p.plant.pot, 0.2, 0.25));
    box(g, x + 0.3, y + 0.36, x + 0.38, y + 0.44, 4, faces(shade(p.plant.pot, 0.3)));
    box(g, x + 0.64, y + 0.56, x + 0.72, y + 0.64, 4, faces(shade(p.plant.pot, 0.3)));
    const trunk = 0x5a3e2b;
    g.moveTo(c.x - 2, c.y - 8)
      .quadraticCurveTo(c.x - 10, c.y - 18, c.x - 1, c.y - 24)
      .quadraticCurveTo(c.x + 7, c.y - 29, c.x + 2, c.y - 36)
      .stroke({ width: 3.4, color: trunk, cap: 'round' });
    g.moveTo(c.x - 4, c.y - 20)
      .lineTo(c.x - 12, c.y - 25)
      .stroke({ width: 1.8, color: trunk, cap: 'round' });
    for (const [dx, dy, rx] of [
      [-12, -27, 8],
      [3, -37, 10],
      [9, -27, 7],
    ] as const) {
      g.ellipse(c.x + dx, c.y + dy, rx, 4).fill(p.plant.leaf);
      g.ellipse(c.x + dx - 1, c.y + dy - 1.6, rx * 0.75, 2.4).fill(p.plant.leafLight);
    }
  },
  // A low lacquer table with an andon: a paper lantern on a wooden frame.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y + 1, 24, 11).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.12 : 0.06 });
    box(g, f.x + 0.18, f.y + 0.18, f.x + 0.82, f.y + 0.82, 4, faces(p.panel.shadow, 0.15), 6);
    for (const [u, v] of [
      [0.2, 0.78],
      [0.78, 0.78],
      [0.78, 0.2],
    ] as const)
      box(g, f.x + u, f.y + v - 0.03, f.x + u + 0.03, f.y + v, 6, faces(p.panel.shadow));
    const paper = mix(p.curtain, p.glow, 0.35);
    glow(g, c.x, c.y - 26, 26, p.glow, p.theme === 'dark' ? 0.35 : 0.15);
    box(
      g,
      f.x + 0.36,
      f.y + 0.36,
      f.x + 0.64,
      f.y + 0.64,
      22,
      { top: tint(paper, 0.2), left: paper, right: shade(paper, 0.08) },
      10,
    );
    for (const [u, v] of [
      [0.36, 0.64],
      [0.64, 0.64],
      [0.64, 0.36],
    ] as const) {
      const q = iso(f.x + u, f.y + v);
      g.rect(q.x - 0.8, q.y - 33, 1.6, 23).fill(p.panel.frame);
    }
  },
  rope: ropeWith(stake, 3.2),
};

export const ryokan: OfficeTheme = {
  id: 'ryokan',
  name: 'Ryokan',
  blurb: 'Tatami, shoji and a garden',
  thumb: { floor: 'mats', accent: { dark: 0xc8402e, light: 0xc8402e } },
  art,
  colours: {
    dark: {
      corridor: [0x48442d, 0x4c4831],
      seam: 0x2f2b1c,
      pantry: [0x3b2a1e, 0x37271c],
      lounge: [0x5a2622, 0x56231f],
      kitchen: {
        floor: [0x3a3631, 0x2f2c28],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x3a352c,
        grout: 0x4a4335,
        block: 0x9a7a52,
        cabinet: { left: 0x3a2a1f, right: 0x2e2118 },
        copper: 0xb5683f,
      },
      carpets: [
        [0x40462d, 0x434a30],
        [0x52452c, 0x56482e],
        [0x3e4842, 0x414c45],
        [0x4d3f36, 0x514239],
        [0x464434, 0x4a4837],
        [0x3c4a4a, 0x3f4e4e],
      ],
      wallLeft: 0x4a4235,
      wallRight: 0x524a3c,
      wallTop: 0x2b211a,
      trim: 0x3a2a1f,
      baseboard: 0x2b1f17,
      window: 0x1b2430,
      windowFrame: 0x3a2a1f,
      glass: { pane: 0xe9e2cf, rail: 0x4a3526 },
      curtain: 0xd9d0b9,
      wood: { top: 0x8a6a48, left: 0x6e5236, right: 0x5a422b },
      metal: { top: 0x4a4e54, left: 0x383b40, right: 0x2c2f33 },
      monitor: 0x15171b,
      screen: 0x3d7fc4,
      chair: 0x2b3a55,
      plant: { pot: 0x4a5a6a, leaf: 0x2f5f3a, leafLight: 0x4a7f4c },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x3b4a6b, back: 0x2e3b56 },
      felt: 0x2f6f4a,
      door: 0xcfc3a3,
      doorFrame: 0x2b1f17,
      brass: 0xb08d57,
      sign: 0x2b1f17,
      signText: 0xf3e7c8,
      panel: { face: 0x3a2f24, frame: 0x4f3d2c, shadow: 0x261c14 },
      rope: 0xc9a96e,
      runner: { base: 0x24324c, border: 0x24324c, pattern: 0x8a95ad },
      glow: 0xffc27a,
      map: { paper: 0xe9e2cf, land: 0x3a3a3a, frame: 0x3a2a1f },
      board: { frame: 0x4a3526 },
      books: [0x7a3b22, 0x2b3a55, 0x8c6a28, 0x5a3a2a, 0x3a5a3a, 0xc9a96e],
      shadow: 0x000000,
    },
    light: {
      corridor: [0xd3c798, 0xccc090],
      seam: 0x9a8e5e,
      pantry: [0xcfae84, 0xc9a87e],
      lounge: [0x561815, 0x521613],
      kitchen: {
        floor: [0xc4bdaf, 0xb0a99b],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xefe8d8,
        grout: 0xd6cdb9,
        block: 0xd2ad80,
        cabinet: { left: 0x5a4030, right: 0x4a3526 },
        copper: 0xc0703f,
      },
      carpets: [
        [0xc6c592, 0xc0bf8c],
        [0xd6c792, 0xd0c18c],
        [0xbcc4a2, 0xb6be9c],
        [0xd0bc98, 0xcab692],
        [0xcdc6a0, 0xc7c09a],
        [0xbcc6b2, 0xb6c0ac],
      ],
      wallLeft: 0xe9e1cd,
      wallRight: 0xf0e9d8,
      wallTop: 0x5a4030,
      trim: 0x5e4231,
      baseboard: 0x4a3526,
      window: 0xdbeaf2,
      windowFrame: 0x5a4030,
      glass: { pane: 0xf6f1e4, rail: 0x6b4a33 },
      curtain: 0xf6f1e4,
      wood: { top: 0xc9a27a, left: 0xa9845e, right: 0x8f6d4b },
      metal: { top: 0xb7bcc5, left: 0x9ea4ae, right: 0x8a909a },
      monitor: 0x2b2e35,
      screen: 0x8fc4f5,
      chair: 0x2f4466,
      plant: { pot: 0x5a6e80, leaf: 0x3f7a4a, leafLight: 0x5f9a5c },
      fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
      sofa: { seat: 0x3f5584, back: 0x33466e },
      felt: 0x3f8f5f,
      door: 0xefe6cf,
      doorFrame: 0x4a3526,
      brass: 0xb08d57,
      sign: 0x3a2a1f,
      signText: 0xf6ecd2,
      panel: { face: 0x7a5a3e, frame: 0x5a4030, shadow: 0x4a3526 },
      rope: 0xc9a96e,
      runner: { base: 0x1f2c44, border: 0x1f2c44, pattern: 0xc9d2e6 },
      glow: 0xffd28a,
      map: { paper: 0xf6f1e4, land: 0x3a3a3a, frame: 0x5a4030 },
      board: { frame: 0x6b4a33 },
      books: [0x7a3b22, 0x2b3a55, 0x8c6a28, 0x5a3a2a, 0x3a5a3a, 0xc9a96e],
      shadow: 0x2a2d35,
    },
  },
};
