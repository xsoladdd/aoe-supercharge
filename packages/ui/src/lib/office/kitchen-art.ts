import { Container, Graphics } from 'pixi.js';
import type { CounterPlace, Furniture, OfficeLayout, Tile } from '@aoe-supercharge/core/shared';
import { box, diamond, iso, quad, shade, tint, wallA, type Pt } from './iso';
import type { Palette } from './palette';

/**
 * The kitchen's art (SPEC §14.5), in the study's style: cast-iron ranges with brass trim under an iron
 * hood, a tiled splashback, a butcher-block island on dark cabinets, an enamel sink. While someone
 * cooks, its range has a copper pot with steam and a recipe card; whoever chops has a board on the
 * island; whoever was served has a plate on the pantry table.
 */

/** The ranges' and the island's height, in px. */
const RANGE_H = 26;
const ISLAND_H = 24;
/** The pantry tables' top, in px (see `table` in art.ts). */
const TABLE_H = 17;

const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });

/** The splashback, the hood over the ranges and a rail of hanging copper pans: on the back wall. */
export function drawKitchenWall(g: Graphics, layout: OfficeLayout, p: Palette) {
  const k = layout.kitchen.area;
  const x0 = k.x;
  const x1 = k.x + k.w;
  const pts = (a: number, b: number, h0: number, h1: number) => [
    wallA(a, h0),
    wallA(b, h0),
    wallA(b, h1),
    wallA(a, h1),
  ];
  // Subway tiles from the worktop up to the hood.
  quad(g, pts(x0 + 0.05, x1 - 0.05, 6, 58)).fill(p.kitchen.tile);
  for (let h = 12; h < 58; h += 6) {
    const a = wallA(x0 + 0.05, h);
    const b = wallA(x1 - 0.05, h);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 0.7, color: p.kitchen.grout });
  }
  for (let row = 0; row < 9; row++)
    for (let u = x0 + 0.05 + (row % 2) * 0.17; u < x1 - 0.1; u += 0.34) {
      const a = wallA(u, 6 + row * 6);
      const b = wallA(u, 12 + row * 6);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 0.6, color: p.kitchen.grout });
    }
  // The hood: cast iron over the five ranges, a brass band along its lip.
  const r = layout.kitchen.stoves;
  const h0 = r[0]!.range.x + 0.02;
  const h1 = r[r.length - 1]!.range.x + 0.98;
  box(g, h0, 0, h1, 0.42, 16, p.kitchen.iron, 60);
  const lipA = up(iso(h0, 0.42), 60);
  const lipB = up(iso(h1, 0.42), 60);
  const lipC = up(iso(h1, 0), 60);
  g.moveTo(lipA.x, lipA.y - 2)
    .lineTo(lipB.x, lipB.y - 2)
    .lineTo(lipC.x, lipC.y - 2)
    .stroke({ width: 2, color: p.brass });
  quad(g, pts(h0 + 0.3, h1 - 0.3, 76, 86)).fill(shade(p.kitchen.iron.left, 0.1));
  // A brass rail with copper pans, over the corner by the pantry.
  const a = wallA(x0 + 0.12, 50);
  const b = wallA(x0 + 0.92, 50);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.6, color: p.brass });
  for (const [u, rad] of [
    [0.3, 5],
    [0.55, 4],
    [0.78, 3.2],
  ] as const) {
    const hook = wallA(x0 + u, 50);
    g.moveTo(hook.x, hook.y)
      .lineTo(hook.x, hook.y + 4)
      .stroke({ width: 0.8, color: p.brass });
    g.circle(hook.x, hook.y + 4 + rad, rad)
      .fill(p.kitchen.copper)
      .stroke({ width: 0.8, color: shade(p.kitchen.copper, 0.35) });
    g.moveTo(hook.x, hook.y + 4 + rad * 2)
      .lineTo(hook.x, hook.y + 9 + rad * 2)
      .stroke({ width: 1.4, color: shade(p.kitchen.copper, 0.3) });
  }
}

/** A cast-iron range: an oven door with a brass rail, brass knobs, two burners and a back guard. */
export function rangePiece(p: Palette, f: Furniture): Graphics {
  const g = new Graphics();
  const { x, y } = f;
  const iron = p.kitchen.iron;
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y + 2, 26, 11).fill({ color: p.shadow, alpha: 0.18 });
  box(g, x + 0.06, y + 0.12, x + 0.94, y + 0.94, RANGE_H, iron);
  // The back guard, brass-capped.
  box(
    g,
    x + 0.06,
    y + 0.02,
    x + 0.94,
    y + 0.14,
    9,
    { top: p.brass, left: iron.left, right: iron.right },
    RANGE_H,
  );
  // The oven door on the front face, its brass rail across the top, and the knobs above.
  const face = (u: number, h: number) => up(iso(x + u, y + 0.94), h);
  quad(g, [face(0.18, 4), face(0.82, 4), face(0.82, 17), face(0.18, 17)]).fill(shade(iron.left, 0.35));
  quad(g, [face(0.3, 7), face(0.7, 7), face(0.7, 14), face(0.3, 14)]).fill({ color: p.glow, alpha: 0.12 });
  const r0 = face(0.14, 19.5);
  const r1 = face(0.86, 19.5);
  g.moveTo(r0.x, r0.y).lineTo(r1.x, r1.y).stroke({ width: 2, color: p.brass, cap: 'round' });
  for (const u of [0.22, 0.4, 0.6, 0.78]) {
    const k = face(u, 23);
    g.circle(k.x, k.y, 1.5).fill(p.brass);
  }
  // Two burners on the cooktop, the near one where the pot goes.
  for (const [u, v, rx] of [
    [0.34, 0.4, 7],
    [0.66, 0.62, 6],
  ] as const) {
    const b = up(iso(x + u, y + v), RANGE_H);
    g.ellipse(b.x, b.y, rx, rx / 2).stroke({ width: 1.6, color: shade(iron.top, 0.5) });
    g.ellipse(b.x, b.y, rx * 0.45, rx * 0.22).fill(shade(iron.top, 0.4));
  }
  return g;
}

/** The enamel sink on an iron cabinet, with a brass gooseneck tap. */
export function sinkPiece(p: Palette, f: Furniture): Graphics {
  const g = new Graphics();
  const { x, y } = f;
  box(g, x + 0.06, y + 0.1, x + 0.94, y + 0.94, ISLAND_H, {
    top: p.kitchen.block,
    left: p.kitchen.cabinet.left,
    right: p.kitchen.cabinet.right,
  });
  diamond(g, x + 0.2, y + 0.24, x + 0.8, y + 0.8, ISLAND_H).fill(0xf2f2ee);
  diamond(g, x + 0.28, y + 0.32, x + 0.72, y + 0.72, ISLAND_H).fill(0xd8dbdc);
  const base = up(iso(x + 0.5, y + 0.18), ISLAND_H);
  g.moveTo(base.x, base.y)
    .lineTo(base.x, base.y - 12)
    .quadraticCurveTo(base.x, base.y - 17, base.x - 5, base.y - 15)
    .stroke({ width: 1.8, color: p.brass, cap: 'round' });
  const m = up(iso(x + 0.5, y + 0.94), 12);
  g.rect(m.x - 1, m.y - 4, 2, 7).fill(p.brass);
  return g;
}

/** One tile of the prep island: butcher block on a dark cabinet with a brass pull. */
export function islandPiece(p: Palette, x: number, y: number): Graphics {
  const g = new Graphics();
  box(g, x, y + 0.1, x + 1, y + 0.9, ISLAND_H, {
    top: p.kitchen.block,
    left: p.kitchen.cabinet.left,
    right: p.kitchen.cabinet.right,
  });
  // The block's strips, and its edge.
  for (const v of [0.3, 0.5, 0.7]) {
    const a = up(iso(x, y + v), ISLAND_H);
    const b = up(iso(x + 1, y + v), ISLAND_H);
    g.moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({ width: 0.6, color: shade(p.kitchen.block, 0.18), alpha: 0.7 });
  }
  const e0 = up(iso(x, y + 0.9), ISLAND_H - 2.5);
  const e1 = up(iso(x + 1, y + 0.9), ISLAND_H - 2.5);
  g.moveTo(e0.x, e0.y)
    .lineTo(e1.x, e1.y)
    .stroke({ width: 1, color: shade(p.kitchen.block, 0.3) });
  const m = up(iso(x + 0.5, y + 0.9), 12);
  g.roundRect(m.x - 4, m.y - 1, 8, 2, 1).fill(p.brass);
  return g;
}

/** What sits on a range while someone cooks: a copper pot on the lit burner, steam, a recipe card. */
export interface PotArt {
  piece: Graphics;
  steam: Graphics;
}

export function potArt(p: Palette, range: Tile): PotArt {
  const g = new Graphics();
  const { x, y } = range;
  const b = up(iso(x + 0.34, y + 0.4), RANGE_H);
  // The burner's glow round the pot's foot.
  g.ellipse(b.x, b.y + 1, 9.5, 4.2).fill({ color: p.glow, alpha: 0.55 });
  g.ellipse(b.x, b.y + 1, 6.5, 2.8).fill({ color: 0xff8a3d, alpha: 0.5 });
  // The pot: copper, with iron handles and a dark rim, soup inside.
  const copper = p.kitchen.copper;
  const top = b.y - 12;
  g.ellipse(b.x, b.y, 8.5, 3.6).fill(shade(copper, 0.25));
  g.rect(b.x - 8.5, top, 17, 12).fill(copper);
  g.rect(b.x - 8.5, top, 4, 12).fill({ color: tint(copper, 0.25), alpha: 0.6 });
  g.rect(b.x + 4, top, 4.5, 12).fill({ color: shade(copper, 0.2), alpha: 0.6 });
  g.ellipse(b.x, top, 8.5, 3.6).fill(shade(copper, 0.4));
  g.ellipse(b.x, top + 0.4, 7, 2.8).fill(0xd9824a);
  g.circle(b.x - 2.5, top + 0.2, 0.9).fill(0x6fbf73);
  g.circle(b.x + 2, top + 0.8, 0.8).fill(0xf2c14e);
  for (const s of [-1, 1]) g.roundRect(b.x + s * 9 - 2, top + 2.5, 4, 2.2, 1).fill(p.kitchen.iron.top);
  // A recipe card propped against the back guard.
  const card = (u: number, h: number) => up(iso(x + u, y + 0.16), h);
  quad(g, [
    card(0.58, RANGE_H + 2),
    card(0.88, RANGE_H + 2),
    card(0.86, RANGE_H + 15),
    card(0.6, RANGE_H + 15),
  ])
    .fill(0xf6eedb)
    .stroke({ width: 0.7, color: 0xb9a888 });
  for (const [h, w] of [
    [RANGE_H + 12, 0.2],
    [RANGE_H + 9, 0.16],
    [RANGE_H + 6, 0.18],
  ] as const) {
    const a = card(0.64, h);
    const c = card(0.64 + w, h);
    g.moveTo(a.x, a.y).lineTo(c.x, c.y).stroke({ width: 0.7, color: 0x8a6a48 });
  }
  const steam = new Graphics();
  drawSteam(steam, p, { x: b.x, y: top }, 0);
  return { piece: g, steam };
}

/** Wisps of steam over a pot at `at`; `t` (radians) makes them rise and sway. */
export function drawSteam(g: Graphics, p: Palette, at: Pt, t: number) {
  g.clear();
  // As the mug's steam: pale on the dark study, grey on the light tiles.
  const color = p.theme === 'dark' ? 0xd9dce2 : 0x9aa0aa;
  for (const [dx, k] of [
    [-3.5, 0],
    [0.5, 2.1],
    [4, 4.2],
  ] as const) {
    const rise = ((t + k) % (Math.PI * 2)) / (Math.PI * 2);
    const y0 = at.y - 3 - rise * 3;
    const sway = Math.sin(t * 0.8 + k) * 1.2;
    g.moveTo(at.x + dx, y0)
      .quadraticCurveTo(at.x + dx - 2.5 + sway, y0 - 5, at.x + dx + sway, y0 - 9)
      .quadraticCurveTo(at.x + dx + 2.5 + sway, y0 - 13, at.x + dx + sway * 0.5, y0 - 16)
      .stroke({ width: 1.4, color, alpha: 0.75 - rise * 0.35, cap: 'round' });
  }
}

/** Where the pot's steam rises from, for `drawSteam`. */
export function steamAt(range: Tile): Pt {
  const b = up(iso(range.x + 0.34, range.y + 0.4), RANGE_H);
  return { x: b.x, y: b.y - 12 };
}

/** A cutting board on the island in front of whoever chops there, with something half chopped. */
export function cuttingBoard(place: CounterPlace): Graphics {
  const g = new Graphics();
  const b = place.board!;
  // Its middle, pulled towards whoever stands at it.
  const cx = b.x + 0.5 - place.face[0] * 0.18;
  const cy = b.y + 0.5 - place.face[1] * 0.18;
  diamond(g, cx - 0.22, cy - 0.16, cx + 0.22, cy + 0.16, ISLAND_H + 1.5).fill(shade(0xd9b382, 0.25));
  diamond(g, cx - 0.22, cy - 0.16, cx + 0.22, cy + 0.16, ISLAND_H + 2.5).fill(0xe2bf8d);
  const m = up(iso(cx, cy), ISLAND_H + 2.5);
  for (const [dx, dy, c] of [
    [-5, 0, 0xf28c38],
    [-2.5, 1, 0xf28c38],
    [2, -0.5, 0x6fbf73],
    [4.5, 0.5, 0x6fbf73],
    [0, 1.5, 0xf2c14e],
  ] as const)
    g.circle(m.x + dx, m.y + dy, 1.1).fill(c);
  return g;
}

/** A served plate on a pantry table, on the side of whoever eats it: a hearty plan, and a fork. */
export function plateArt(p: Palette, table: Tile, seat: Tile): { piece: Graphics; at: Pt; hit: Pt[] } {
  const g = new Graphics();
  const dx = Math.sign(seat.x - table.x);
  const dy = Math.sign(seat.y - table.y);
  const at = up(iso(table.x + 0.5 + dx * 0.28, table.y + 0.5 + dy * 0.28), TABLE_H + 1);
  g.ellipse(at.x, at.y + 0.8, 8, 3.6).fill({ color: p.shadow, alpha: 0.2 });
  g.ellipse(at.x, at.y, 8, 3.6).fill(0xffffff).stroke({ width: 0.8, color: 0xd8d2c6 });
  g.ellipse(at.x, at.y, 5.4, 2.3).stroke({ width: 0.5, color: 0xe6e1d6 });
  g.ellipse(at.x - 0.5, at.y - 0.6, 3.8, 1.7).fill(0xd9824a);
  g.circle(at.x - 2.2, at.y - 1, 0.9).fill(0x6fbf73);
  g.circle(at.x + 1.6, at.y - 0.8, 0.8).fill(0xf2c14e);
  g.moveTo(at.x + 8.5, at.y + 1)
    .lineTo(at.x + 11.5, at.y - 2)
    .stroke({ width: 0.9, color: 0xc9ced6, cap: 'round' });
  const hit = [
    { x: at.x - 10, y: at.y - 6 },
    { x: at.x + 12, y: at.y - 6 },
    { x: at.x + 12, y: at.y + 5 },
    { x: at.x - 10, y: at.y + 5 },
  ];
  return { piece: g, at, hit };
}

/** The label over a hovered plate (`t`: whose plan it is, and for what) on a nameplate. */
export function plateLabel(t: Container, p: Palette): Container {
  const c = new Container();
  const bg = new Graphics()
    .roundRect(-t.width / 2 - 6, -t.height / 2 - 3, t.width + 12, t.height + 6, 5)
    .fill({ color: p.nameplate, alpha: 0.92 })
    .stroke({ width: 1, color: p.brass, alpha: 0.8 });
  c.addChild(bg, t);
  return c;
}
