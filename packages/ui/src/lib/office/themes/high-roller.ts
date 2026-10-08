import type { Graphics } from 'pixi.js';
import type { WindowLook } from '@aoe-supercharge/core/shared';
import { defaultArt, featureSpan, GLASS_H, poolTileEdges, skyColour, weather, windowsOf } from '../art';
import { box, diamond, iso, mix, quad, shade, tint, wallA, wallB, type Pt } from '../iso';
import type { Palette } from '../palette';
import { ALONG, faces, floorLine, glow, lattice, onWall, rand, rectA, rectB } from './kit';
import type { Motion, OfficeTheme, ThemeArt } from './types';

/**
 * High Roller: a casino floor. A patterned carpet, damask walls with gold, velvet drapes, crystal
 * sconces and a neon sign, slot machines where the foosball was, a roulette table in the lounge, and a
 * padded VIP door on your corner.
 */

const TEAL = 0x0f5a52;
const NEON_PINK = 0xff4f8b;
const NEON_WHITE = 0xf4f1ff;

/** A card suit's outline in px, centred on (0, 0), `r` px tall: up is +y. */
function suit(kind: 'spade' | 'heart' | 'diamond' | 'club', r: number): [number, number][][] {
  const heart = (flip: number) =>
    Array.from({ length: 28 }, (_, i) => {
      const t = (i / 28) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return [(x / 34) * r, ((flip * y) / 34) * r + flip * r * 0.05] as [number, number];
    });
  if (kind === 'heart') return [heart(1)];
  if (kind === 'diamond')
    return [
      [
        [0, r * 0.55],
        [r * 0.36, 0],
        [0, -r * 0.55],
        [-r * 0.36, 0],
      ],
    ];
  const stem: [number, number][] = [
    [-r * 0.06, -r * 0.1],
    [r * 0.06, -r * 0.1],
    [r * 0.18, -r * 0.5],
    [-r * 0.18, -r * 0.5],
  ];
  if (kind === 'spade') return [heart(-1).map(([x, y]) => [x, y + r * 0.08] as [number, number]), stem];
  const lobe = (cx: number, cy: number) =>
    Array.from({ length: 16 }, (_, i) => {
      const t = (i / 16) * Math.PI * 2;
      return [cx + Math.cos(t) * r * 0.2, cy + Math.sin(t) * r * 0.2] as [number, number];
    });
  return [lobe(0, r * 0.26), lobe(-r * 0.22, -r * 0.06), lobe(r * 0.22, -r * 0.06), stem];
}

/** A neon tube along an outline on wall A: a soft halo, then the bright core. */
function neon(g: Graphics, outline: Pt[], color: number, lit: number) {
  const flat = outline.flatMap((q) => [q.x, q.y]);
  g.poly(flat, true).stroke({ width: 5, color, alpha: 0.18 * lit });
  g.poly(flat, true).stroke({ width: 2.4, color, alpha: 0.45 * lit });
  g.poly(flat, true).stroke({ width: 1, color: mix(color, 0xffffff, 0.6), alpha: 0.35 + 0.65 * lit });
}

/** A crystal sconce on a wall: a gold arm, drops of crystal, warm light. */
function sconce(g: Graphics, p: Palette, wall: 'A' | 'B', u: number, h: number) {
  const c = onWall(wall, u, h);
  glow(g, c.x, c.y - 4, 26, p.glow, p.theme === 'dark' ? 0.3 : 0.14);
  g.ellipse(c.x, c.y + 6, 3, 1.5).fill(p.brass);
  g.moveTo(c.x - 7, c.y - 2)
    .quadraticCurveTo(c.x, c.y + 8, c.x + 7, c.y - 2)
    .stroke({ width: 1.4, color: p.brass });
  for (const dx of [-7, 0, 7]) {
    const top = dx ? c.y - 2 : c.y - 5;
    g.ellipse(c.x + dx, top - 3, 2, 3.4).fill(mix(p.glow, 0xffffff, 0.45));
    for (const k of [-1, 1])
      g.poly([c.x + dx + k * 1.6, top + 1, c.x + dx + k * 2.4, top + 4, c.x + dx + k * 0.8, top + 4]).fill({
        color: 0xdbe9ff,
        alpha: 0.8,
      });
  }
}

/** The city out of a window: towers against the sky, their windows lit at night. */
function skyline(g: Graphics, p: Palette, gy: number, look: WindowLook) {
  const sky = skyColour(p, look);
  quad(g, rectB(gy, gy + 1.8, 28, 70)).fill(sky);
  const night = p.theme === 'dark' || look.sky < 0.5;
  const tower = night ? mix(sky, 0x05070d, 0.55) : mix(sky, 0x5a6478, 0.45);
  for (let u = 0; u < 1.8;) {
    const r = rand(`tower:${gy}:${Math.round(u * 100)}`);
    const w = 0.18 + r * 0.22;
    const top = 40 + r * 24;
    const u1 = Math.min(1.8, u + w);
    quad(g, rectB(gy + u, gy + u1, 28, top)).fill(r > 0.5 ? tower : shade(tower, 0.15));
    if (night)
      for (let h = 31; h < top - 2; h += 4)
        for (let k = u + 0.04; k < u1 - 0.04; k += 0.07)
          if (rand(`lit:${gy}:${h}:${Math.round(k * 100)}`) < 0.45)
            quad(g, rectB(gy + k, gy + k + 0.03, h, h + 1.6)).fill({ color: 0xffd98a, alpha: 0.85 });
    u = u1 + 0.02;
  }
  weather(g, gy, look);
}

/** One slot machine on a tile: a lacquer cabinet, three reels on its front, a lit marquee and a lever. */
function slotMachine(g: Graphics, p: Palette, x: number, y: number, n: number) {
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y + 2, 24, 10).fill({ color: p.shadow, alpha: 0.2 });
  const body = n % 2 ? 0x7a1428 : 0x1d2a5a;
  box(g, x + 0.14, y + 0.24, x + 0.86, y + 0.82, 36, faces(body, 0.18, 0.3));
  // The front (towards whoever plays): a gold-edged screen with three reels, a tray under it.
  const face = (u: number, h: number) => {
    const q = iso(x + 0.14 + u * 0.72, y + 0.82);
    return { x: q.x, y: q.y - h };
  };
  quad(g, [face(0.08, 14), face(0.92, 14), face(0.92, 30), face(0.08, 30)]).fill(p.brass);
  quad(g, [face(0.12, 15.5), face(0.88, 15.5), face(0.88, 28.5), face(0.12, 28.5)]).fill(0x101014);
  const symbols = [0xe02b3a, 0xf1c40f, 0x2e8b57];
  for (let k = 0; k < 3; k++) {
    const u0 = 0.16 + k * 0.245;
    quad(g, [face(u0, 17), face(u0 + 0.2, 17), face(u0 + 0.2, 27), face(u0, 27)]).fill(0xf8f4ea);
    const s = face(u0 + 0.1, 22);
    g.circle(s.x, s.y, 2).fill(symbols[(k + n) % 3]!);
  }
  quad(g, [face(0.2, 6), face(0.8, 6), face(0.8, 9), face(0.2, 9)]).fill(shade(p.brass, 0.25));
  // The marquee: a lit crown on top.
  box(
    g,
    x + 0.14,
    y + 0.24,
    x + 0.86,
    y + 0.82,
    6,
    { top: tint(NEON_PINK, 0.4), left: NEON_PINK, right: shade(NEON_PINK, 0.2) },
    36,
  );
  const m = iso(x + 0.5, y + 0.53);
  glow(g, m.x, m.y - 42, 22, NEON_PINK, p.theme === 'dark' ? 0.3 : 0.12);
  for (let k = 0; k < 5; k++) {
    const b = face(0.1 + k * 0.2, 39);
    g.circle(b.x, b.y, 0.9).fill(0xfff6d6);
  }
  // The lever, on the right.
  const l = iso(x + 0.86, y + 0.5);
  g.moveTo(l.x + 1, l.y - 22)
    .lineTo(l.x + 5, l.y - 34)
    .stroke({ width: 1.6, color: p.metal.top, cap: 'round' });
  g.circle(l.x + 5, l.y - 35, 2.4).fill(0xe02b3a);
}

/** A roulette wheel at (cx, cy) on the table, `h` px up: a wooden bowl, red and black pockets, a gold turret. */
function wheel(g: Graphics, p: Palette, cx: number, cy: number, h: number) {
  const c = iso(cx, cy);
  const y = c.y - h;
  g.ellipse(c.x, y + 2, 22, 11).fill(shade(p.wood.left, 0.2));
  g.ellipse(c.x, y, 22, 11).fill(p.wood.top);
  g.ellipse(c.x, y, 18, 9).fill(p.brass);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const pt = (a: number, r: number) => [c.x + Math.cos(a) * r, y + Math.sin(a) * r * 0.5];
    g.poly([...pt(a0, 16.5), ...pt(a1, 16.5), ...pt(a1, 10), ...pt(a0, 10)]).fill(
      i === 0 ? 0x168a4a : i % 2 ? 0xc0182a : 0x161214,
    );
  }
  g.ellipse(c.x, y, 9, 4.5).fill(p.wood.right);
  g.ellipse(c.x, y, 4, 2).fill(p.brass);
  g.moveTo(c.x, y - 1)
    .lineTo(c.x, y - 6)
    .stroke({ width: 1.4, color: p.brass });
  g.circle(c.x + 12, y - 3, 1.3).fill(0xffffff);
}

/** A stack of chips at (x, y) on a surface `h` px up. */
function chips(g: Graphics, x: number, y: number, h: number, color: number, count: number) {
  const c = iso(x, y);
  for (let k = 0; k < count; k++) {
    g.ellipse(c.x, c.y - h - k * 1.4, 3.4, 1.7).fill(shade(color, 0.25));
    g.ellipse(c.x, c.y - h - k * 1.4 - 0.6, 3.4, 1.7).fill(color);
  }
  g.ellipse(c.x, c.y - h - (count - 1) * 1.4 - 0.6, 1.6, 0.8).fill({ color: 0xffffff, alpha: 0.7 });
}

const art: Partial<ThemeArt> = {
  // A casino carpet: a gold lattice, teal medallions and gold dots on deep burgundy.
  floor(g, p, x, y, tile) {
    if (tile.kind !== 'open') return defaultArt.floor(g, p, x, y, tile);
    diamond(g, x, y, x + 1, y + 1).fill(p.corridor[(x + y) % 2]!);
    diamond(g, x + 0.38, y + 0.38, x + 0.62, y + 0.62).fill({ color: TEAL, alpha: 0.9 });
    diamond(g, x + 0.46, y + 0.46, x + 0.54, y + 0.54).fill({ color: p.brass, alpha: 0.8 });
    diamond(g, x + 0.18, y + 0.18, x + 0.82, y + 0.82).stroke({ width: 0.9, color: p.brass, alpha: 0.45 });
    const k = iso(x, y);
    g.circle(k.x, k.y, 1.5).fill({ color: p.brass, alpha: 0.6 });
  },
  // A red carpet, gold edged, with gold stars down it.
  runner(g, p, r) {
    diamond(g, r.x + 0.08, r.y + 0.02, r.x + r.w - 0.08, r.y + r.h - 0.06).stroke({
      width: 3,
      color: p.runner.border,
    });
    for (let y = r.y + 0.5; y < r.y + r.h - 0.4; y += 1) {
      const c = iso(r.x + r.w / 2, y);
      const star: number[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rad = i % 2 ? 2.2 : 5;
        star.push(c.x + Math.cos(a) * rad, c.y + Math.sin(a) * rad * 0.55);
      }
      g.poly(star).fill({ color: p.runner.pattern, alpha: 0.95 });
    }
  },
  // Damask over a lacquer wainscot with gold mouldings, a gold rail and crown.
  walls(g, p, layout) {
    defaultArt.walls(g, p, layout);
    for (const [wall, len, color] of [
      ['A', layout.width, p.wallRight],
      ['B', layout.height, p.wallLeft],
    ] as const) {
      const rect = wall === 'A' ? rectA : rectB;
      const motif = mix(color, p.brass, 0.35);
      for (let h = 40, row = 0; h < 78; h += 12, row++)
        for (let u = row % 2 ? 0.25 : 0; u < len; u += 0.5) {
          const c = onWall(wall, u, h);
          g.poly([c.x, c.y - 4.5, c.x + 2.4, c.y, c.x, c.y + 4.5, c.x - 2.4, c.y]).fill({
            color: motif,
            alpha: 0.6,
          });
        }
      quad(g, rect(0, len, 6, 30)).fill(p.panel.face);
      for (let u = 0; u < len - 0.2; u += 1)
        quad(g, rect(u + 0.1, u + 0.9, 10, 26)).stroke({ width: 0.9, color: p.panel.frame, alpha: 0.8 });
      quad(g, rect(0, len, 30, 32.5)).fill(p.trim);
    }
  },
  // Velvet drapes, nearly drawn, under a scalloped valance.
  window(g, drapes, p, gy) {
    quad(g, rectB(gy, gy + 1.8, 28, 70))
      .fill(p.window)
      .stroke({ width: 2.5, color: p.windowFrame });
    const velvet = p.curtain;
    for (const [a, b, inner] of [
      [gy - 0.35, gy + 0.62, gy + 0.62],
      [gy + 1.18, gy + 2.15, gy + 1.18],
    ] as const) {
      quad(drapes, [wallB(a, 12), wallB(b, 12), wallB(b, 76), wallB(a, 76)]).fill(velvet);
      for (let u = a + 0.16; u < b - 0.05; u += 0.2) {
        const c = wallB(u, 14);
        const d = wallB(u, 74);
        drapes.moveTo(c.x, c.y).lineTo(d.x, d.y);
      }
      drapes.stroke({ width: 1.4, color: shade(velvet, 0.3), alpha: 0.7 });
      const tie = wallB(inner + (inner === b ? -0.12 : 0.12), 40);
      drapes.ellipse(tie.x, tie.y, 4, 2.2).fill(p.brass);
      drapes
        .moveTo(tie.x, tie.y + 2)
        .lineTo(tie.x, tie.y + 9)
        .stroke({ width: 1.2, color: p.brass });
    }
    // The valance: a scalloped band with a gold fringe.
    quad(drapes, rectB(gy - 0.4, gy + 2.2, 70, 80)).fill(shade(velvet, 0.1));
    for (let u = gy - 0.4; u < gy + 2.2 - 0.05; u += 0.26) {
      const pts: Pt[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI;
        pts.push(wallB(u + 0.13 - Math.cos(a) * 0.13, 70 - Math.sin(a) * 4));
      }
      drapes.poly(pts.flatMap((q) => [q.x, q.y])).fill(shade(velvet, 0.1));
      drapes
        .poly(
          pts.flatMap((q) => [q.x, q.y]),
          false,
        )
        .stroke({ width: 1, color: p.brass });
    }
    quad(drapes, rectB(gy - 0.42, gy + 2.22, 79, 81)).fill(p.brass);
  },
  view: skyline,
  // The neon sign's board: black, edged in gold. The suits glow on it (extras), so they can flicker.
  feature(g, p, x0, x1) {
    quad(g, rectA(x0 + 0.3, x1 - 0.3, 28, 70)).fill(p.brass);
    quad(g, rectA(x0 + 0.36, x1 - 0.36, 30, 68)).fill(0x0b080c);
    for (let u = x0 + 0.5; u < x1 - 0.4; u += 0.2) {
      for (const h of [32, 66]) {
        const c = wallA(u, h);
        g.circle(c.x, c.y, 0.9).fill(0xfff1c9);
      }
    }
  },
  // A VIP room: black lacquer panels with gold mouldings, tall mirrors either side of the door.
  suite(g, p, s) {
    quad(g, rectA(s.x0 - 0.2, s.x1, 0, 80)).fill(p.panel.face);
    for (let x = s.x0; x < s.x1; x++) {
      if (x === s.door) continue;
      quad(g, rectA(x + 0.12, x + 0.88, 8, 30)).stroke({ width: 1.2, color: p.panel.frame });
    }
    for (const [a, b] of [
      [s.x0 + 0.2, s.door - 0.45],
      [s.door + 1.45, s.x1 - 0.3],
    ] as const) {
      quad(g, rectA(a, b, 34, 76)).fill(p.panel.frame);
      quad(g, rectA(a + 0.06, b - 0.06, 36, 74)).fill(p.theme === 'dark' ? 0x2a3038 : 0xb9c3cf);
      const m = wallA(a + 0.2, 40);
      const n = wallA(Math.min(b - 0.1, a + 0.7), 72);
      g.moveTo(m.x, m.y).lineTo(n.x, n.y).stroke({ width: 3, color: 0xffffff, alpha: 0.12 });
    }
    quad(g, rectA(s.x0 - 0.2, s.x1, 76, 80)).fill(p.panel.frame);
    sconce(g, p, 'A', s.door - 0.25, 50);
    sconce(g, p, 'A', s.door + 1.25, 50);
  },
  // A padded leather door, buttoned in gold, a gold star over it; open, the glow of a private room.
  door(g, p, q, open) {
    quad(g, rectA(q - 0.08, q + 1.08, 0, 70)).fill(p.panel.frame);
    quad(g, rectA(q - 0.03, q + 1.03, 0, 67)).fill(p.doorFrame);
    if (open) {
      quad(g, rectA(q + 0.04, q + 0.96, 0, 66)).fill(0x1a0a10);
      const c = wallA(q + 0.5, 34);
      g.ellipse(c.x, c.y, 20, 28).fill({ color: p.glow, alpha: 0.26 });
      const l = wallA(q + 0.5, 56);
      for (const dx of [-6, 0, 6])
        g.ellipse(l.x + dx, l.y + (dx ? 0 : -2), 1.6, 3).fill(mix(p.glow, 0xffffff, 0.5));
    } else {
      quad(g, rectA(q + 0.04, q + 0.96, 0, 66)).fill(p.door);
      lattice(g, 'A', q + 0.04, 0.92, 0, 66, 10.6);
      g.stroke({ width: 0.8, color: shade(p.door, 0.35), alpha: 0.9 });
      for (let h = 8; h < 64; h += 8)
        for (let u = q + 0.12 + ((h / 8) % 2) * 0.075; u < q + 0.92; u += 0.15) {
          const c = wallA(u, h);
          g.circle(c.x, c.y, 0.8).fill(p.brass);
        }
      quad(g, rectA(q + 0.48, q + 0.52, 0, 66)).fill(shade(p.door, 0.4));
    }
    const s = wallA(q + 0.5, 72);
    const star: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 1.8 : 4.2;
      star.push(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r);
    }
    g.poly(star).fill(p.brass);
  },
  // Crystal sconces between the drapes and by the sign; the sign's neon suits.
  extras(g, p, layout, make) {
    const wins = windowsOf(layout);
    for (let i = 0; i + 1 < wins.length; i++) sconce(g, p, 'B', (wins[i]! + 1.8 + wins[i + 1]!) / 2, 52);
    const span = featureSpan(layout);
    if (!span) return;
    sconce(g, p, 'A', span.x0 - 0.3, 52);
    sconce(g, p, 'A', span.x1 + 0.3, 52);
    const sign = make();
    const kinds = ['spade', 'heart', 'diamond', 'club'] as const;
    const step = (span.x1 - span.x0 - 1.2) / 4;
    const motion: Motion = {
      g: sign,
      draw(t) {
        sign.clear();
        kinds.forEach((kind, i) => {
          const u = span.x0 + 0.6 + step * (i + 0.5);
          // Now and then a tube stutters.
          const lit = t && i === Math.floor(t / 2400) % 4 && t % 2400 < 260 ? 0.25 : 1;
          for (const loop of suit(kind, 26))
            neon(
              sign,
              loop.map(([dx, dy]) => wallA(u + dx / ALONG, 49 + dy)),
              kind === 'heart' || kind === 'diamond' ? NEON_PINK : NEON_WHITE,
              lit,
            );
        });
      },
    };
    return [motion];
  },
  // Smoked glass on gold rails, gold posts with ball finials.
  partition(g, p, e) {
    const a = iso(e.x0, e.y0);
    const b = iso(e.x1, e.y1);
    quad(g, [a, b, { x: b.x, y: b.y - GLASS_H }, { x: a.x, y: a.y - GLASS_H }]).fill({
      color: p.glass.pane,
      alpha: p.theme === 'dark' ? 0.3 : 0.26,
    });
    g.moveTo(a.x, a.y - GLASS_H)
      .lineTo(b.x, b.y - GLASS_H)
      .stroke({ width: 2.2, color: p.glass.rail });
    g.moveTo(a.x, a.y - 1)
      .lineTo(b.x, b.y - 1)
      .stroke({ width: 1.6, color: p.glass.rail, alpha: 0.8 });
    g.rect(a.x - 1.1, a.y - GLASS_H, 2.2, GLASS_H).fill(p.glass.rail);
    g.circle(a.x, a.y - GLASS_H - 2, 2.2).fill(tint(p.glass.rail, 0.2));
  },
  // Gold posts, a lintel lined with marquee bulbs.
  doorway(g, p, t) {
    const a = iso(t.doorway.x0, t.doorway.y);
    const b = iso(t.doorway.x1, t.doorway.y);
    for (const q of [a, b]) {
      g.rect(q.x - 1.6, q.y - GLASS_H - 12, 3.2, GLASS_H + 12).fill(p.glass.rail);
      g.circle(q.x, q.y - GLASS_H - 15, 2.6).fill(tint(p.glass.rail, 0.2));
    }
    g.moveTo(a.x, a.y - GLASS_H - 12)
      .lineTo(b.x, b.y - GLASS_H - 12)
      .stroke({ width: 4, color: shade(p.glass.rail, 0.2) });
    for (let k = 0.1; k < 0.95; k += 0.1) {
      const q = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k - GLASS_H - 12 };
      g.circle(q.x, q.y, 1).fill(0xfff1c9);
    }
  },
  // A palm in a gold planter.
  plant(g, p, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
    box(g, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 13, faces(p.plant.pot, 0.25, 0.3));
    g.moveTo(c.x, c.y - 13)
      .quadraticCurveTo(c.x - 3, c.y - 26, c.x + 1, c.y - 38)
      .stroke({ width: 3, color: 0x6b4a2e, cap: 'round' });
    const top = { x: c.x + 1, y: c.y - 38 };
    for (const [dx, dy, light] of [
      [-16, 6, false],
      [16, 5, false],
      [-12, -6, true],
      [13, -7, true],
      [-3, -12, false],
      [6, 10, true],
    ] as const)
      g.moveTo(top.x, top.y)
        .quadraticCurveTo(top.x + dx * 0.5, top.y + dy - 8, top.x + dx, top.y + dy)
        .stroke({ width: 3.2, color: light ? p.plant.leafLight : p.plant.leaf, cap: 'round' });
  },
  // A lacquer side table with a gold lamp under a red shade.
  lamp(g, p, f) {
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y + 1, 22, 10).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.1 : 0.05 });
    box(g, f.x + 0.2, f.y + 0.2, f.x + 0.8, f.y + 0.8, 18, p.wood);
    g.ellipse(c.x, c.y - 19, 5, 2.4).fill(p.brass);
    g.rect(c.x - 1, c.y - 34, 2, 15).fill(p.brass);
    glow(g, c.x, c.y - 40, 22, p.glow, p.theme === 'dark' ? 0.22 : 0.1);
    g.poly([c.x - 9, c.y - 32, c.x + 9, c.y - 32, c.x + 6, c.y - 44, c.x - 6, c.y - 44]).fill(0x9a1428);
    for (const dx of [-5, 0, 5])
      g.rect(c.x + dx - 0.4, c.y - 43, 0.8, 10).fill({ color: 0x000000, alpha: 0.15 });
    g.rect(c.x - 9, c.y - 33, 18, 1.4).fill(p.brass);
  },
  // Two slot machines where the foosball was.
  foosball(g, p, f, i) {
    slotMachine(g, p, f.x + i, f.y, i);
  },
  // The roulette table: felt on a lacquer frame, the wheel at the far end, the layout and chips below.
  poolTable(g, p, f, dx, dy) {
    const { lx0, lx1, ly0, ly1 } = poolTileEdges(f, dx, dy);
    if ((dx === 0 || dx === f.w - 1) && (dy === 0 || dy === f.h - 1)) {
      const lx = dx === 0 ? lx0 + 0.08 : lx1 - 0.16;
      const ly = dy === 0 ? ly0 + 0.08 : ly1 - 0.16;
      box(g, lx, ly, lx + 0.08, ly + 0.08, 16, p.wood);
    }
    box(g, lx0, ly0, lx1, ly1, 6, p.wood, 16);
    const fx0 = dx === 0 ? lx0 + 0.1 : lx0;
    const fx1 = dx === f.w - 1 ? lx1 - 0.1 : lx1;
    const fy0 = dy === 0 ? ly0 + 0.1 : ly0;
    const fy1 = dy === f.h - 1 ? ly1 - 0.1 : ly1;
    diamond(g, fx0, fy0, fx1, fy1, 22).fill(p.felt);
    if (dy > 0) {
      // The betting layout: a grid of red and black squares in white lines.
      const cells = 3;
      for (let i = 0; i < cells; i++)
        for (let j = 0; j < cells; j++) {
          const x0 = fx0 + 0.08 + (i * (fx1 - fx0 - 0.16)) / cells;
          const y0 = fy0 + 0.08 + (j * (fy1 - fy0 - 0.16)) / cells;
          const x1 = x0 + (fx1 - fx0 - 0.16) / cells;
          const y1 = y0 + (fy1 - fy0 - 0.16) / cells;
          diamond(g, x0 + 0.03, y0 + 0.03, x1 - 0.03, y1 - 0.03, 22).fill({
            color: (i + j + dx) % 2 ? 0xa8142a : 0x141014,
            alpha: 0.85,
          });
        }
      for (let i = 0; i <= cells; i++) {
        const u = fx0 + 0.08 + (i * (fx1 - fx0 - 0.16)) / cells;
        const v = fy0 + 0.08 + (i * (fy1 - fy0 - 0.16)) / cells;
        floorLine(g, u, fy0 + 0.08, u, fy1 - 0.08, 22.2);
        floorLine(g, fx0 + 0.08, v, fx1 - 0.08, v, 22.2);
      }
      g.stroke({ width: 0.7, color: 0xf4f1e6, alpha: 0.85 });
      if (dy === f.h - 1) {
        chips(g, f.x + dx + 0.35, f.y + dy + 0.45, 22, dx ? 0x2a6ad8 : 0xe0a526, 4);
        chips(g, f.x + dx + 0.62, f.y + dy + 0.3, 22, 0xc0182a, 2);
      }
    }
    if (dy === 0 && dx === f.w - 1) wheel(g, p, f.x + 1, f.y + 0.55, 23);
  },
  // The croupier's chip rack.
  cueRack(g, p, f) {
    box(g, f.x + 0.12, f.y + 0.25, f.x + 0.4, f.y + 0.75, 16, p.wood);
    const colors = [0xc0182a, 0x161214, 0x168a4a, 0x2a6ad8, 0xe0a526];
    colors.forEach((color, k) => chips(g, f.x + 0.26, f.y + 0.3 + k * 0.1, 16, color, 3));
  },
  // A cocktail table: black lacquer, a gold rim, a glass and a few chips.
  table(g, p, f) {
    defaultArt.table(g, p, f);
    const c = iso(f.x + 0.5, f.y + 0.5);
    g.ellipse(c.x, c.y - 17, 25, 12.5).stroke({ width: 1.2, color: p.brass });
    const m = iso(f.x + 0.38, f.y + 0.36);
    g.poly([m.x - 3, m.y - 25, m.x + 3, m.y - 25, m.x, m.y - 21]).fill({ color: 0xdbe9ff, alpha: 0.8 });
    g.rect(m.x - 0.4, m.y - 21, 0.8, 4).fill(0xdbe9ff);
    chips(g, f.x + 0.66, f.y + 0.6, 17, 0x161214, 3);
  },
};

export const highRoller: OfficeTheme = {
  id: 'high-roller',
  name: 'High Roller',
  blurb: 'Felt, gold and neon',
  thumb: { floor: 'pattern', accent: { dark: NEON_PINK, light: 0xd4af37 } },
  art,
  colours: {
    dark: {
      corridor: [0x3d0f1c, 0x420f1e],
      seam: 0x1f0610,
      pantry: [0x26262b, 0x1f1f24],
      lounge: [0x0f3324, 0x0e3022],
      kitchen: {
        floor: [0x2b2b30, 0x222226],
        iron: { top: 0x2c2f34, left: 0x1f2125, right: 0x16181b },
        tile: 0x2b2b30,
        grout: 0x3a3a40,
        block: 0x5a3a2a,
        cabinet: { left: 0x1f1f23, right: 0x18181b },
        copper: 0xb5683f,
      },
      carpets: [
        [0x1d2a4a, 0x202d4e],
        [0x14402e, 0x174431],
        [0x4a1428, 0x4e172b],
        [0x3a1d4a, 0x3e204e],
        [0x4a3a12, 0x4e3d15],
        [0x0f3f44, 0x124348],
      ],
      wallLeft: 0x2a1220,
      wallRight: 0x321626,
      wallTop: 0x1a0a12,
      trim: 0xb8912e,
      baseboard: 0x140810,
      window: 0x0f1626,
      windowFrame: 0xb8912e,
      glass: { pane: 0x5a4a52, rail: 0xc9a440 },
      curtain: 0x6e0f1e,
      wood: { top: 0x5a2a22, left: 0x45201a, right: 0x381a15 },
      metal: { top: 0x8a8d94, left: 0x6e7178, right: 0x5a5d63 },
      monitor: 0x111214,
      screen: 0x3d7fc4,
      chair: 0x5a1020,
      plant: { pot: 0xb8912e, leaf: 0x2f6a3a, leafLight: 0x4a8a4c },
      fridge: { top: 0x2a2a2e, left: 0x1f1f23, right: 0x18181b },
      sofa: { seat: 0x6e0f1e, back: 0x5a0c18 },
      felt: 0x0f6b3a,
      door: 0x5a0f1e,
      doorFrame: 0x1a0a12,
      brass: 0xd4af37,
      sign: 0x140810,
      signText: 0xf3d98a,
      panel: { face: 0x141014, frame: 0xb8912e, shadow: 0x0a080a },
      rope: 0x8c1024,
      runner: { base: 0x4a0a16, border: 0xd4af37, pattern: 0xb8912e },
      glow: 0xffd9a0,
      map: { paper: 0xe8dcc0, land: 0x6b4a2a, frame: 0xb8912e },
      board: { frame: 0xb8912e },
      books: [0x6e0f1e, 0xd4af37, 0x1d2a4a, 0x14402e, 0x3a1d4a, 0x2a2a2e],
      shadow: 0x000000,
    },
    light: {
      corridor: [0x4a1424, 0x4e1627],
      seam: 0x2a0812,
      pantry: [0xece8e0, 0xe0dad0],
      lounge: [0x0c3220, 0x0b2f1e],
      kitchen: {
        floor: [0xe6e1d8, 0xc4c8ce],
        iron: { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
        tile: 0xf2eee8,
        grout: 0xd8d2c8,
        block: 0x8a5a3a,
        cabinet: { left: 0x3a1a20, right: 0x2e141a },
        copper: 0xc0703f,
      },
      carpets: [
        [0xc9d0e8, 0xc3cae2],
        [0xc4e0d0, 0xbedaca],
        [0xe8c9d2, 0xe2c3cc],
        [0xd8c9e8, 0xd2c3e2],
        [0xece0b8, 0xe6dab2],
        [0xbfe0e2, 0xb9dadc],
      ],
      wallLeft: 0x5a1a2e,
      wallRight: 0x66203a,
      wallTop: 0x3a0f1e,
      trim: 0xd4af37,
      baseboard: 0x2a0812,
      window: 0xd9e6f2,
      windowFrame: 0xd4af37,
      glass: { pane: 0x8a7a82, rail: 0xd4af37 },
      curtain: 0x8c1428,
      wood: { top: 0x6e3426, left: 0x58291e, right: 0x482218 },
      metal: { top: 0xc9ccd2, left: 0xb0b4ba, right: 0x9a9ea5 },
      monitor: 0x2b2e35,
      screen: 0x8fc4f5,
      chair: 0x8c1428,
      plant: { pot: 0xd4af37, leaf: 0x3a8a4a, leafLight: 0x5aaa5c },
      fridge: { top: 0x3a3a40, left: 0x2b2b30, right: 0x222226 },
      sofa: { seat: 0x8c1428, back: 0x741020 },
      felt: 0x14824a,
      door: 0x7a1428,
      doorFrame: 0x3a0f1e,
      brass: 0xd4af37,
      sign: 0x1f0a12,
      signText: 0xf3d98a,
      panel: { face: 0x1a1418, frame: 0xd4af37, shadow: 0x0e0a0c },
      rope: 0x9a1428,
      runner: { base: 0x3a0810, border: 0xd4af37, pattern: 0xc99a2e },
      glow: 0xffe0b0,
      map: { paper: 0xe8dcc0, land: 0x6b4a2a, frame: 0xd4af37 },
      board: { frame: 0xd4af37 },
      books: [0x8c1428, 0xd4af37, 0x1d2a4a, 0x14402e, 0x3a1d4a, 0x2a2a2e],
      shadow: 0x2a2d35,
    },
  },
};
