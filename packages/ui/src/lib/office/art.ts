import { Container, Graphics, Text } from 'pixi.js';
import {
  DOOR_BOARD,
  fnv1a,
  roomBoardId,
  type Edge,
  type Furniture,
  type OfficeLayout,
  type Rect,
  type TeamPlan,
  type WindowLook,
} from '@aoe-supercharge/core/shared';
import { box, depth, diamond, iso, mix, quad, shade, tint, wallA, wallB, WALL_H, type Pt } from './iso';
import { drawKitchenWall, islandPiece, rangePiece, sinkPiece } from './kitchen-art';
import type { Palette } from './palette';
import type { FloorTile, Motion, OfficeTheme, SuiteSpot, ThemeArt } from './themes/types';

/**
 * The office that does not move: floors, walls, your door, furniture. Everything is drawn with
 * vectors, so it stays sharp at any zoom (SPEC §14.5).
 */

export const FONT = '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif';

export function label(text: string, size: number, color: number, weight: '500' | '600' | '700' = '600') {
  return new Text({
    text,
    style: { fontFamily: FONT, fontSize: size, fontWeight: weight, fill: color },
    resolution: 4,
    anchor: 0.5,
  });
}

export interface StaticOffice {
  floor: Graphics;
  walls: Container;
  /** Furniture pieces for the sorted object layer, each with its zIndex set. */
  pieces: Container[];
  door: { graphics: Graphics; hit: Pt[]; setOpen: (open: boolean) => void };
  /** Little "Back later" cards, one per desk, shown while its worker is away. */
  awaySigns: Map<string, Graphics>;
  /** Where each window starts along the left wall (in tiles); the sky is drawn into them (`drawSky`). */
  windows: number[];
  /** The layer between the panes and the curtains that `drawSky` draws on. */
  sky: Graphics;
  /** The room whiteboards' writing layers, by board id; the scene writes on them (`BoardSpot`). */
  roomBoards: Map<string, Container>;
  /** The theme's small moving bits (flames, flickers), drawn at rest; the scene moves them now and then. */
  motion: Motion[];
}

/**
 * Where a whiteboard hangs, for the scene to write on: `at(u, h)` is the point `u` tiles along the
 * board (left to right on screen) and `h` px up; `slope` is the way the writing runs on screen.
 */
export interface BoardSpot {
  id: string;
  /** The project it belongs to; null for the one by your door. */
  project: string | null;
  at: (u: number, h: number) => Pt;
  length: number;
  bottom: number;
  top: number;
  slope: 1 | -1;
}

/** Every whiteboard in the office: the one by your door, then one against each room's left glass. */
export function boardSpots(layout: OfficeLayout): BoardSpot[] {
  const { x0, x1 } = layout.board;
  const door: BoardSpot = {
    id: DOOR_BOARD,
    project: null,
    at: (u, h) => wallA(x0 + u, h),
    length: x1 - x0,
    ...BOARD_H,
    slope: 1,
  };
  const rooms = layout.teams.map<BoardSpot>((t) => ({
    id: roomBoardId(t.project),
    project: t.project,
    // Facing east, so it reads left to right as y falls.
    at: (u, h) => {
      const q = iso(t.board.x, t.board.y1 - u);
      return { x: q.x, y: q.y - h };
    },
    length: t.board.y1 - t.board.y0,
    ...ROOM_BOARD_H,
    slope: -1,
  }));
  return [door, ...rooms];
}

const teamColor = (p: Palette, index: number) => p.carpets[index % p.carpets.length]!;

function floorKind(layout: OfficeLayout, x: number, y: number) {
  for (const f of layout.floors) {
    const r = f.rect;
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return f;
  }
  return null;
}

/** Hardwood: three planks per tile running along the back wall, each a slightly different tone, with seams. */
function planks(g: Graphics, p: Palette, x: number, y: number) {
  for (let k = 0; k < 3; k++) {
    const h = fnv1a(`${x},${y},${k}`);
    diamond(g, x, y + k / 3, x + 1, y + (k + 1) / 3).fill(mix(p.corridor[0], p.corridor[1], (h % 100) / 100));
    const a = iso(x, y + k / 3);
    const b = iso(x + 1, y + k / 3);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 0.8, color: p.seam, alpha: 0.55 });
    // Staggered ends.
    const e = (h >> 8) % 4;
    if (e < 2) {
      const c = iso(x + 0.3 + e * 0.35, y + k / 3);
      const d = iso(x + 0.3 + e * 0.35, y + (k + 1) / 3);
      g.moveTo(c.x, c.y).lineTo(d.x, d.y).stroke({ width: 0.8, color: p.seam, alpha: 0.45 });
    }
  }
}

function floorTile(g: Graphics, p: Palette, x: number, y: number, tile: FloorTile) {
  if (tile.kind === 'open') planks(g, p, x, y);
  else diamond(g, x, y, x + 1, y + 1).fill(tile.tones[(x + y) % 2]!);
}

/** A team's rug: a border band and an inner line, a shade off its colour. */
function rug(g: Graphics, p: Palette, area: Rect, c: number) {
  const { x, y, w, h } = area;
  const edge = p.theme === 'dark' ? tint(c, 0.14) : shade(c, 0.14);
  diamond(g, x + 0.1, y + 0.1, x + w - 0.1, y + h - 0.1).stroke({ width: 5, color: edge, alpha: 0.9 });
  diamond(g, x + 0.32, y + 0.32, x + w - 0.32, y + h - 0.32).stroke({ width: 1, color: edge, alpha: 0.7 });
}

/** The runner out from your door: a border, and a lozenge pattern down the middle. */
function runner(g: Graphics, p: Palette, r: Rect) {
  diamond(g, r.x + 0.1, r.y + 0.04, r.x + r.w - 0.1, r.y + r.h - 0.1).stroke({
    width: 3,
    color: p.runner.border,
  });
  diamond(g, r.x + 0.26, r.y + 0.2, r.x + r.w - 0.26, r.y + r.h - 0.26).stroke({
    width: 1,
    color: p.runner.border,
    alpha: 0.8,
  });
  for (let x = r.x + 0.5; x < r.x + r.w - 0.4; x += 1)
    for (let y = r.y + 0.5; y < r.y + r.h - 0.4; y += 1)
      diamond(g, x - 0.1, y - 0.1, x + 0.1, y + 0.1).fill({ color: p.runner.pattern, alpha: 0.9 });
}

/** Which zone a tile is in, and its tones. */
function tileAt(
  layout: OfficeLayout,
  p: Palette,
  teamIndex: Map<string, number>,
  x: number,
  y: number,
): FloorTile {
  const f = floorKind(layout, x, y);
  if (!f) return { kind: 'open', rect: null, tones: p.corridor };
  const tones: [number, number] =
    f.kind === 'carpet'
      ? teamColor(p, teamIndex.get(f.team ?? '') ?? 0)
      : f.kind === 'pantry'
        ? p.pantry
        : f.kind === 'kitchen'
          ? p.kitchen.floor
          : f.kind === 'lounge'
            ? p.lounge
            : [p.runner.base, p.runner.base];
  return { kind: f.kind, rect: f.rect, tones };
}

function drawFloor(layout: OfficeLayout, p: Palette, kit: ThemeArt): Graphics {
  const g = new Graphics();
  const teamIndex = new Map(layout.teams.map((t, i) => [t.project, i]));
  for (let y = 0; y < layout.height; y++)
    for (let x = 0; x < layout.width; x++) kit.floor(g, p, x, y, tileAt(layout, p, teamIndex, x, y));
  for (const t of layout.teams) kit.rug(g, p, t.area, teamColor(p, teamIndex.get(t.project) ?? 0)[0]);
  kit.runner(g, p, layout.floors.find((f) => f.kind === 'runner')!.rect);
  return g;
}

/** A stretch of wall A, from grid x0 to x1, between heights h0 and h1 (px). */
export const wallRect = (x0: number, x1: number, h0: number, h1: number) => [
  wallA(x0, h0),
  wallA(x1, h0),
  wallA(x1, h1),
  wallA(x0, h1),
];

/** Leather-bound books standing on a shelf of wall A, from x0 to x1, the shelf at height h. */
function books(g: Graphics, p: Palette, x0: number, x1: number, h: number, seed: string) {
  let x = x0 + 0.04;
  let i = 0;
  while (x < x1 - 0.08) {
    const hash = fnv1a(`${seed}:${i}`);
    const w = 0.055 + (hash % 3) * 0.012;
    // Now and then a gap, or a book lying flat.
    if (hash % 11 === 0) {
      x += 0.1;
      i++;
      continue;
    }
    const tall = 11 + (hash % 5);
    const c = p.books[hash % p.books.length]!;
    quad(g, wallRect(x, x + w, h, h + tall)).fill(c);
    // A gilt band across the spine.
    quad(g, wallRect(x, x + w, h + tall - 4, h + tall - 3)).fill({ color: p.brass, alpha: 0.6 });
    x += w + 0.008;
    i++;
  }
}

/** A built-in bookcase on wall A: dark back, shelves with books, posts either side. */
export function bookcase(
  g: Graphics,
  p: Palette,
  x0: number,
  x1: number,
  h0: number,
  h1: number,
  seed: string,
) {
  quad(g, wallRect(x0, x1, h0, h1)).fill(p.panel.shadow);
  const shelves = 3;
  const step = (h1 - h0) / shelves;
  for (let k = 0; k < shelves; k++) {
    const h = h0 + k * step;
    quad(g, wallRect(x0, x1, h, h + 2)).fill(p.panel.frame);
    books(g, p, x0, x1, h + 2, `${seed}:${k}`);
  }
  quad(g, wallRect(x0, x1, h1 - 2, h1 + 2)).fill(p.panel.frame);
  for (const x of [x0, x1]) quad(g, wallRect(x - 0.06, x + 0.06, h0 - 2, h1 + 3)).fill(p.panel.frame);
}

/** A brass wall light with its warm pool of light, at grid x on wall A. */
export function sconce(g: Graphics, p: Palette, x: number, h: number) {
  const c = wallA(x, h);
  for (const [r, a] of [
    [26, 0.07],
    [17, 0.1],
    [10, 0.16],
  ] as const)
    g.ellipse(c.x, c.y - 2, r, r * 0.8).fill({ color: p.glow, alpha: p.theme === 'dark' ? a * 1.6 : a });
  g.rect(c.x - 1, c.y, 2, 7).fill(p.brass);
  g.poly([c.x - 5, c.y, c.x + 5, c.y, c.x + 3.5, c.y - 7, c.x - 3.5, c.y - 7]).fill(
    mix(p.glow, 0xffffff, 0.3),
  );
  g.rect(c.x - 5, c.y, 10, 1.4).fill(p.brass);
}

/** A framed world map: paper, rough continents, a compass rose. */
function worldMap(g: Graphics, p: Palette, x0: number, x1: number) {
  const h0 = 26;
  const h1 = 72;
  quad(g, wallRect(x0 - 0.12, x1 + 0.12, h0 - 4, h1 + 4)).fill(p.map.frame);
  quad(g, wallRect(x0, x1, h0, h1)).fill(p.map.paper);
  const w = x1 - x0;
  const at = (fx: number, fh: number) => wallA(x0 + fx * w, h0 + fh * (h1 - h0));
  const blob = (pts: [number, number][], tone: number) =>
    quad(
      g,
      pts.map(([fx, fh]) => at(fx, fh)),
    ).fill(mix(p.map.land, p.map.paper, tone));
  // The Americas, Europe and Africa, Asia, Australia: wood-toned shapes, as on a 3D wall map.
  blob(
    [
      [0.08, 0.8],
      [0.2, 0.86],
      [0.28, 0.72],
      [0.22, 0.62],
      [0.12, 0.66],
    ],
    0,
  );
  blob(
    [
      [0.2, 0.52],
      [0.27, 0.56],
      [0.3, 0.38],
      [0.25, 0.2],
      [0.21, 0.32],
    ],
    0.15,
  );
  blob(
    [
      [0.42, 0.82],
      [0.52, 0.86],
      [0.55, 0.74],
      [0.47, 0.7],
    ],
    0.25,
  );
  blob(
    [
      [0.43, 0.62],
      [0.55, 0.66],
      [0.58, 0.44],
      [0.5, 0.22],
      [0.44, 0.4],
    ],
    0.05,
  );
  blob(
    [
      [0.56, 0.84],
      [0.88, 0.86],
      [0.9, 0.64],
      [0.74, 0.56],
      [0.58, 0.66],
    ],
    0.1,
  );
  blob(
    [
      [0.76, 0.36],
      [0.88, 0.36],
      [0.86, 0.24],
      [0.77, 0.26],
    ],
    0.2,
  );
  const c = at(0.14, 0.24);
  g.moveTo(c.x - 4, c.y)
    .lineTo(c.x + 4, c.y)
    .moveTo(c.x, c.y - 4)
    .lineTo(c.x, c.y + 4)
    .stroke({
      width: 1,
      color: p.map.land,
    });
}

/** How high the whiteboard's writing surface runs on the wall, in px. */
export const BOARD_H = { bottom: 20, top: 76 } as const;
/** The same for a room's rolling board: on legs, its top clear of the glass. */
export const ROOM_BOARD_H = { bottom: 18, top: 66 } as const;

/**
 * A whiteboard (SPEC §14.6): an aluminium frame and a marker tray. The scene writes the notes on it.
 * The one by your door and the ones in the rooms are the same board, laid out by `spot`.
 */
function whiteboard(g: Graphics, p: Palette, spot: BoardSpot) {
  const { bottom, top, length: len, at } = spot;
  const b = p.board;
  const rect = (u0: number, u1: number, h0: number, h1: number) => [
    at(u0, h0),
    at(u1, h0),
    at(u1, h1),
    at(u0, h1),
  ];
  quad(g, rect(-0.07, len + 0.07, bottom - 3, top + 3)).fill(b.frame);
  quad(g, rect(0, len, bottom, top)).fill(b.surface);
  // A faint sheen, and the ghost of something wiped off.
  quad(g, rect(0.08, Math.min(1.2, len / 3), top - 9, top - 2)).fill({ color: 0xffffff, alpha: 0.3 });
  quad(g, rect(len - 1.4, len - 0.3, bottom + 4, bottom + 9)).fill({ color: b.ink, alpha: 0.04 });
  // The tray, with three markers and an eraser.
  quad(g, rect(0.25, len - 0.25, bottom - 6, bottom - 3)).fill(shade(b.frame, 0.15));
  [b.ink, b.red, 0x2f7a4a].forEach((color, i) => {
    const x = 0.5 + i * 0.32;
    quad(g, rect(x, x + 0.24, bottom - 4.6, bottom - 3)).fill(color);
  });
  quad(g, rect(len - 0.9, len - 0.45, bottom - 5.5, bottom - 3)).fill(0x3a3f45);
  // A rolling board stands on two legs.
  if (spot.project !== null)
    for (const u of [0.2, len - 0.2])
      quad(g, rect(u - 0.04, u + 0.04, 0, bottom - 6)).fill(shade(b.frame, 0.3));
}

/** The windows along the left wall, up to the entrance: where each starts, in tiles. */
export function windowsOf(layout: OfficeLayout): number[] {
  const out: number[] = [];
  for (let gy = 1.2; gy + 1.8 < layout.entrance.y - 0.4; gy += 3.4) out.push(gy);
  return out;
}

const DAY_SKY = 0x9fd3f2;
const GREY_SKY = 0xaeb7bf;
const NIGHT_SKY = 0x0b1524;

/** The sky's colour for this light: bright by day, grey under cloud, deep blue at night. */
export function skyColour(p: Palette, look: WindowLook): number {
  const sky = mix(mix(DAY_SKY, GREY_SKY, look.cloud), NIGHT_SKY, 1 - look.sky);
  return p.theme === 'dark' ? mix(sky, NIGHT_SKY, 0.25) : sky;
}

/**
 * The sky in the windows (SPEC §14.5): bright by day, grey under cloud, deep blue at night, with rain
 * or snow when the windows show the weather. Drawn over the panes, with the mullion on top.
 */
export function drawSky(
  g: Graphics,
  windows: number[],
  p: Palette,
  look: WindowLook,
  kit: ThemeArt = defaultArt,
) {
  g.clear();
  for (const gy of windows) kit.view(g, p, gy, look);
}

/** One window's sky: the colour of the light, rain or snow, the mullion and a glare. */
function skyView(g: Graphics, p: Palette, gy: number, look: WindowLook) {
  const color = skyColour(p, look);
  quad(g, [wallB(gy, 28), wallB(gy + 1.8, 28), wallB(gy + 1.8, 70), wallB(gy, 70)]).fill(color);
  weather(g, gy, look, 28, 70);
  quad(g, [wallB(gy + 0.9, 28), wallB(gy + 0.9, 70), wallB(gy + 0.92, 70), wallB(gy + 0.92, 28)]).fill(
    p.windowFrame,
  );
  quad(g, [wallB(gy + 0.2, 60), wallB(gy + 0.6, 66), wallB(gy + 0.6, 62), wallB(gy + 0.2, 56)]).fill({
    color: 0xffffff,
    alpha: (p.theme === 'dark' ? 0.08 : 0.4) * look.sky,
  });
}

/** Rain or snow in a window from `gy`, 1.8 tiles wide, between heights h0 and h1 (70 - 28 at Headquarters). */
export function weather(g: Graphics, gy: number, look: WindowLook, h0 = 28, h1 = 70, w = 1.8) {
  const k = (h1 - h0) / 42;
  if (look.precip === 'rain')
    for (let i = 0; i < Math.round(7 * (w / 1.8)); i++) {
      const x = gy + 0.15 + i * 0.24;
      for (const h of [36 + ((i * 13) % 20), 54 + ((i * 7) % 12)]) {
        const hh = h0 + (h - 28) * k;
        const a = wallB(x, hh + 6);
        const b = wallB(x - 0.06, hh);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xdbe8f2, alpha: 0.7 });
      }
    }
  if (look.precip === 'snow')
    for (let i = 0; i < Math.round(9 * (w / 1.8)); i++) {
      const c = wallB(gy + 0.12 + i * 0.19, h0 + (4 + ((i * 17) % 34)) * k);
      g.circle(c.x, c.y, 1.2).fill({ color: 0xffffff, alpha: 0.9 });
    }
}

/** Both walls, with skirting, crown moulding and caps. */
function walls(g: Graphics, p: Palette, layout: OfficeLayout) {
  const W = layout.width;
  const H = layout.height;
  quad(g, [wallB(0, 0), wallB(H, 0), wallB(H, WALL_H), wallB(0, WALL_H)]).fill(p.wallLeft);
  quad(g, [wallA(0, 0), wallA(W, 0), wallA(W, WALL_H), wallA(0, WALL_H)]).fill(p.wallRight);
  for (const [h0, h1] of [
    [0, 6],
    [WALL_H - 6, WALL_H - 3],
  ] as const) {
    quad(g, [wallB(0, h0), wallB(H, h0), wallB(H, h1), wallB(0, h1)]).fill(h0 ? p.trim : p.baseboard);
    quad(g, [wallA(0, h0), wallA(W, h0), wallA(W, h1), wallA(0, h1)]).fill(h0 ? p.trim : p.baseboard);
  }
  wallCaps(g, p, layout);
}

/** The thickness of both walls seen from above, along their tops. */
export function wallCaps(g: Graphics, p: Palette, layout: OfficeLayout, color = p.wallTop) {
  const T = 0.18; // wall thickness, in tiles
  const W = layout.width;
  const H = layout.height;
  const capB = [iso(0, 0), iso(0, H), iso(-T, H), iso(-T, -T)].map((q) => ({ x: q.x, y: q.y - WALL_H }));
  const capA = [iso(0, 0), iso(W, 0), iso(W, -T), iso(-T, -T)].map((q) => ({ x: q.x, y: q.y - WALL_H }));
  quad(g, capB).fill(color);
  quad(g, capA).fill(color);
}

/** A window on the left wall from `gy`, with curtains either side and a rod over them (on `drapes`). */
function curtainedWindow(g: Graphics, drapes: Graphics, p: Palette, gy: number) {
  const pts = [wallB(gy, 28), wallB(gy + 1.8, 28), wallB(gy + 1.8, 70), wallB(gy, 70)];
  quad(g, pts).fill(p.window).stroke({ width: 2.5, color: p.windowFrame });
  // Curtains either side, gathered at the bottom, and the rod across.
  for (const [a, b] of [
    [gy - 0.3, gy + 0.12],
    [gy + 1.68, gy + 2.1],
  ] as const) {
    quad(drapes, [wallB(a, 14), wallB(b, 16), wallB(b, 76), wallB(a, 76)]).fill(p.curtain);
    drapes
      .moveTo(wallB((a + b) / 2, 18).x, wallB((a + b) / 2, 18).y)
      .lineTo(wallB((a + b) / 2, 74).x, wallB((a + b) / 2, 74).y)
      .stroke({ width: 1, color: shade(p.curtain, 0.15), alpha: 0.7 });
  }
  quad(drapes, [wallB(gy - 0.4, 77), wallB(gy + 2.2, 77), wallB(gy + 2.2, 79), wallB(gy - 0.4, 79)]).fill(
    p.brass,
  );
}

/** The entrance on the left wall: an open doorway, and a mat. */
function doorway(g: Graphics, p: Palette, e: number) {
  quad(g, [wallB(e + 0.12, 0), wallB(e + 0.88, 0), wallB(e + 0.88, 60), wallB(e + 0.12, 60)])
    .fill(shade(p.wallLeft, 0.55))
    .stroke({ width: 2.5, color: p.doorFrame });
  diamond(g, 0.04, e + 0.15, 0.7, e + 0.85).fill({ color: p.doorFrame, alpha: 0.55 });
}

/** Your corner: painted panelling with a moulding, built-in bookcases and sconces round your door. */
function study(g: Graphics, p: Palette, s: SuiteSpot) {
  quad(g, wallRect(s.x0 - 0.2, s.x1, 0, WALL_H - 6)).fill(p.panel.face);
  quad(g, wallRect(s.x0 - 0.2, s.x1, 30, 32)).fill(p.panel.frame);
  for (let x = s.x0; x < s.x1; x++) {
    if (x === s.door) continue;
    quad(g, wallRect(x + 0.12, x + 0.88, 9, 26)).stroke({ width: 1.2, color: p.panel.frame });
  }
  bookcase(g, p, s.x0, s.door - 0.3, 36, 76, 'left');
  bookcase(g, p, s.door + 1.3, s.x1 - 0.15, 36, 76, 'right');
  sconce(g, p, s.door - 0.18, 52);
  sconce(g, p, s.door + 1.18, 52);
}

/** Your door: a walnut double door with raised panels and brass pulls, a cornice over it. */
function walnutDoor(g: Graphics, p: Palette, q: number, open: boolean) {
  const frame = wallRect(q + 0.06, q + 0.94, 0, 66);
  quad(g, wallRect(q - 0.06, q + 1.06, 0, 70)).fill(p.doorFrame);
  if (open) {
    // The study beyond: lamplight, and the leaves swung in.
    quad(g, frame).fill(shade(p.panel.shadow, 0.2));
    const c = wallA(q + 0.5, 30);
    g.ellipse(c.x, c.y, 18, 24).fill({ color: p.glow, alpha: 0.18 });
    for (const [a, b] of [
      [q + 0.06, q + 0.18],
      [q + 0.82, q + 0.94],
    ] as const)
      quad(g, wallRect(a, b, 0, 66)).fill(p.door);
  } else {
    quad(g, frame).fill(p.door);
    for (const [a, b] of [
      [q + 0.1, q + 0.48],
      [q + 0.52, q + 0.9],
    ] as const) {
      quad(g, wallRect(a + 0.05, b - 0.05, 8, 30)).stroke({ width: 1.2, color: shade(p.door, 0.35) });
      quad(g, wallRect(a + 0.05, b - 0.05, 36, 60)).stroke({ width: 1.2, color: shade(p.door, 0.35) });
    }
    quad(g, wallRect(q + 0.495, q + 0.505, 0, 66)).fill(shade(p.door, 0.4));
    for (const x of [q + 0.44, q + 0.56]) {
      const k = wallA(x, 34);
      g.roundRect(k.x - 1.2, k.y - 8, 2.4, 10, 1.2).fill(p.brass);
    }
  }
  // Cornice.
  quad(g, wallRect(q - 0.14, q + 1.14, 70, 74)).fill(shade(p.doorFrame, 0.1));
}

/** Where the big piece over the teams hangs on wall A, clear of the kitchen and the whiteboard; null if it does not fit. */
export function featureSpan(layout: OfficeLayout): { x0: number; x1: number } | null {
  const ka = layout.kitchen.area;
  const mapSpan = layout.board.x0 - 0.5 - (ka.x + ka.w);
  if (mapSpan < 5) return null;
  const mid = ka.x + ka.w + mapSpan / 2;
  const half = Math.min(3, mapSpan / 2 - 1);
  return { x0: mid - half, x1: mid + half };
}

function drawWalls(
  layout: OfficeLayout,
  p: Palette,
  doorLabel: string,
  kit: ThemeArt,
): { walls: Container; door: StaticOffice['door']; sky: Graphics; motion: Motion[] } {
  const walls = new Container();
  const g = new Graphics();
  walls.addChild(g);
  const W = layout.width;

  kit.walls(g, p, layout);

  // Windows along the left wall, up to the entrance near the front, with their dressing. The sky goes in
  // between the panes and the dressing (`drawSky`).
  const sky = new Graphics();
  const drapes = new Graphics();
  walls.addChild(sky, drapes);
  for (const gy of windowsOf(layout)) kit.window(g, drapes, p, gy);

  // The entrance on the left wall, under its exit sign.
  const e = layout.entrance.y;
  kit.entrance(g, p, e);
  quad(g, [wallB(e + 0.3, 66), wallB(e + 0.7, 66), wallB(e + 0.7, 74), wallB(e + 0.3, 74)]).fill(0x1f9d55);

  // Upper cabinets in the pantry.
  const pa = layout.pantry.area;
  quad(g, [wallA(pa.x + 1, 52), wallA(pa.x + 4, 52), wallA(pa.x + 4, 76), wallA(pa.x + 1, 76)])
    .fill(p.wood.left)
    .stroke({ width: 1.5, color: p.wood.right });
  for (let i = 1; i < 3; i++) {
    const m = wallA(pa.x + 1 + i, 52);
    const n = wallA(pa.x + 1 + i, 76);
    g.moveTo(m.x, m.y).lineTo(n.x, n.y).stroke({ width: 1.5, color: p.wood.right });
  }

  drawKitchenWall(g, layout, p);

  // The big piece over the teams (a framed world map), clear of the kitchen and the whiteboard, and the
  // whiteboard by your corner.
  const s = layout.suite;
  const span = featureSpan(layout);
  if (span) kit.feature(g, p, span.x0, span.x1);
  whiteboard(g, p, boardSpots(layout)[0]!);

  // Your corner, round your door.
  const doorX = layout.door.x;
  kit.suite(g, p, { x0: s.x, x1: W, door: doorX });

  // Wall-hung extras, over the walls and under the window dressing; and anything that moves.
  const motion: Motion[] = [];
  if (kit.extras) {
    const extras = new Graphics();
    walls.addChildAt(extras, 1);
    for (const m of kit.extras(extras, p, layout, () => new Graphics()) ?? []) {
      m.draw(0);
      motion.push(m);
      walls.addChildAt(m.g, 2);
    }
  }

  // The door.
  const q = doorX;
  const doorG = new Graphics();
  const frame = wallRect(q + 0.06, q + 0.94, 0, 66);
  const setOpen = (open: boolean) => {
    doorG.clear();
    kit.door(doorG, p, q, open);
  };
  setOpen(false);
  walls.addChild(doorG);
  const signAt = wallA(q + 0.5, 80);
  const text = label(doorLabel, 10.5, p.signText, '600');
  const plateW = Math.min(Math.max(text.width + 16, 64), 170);
  if (text.width > plateW - 12) text.scale.set((plateW - 12) / text.width);
  const plate = new Graphics()
    .roundRect(signAt.x - plateW / 2, signAt.y - 8.5, plateW, 17, 3)
    .fill(p.sign)
    .stroke({ width: 1.5, color: p.brass });
  text.position.set(signAt.x, signAt.y);
  walls.addChild(plate, text);

  return { walls, door: { graphics: doorG, hit: frame, setOpen }, sky, motion };
}

function piece(z: number, ...gs: Container[]): Container {
  const c = new Container();
  c.zIndex = z;
  c.addChild(...gs);
  return c;
}

/** A tile-sized piece of furniture's draw order: its tile, nudged so sitters draw over seats. */
const zOf = (x: number, y: number, nudge = 0) => depth(x + 0.5, y + 0.5) + nudge;

function deskPiece(g: Graphics, p: Palette, f: Furniture, x: number, y: number, monitor: boolean) {
  // A shadow, then the desk with a darker apron.
  diamond(g, x + 0.04, y + 0.1, x + 1.0, y + 1.02).fill({ color: p.shadow, alpha: 0.16 });
  box(g, x + 0.06, y + 0.08, x + 0.94, y + 0.92, 17, p.wood);
  if (monitor) {
    // The screen's light on the desk, then the monitor seen from behind.
    diamond(g, x + 0.22, y + 0.18, x + 0.8, y + 0.62, 17).fill({
      color: p.screen,
      alpha: p.theme === 'dark' ? 0.28 : 0.18,
    });
    box(
      g,
      x + 0.46,
      y + 0.6,
      x + 0.54,
      y + 0.68,
      4,
      { top: p.monitor, left: p.monitor, right: p.monitor },
      17,
    );
    box(
      g,
      x + 0.18,
      y + 0.62,
      x + 0.82,
      y + 0.7,
      16,
      { top: tint(p.monitor, 0.15), left: p.monitor, right: tint(p.monitor, 0.08) },
      21,
    );
    const led = iso(x + 0.74, y + 0.7);
    g.circle(led.x, led.y - 24, 1).fill(p.status.green);
    // A keyboard on the sitter's side.
    diamond(g, x + 0.28, y + 0.16, x + 0.72, y + 0.34, 17.5).fill(p.theme === 'dark' ? 0x4a4e57 : 0xd5d8de);
    // Some desks have a mug.
    if ((fnv1a(`${f.team}:${f.desk}`) & 3) === 0) {
      box(g, x + 0.78, y + 0.3, x + 0.88, y + 0.4, 6, { top: 0xffffff, left: 0xe8e3d9, right: 0xd8d2c6 }, 17);
    }
  }
}

function chairPiece(g: Graphics, p: Palette, x: number, y: number) {
  const c = { top: tint(p.chair, 0.12), left: p.chair, right: shade(p.chair, 0.2) };
  box(g, x + 0.47, y + 0.47, x + 0.53, y + 0.53, 8, {
    top: p.metal.left,
    left: p.metal.left,
    right: p.metal.right,
  });
  box(g, x + 0.24, y + 0.26, x + 0.76, y + 0.74, 4, c, 8);
  // The backrest, behind whoever sits here.
  box(g, x + 0.22, y + 0.16, x + 0.78, y + 0.26, 16, c, 10);
}

export const POST_H = 26;

/** A brass post for the rope along the line: a weighted base, a pole and a ball on top. */
function postAt(g: Graphics, p: Palette, x: number, y: number) {
  const c = iso(x, y);
  g.ellipse(c.x + 1, c.y + 1, 6, 3).fill({ color: p.shadow, alpha: 0.22 });
  g.ellipse(c.x, c.y - 1, 5, 2.5).fill(shade(p.brass, 0.25));
  g.rect(c.x - 1.2, c.y - POST_H, 2.4, POST_H - 1).fill(p.brass);
  g.rect(c.x - 1.2, c.y - POST_H, 0.9, POST_H - 1).fill(tint(p.brass, 0.3));
  g.circle(c.x, c.y - POST_H - 1, 2.6).fill(tint(p.brass, 0.15));
}

/**
 * One tile's worth of the rope beside the line (the rope furniture's tile `ty`), with the posts that
 * stand on it. Posts go every two tiles and at the end; the rope sags between them.
 */
/** A post that stands at (x, y) on the floor, for the rope beside your line. */
export type Post = (g: Graphics, p: Palette, x: number, y: number) => void;

/**
 * The rope beside your line, one tile (`ty`) of rope furniture `f`, with the posts that stand on it
 * (`post`, brass by default). Posts go every two tiles and at the end; the rope sags between them.
 */
export function ropeWith(post: Post, width = 2.6) {
  return (g: Graphics, p: Palette, f: Furniture, door: number, ty: number) => {
    // Along the edge that faces the line, set back a little from it.
    const ex = f.x < door ? f.x + 0.92 : f.x + 0.08;
    const end = f.y + f.h;
    const a = f.y + Math.floor((ty - f.y) / 2) * 2;
    const b = Math.min(a + 2, end);
    const at = (y: number) => {
      const t = (y - a) / (b - a);
      const c = iso(ex, y);
      return { x: c.x, y: c.y - POST_H + 4 + 6 * 4 * t * (1 - t) };
    };
    const pts = [0, 0.25, 0.5, 0.75, 1].map((k) => at(ty + k));
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
    g.stroke({ width, color: p.rope, cap: 'round', join: 'round' });
    g.moveTo(pts[0]!.x, pts[0]!.y - 0.7);
    for (const q of pts.slice(1)) g.lineTo(q.x, q.y - 0.7);
    g.stroke({ width: 0.8, color: tint(p.rope, 0.3), alpha: 0.8 });
    if (ty === a) post(g, p, ex, ty);
    if (ty + 1 === end) post(g, p, ex, end);
  };
}

const ropePiece = ropeWith(postAt);

function stoolPiece(g: Graphics, p: Palette, x: number, y: number) {
  box(g, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 9, {
    top: p.metal.left,
    left: p.metal.left,
    right: p.metal.right,
  });
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y - 10, 11, 5.5)
    .fill(p.wood.top)
    .stroke({ width: 1, color: p.wood.right });
}

function plantPiece(g: Graphics, p: Palette, x: number, y: number) {
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y + 2, 14, 6).fill({ color: p.shadow, alpha: 0.18 });
  box(g, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 13, {
    top: shade(p.plant.pot, 0.3),
    left: p.plant.pot,
    right: shade(p.plant.pot, 0.15),
  });
  const leaves: [number, number, number, boolean][] = [
    [-7, -24, 8, false],
    [7, -26, 8, false],
    [0, -34, 9, true],
    [-4, -40, 6, true],
    [5, -38, 6, false],
  ];
  for (const [dx, dy, r, light] of leaves)
    g.circle(c.x + dx, c.y + dy, r).fill(light ? p.plant.leafLight : p.plant.leaf);
}

function signPiece(p: Palette, x: number, y: number, project: string, color: number): Container {
  const g = new Graphics();
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y, 8, 3.5).fill({ color: p.shadow, alpha: 0.2 });
  g.rect(c.x - 1.5, c.y - 30, 3, 30).fill(p.metal.right);
  const t = label(project, 10, p.theme === 'dark' ? 0xf4f4f5 : 0x16171a, '700');
  const w = Math.min(Math.max(t.width + 14, 48), 150);
  if (t.width > w - 10) t.scale.set((w - 10) / t.width);
  g.roundRect(c.x - w / 2, c.y - 50, w, 20, 5)
    .fill(p.theme === 'dark' ? shade(color, 0.1) : tint(color, 0.35))
    .stroke({ width: 1.5, color: p.theme === 'dark' ? tint(color, 0.35) : shade(color, 0.3) });
  t.position.set(c.x, c.y - 40);
  const out = new Container();
  out.addChild(g, t);
  return out;
}

/** Glass height, px: low enough to see who is inside, high enough to read as a room. */
export const GLASS_H = 30;

/** One pane of a room's glass: a tinted sheet with a rail along its top and a post at its start. */
function glassPiece(g: Graphics, p: Palette, e: Edge) {
  const a = iso(e.x0, e.y0);
  const b = iso(e.x1, e.y1);
  quad(g, [a, b, { x: b.x, y: b.y - GLASS_H }, { x: a.x, y: a.y - GLASS_H }]).fill({
    color: p.glass.pane,
    alpha: p.theme === 'dark' ? 0.16 : 0.22,
  });
  g.moveTo(a.x, a.y - GLASS_H)
    .lineTo(b.x, b.y - GLASS_H)
    .stroke({ width: 2, color: p.glass.rail, alpha: 0.9 });
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.5, color: p.glass.rail, alpha: 0.6 });
  g.rect(a.x - 1, a.y - GLASS_H, 2, GLASS_H).fill({ color: p.glass.rail, alpha: 0.9 });
  // A glint across the pane.
  const m = { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 };
  const n = { x: a.x + (b.x - a.x) * 0.45, y: a.y + (b.y - a.y) * 0.45 };
  g.moveTo(m.x, m.y - 6)
    .lineTo(n.x, n.y - GLASS_H + 6)
    .stroke({ width: 1, color: 0xffffff, alpha: p.theme === 'dark' ? 0.18 : 0.45 });
}

/** The posts either side of a room's doorway, and the lintel. */
function glassDoorway(g: Graphics, p: Palette, t: TeamPlan) {
  const y = t.doorway.y;
  const a = iso(t.doorway.x0, y);
  const b = iso(t.doorway.x1, y);
  for (const q of [a, b]) g.rect(q.x - 1.5, q.y - GLASS_H - 12, 3, GLASS_H + 12).fill(p.glass.rail);
  g.moveTo(a.x, a.y - GLASS_H - 12)
    .lineTo(b.x, b.y - GLASS_H - 12)
    .stroke({ width: 3, color: p.glass.rail });
}

/** The room's nameplate, over its doorway, in its team colour. */
function doorPlate(p: Palette, t: TeamPlan, color: number, kit: ThemeArt): Container {
  const g = new Graphics();
  kit.doorway(g, p, t);
  const a = iso(t.doorway.x0, t.doorway.y);
  const b = iso(t.doorway.x1, t.doorway.y);
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - GLASS_H - 12 };
  const t2 = label(t.project, 9, p.theme === 'dark' ? 0xf4f4f5 : 0x16171a, '700');
  const w = Math.min(Math.max(t2.width + 12, 40), 120);
  if (t2.width > w - 8) t2.scale.set((w - 8) / t2.width);
  g.roundRect(c.x - w / 2, c.y - 9, w, 16, 4)
    .fill(p.theme === 'dark' ? shade(color, 0.1) : tint(color, 0.35))
    .stroke({ width: 1.2, color: p.theme === 'dark' ? tint(color, 0.35) : shade(color, 0.3) });
  t2.position.set(c.x, c.y - 1);
  const out = new Container();
  out.addChild(g, t2);
  return out;
}

/** Tile `i` of the pantry counter: wood, a metal top, a brass pull. */
function counterPiece(g: Graphics, p: Palette, f: Furniture, i: number) {
  box(g, f.x + i, f.y + 0.05, f.x + i + 1, f.y + 0.95, 24, {
    top: p.metal.top,
    left: tint(p.wood.left, 0.05),
    right: p.wood.right,
  });
  const m = iso(f.x + i + 0.5, f.y + 0.95);
  g.rect(m.x - 1, m.y - 18, 2, 8).fill(p.brass);
}

/** The coffee machine on the counter, with a cup under it. */
function coffeePiece(g: Graphics, _p: Palette, f: Furniture) {
  box(
    g,
    f.x + 0.2,
    f.y + 0.2,
    f.x + 0.7,
    f.y + 0.65,
    18,
    { top: 0x3a3d43, left: 0x2b2e34, right: 0x1f2125 },
    24,
  );
  const c = iso(f.x + 0.55, f.y + 0.65);
  g.circle(c.x - 6, c.y - 36, 1.6).fill(0xe63946);
  box(
    g,
    f.x + 0.38,
    f.y + 0.7,
    f.x + 0.5,
    f.y + 0.82,
    6,
    { top: 0xffffff, left: 0xe8e3d9, right: 0xd8d2c6 },
    24,
  );
}

function fridgePiece(g: Graphics, p: Palette, f: Furniture) {
  box(g, f.x + 0.08, f.y + 0.06, f.x + 0.92, f.y + 0.9, 50, p.fridge);
  const a = iso(f.x + 0.3, f.y + 0.9);
  g.rect(a.x - 1, a.y - 36, 2, 14).fill(p.metal.right);
  const b = iso(f.x + 0.92, f.y + 0.3);
  const c = iso(f.x + 0.08, f.y + 0.9);
  g.moveTo(c.x, c.y - 30)
    .lineTo(b.x, b.y - 30)
    .stroke({ width: 1, color: p.metal.right });
}

/** The water cooler: a cabinet and a blue bottle. */
function coolerPiece(g: Graphics, p: Palette, f: Furniture) {
  box(g, f.x + 0.25, f.y + 0.25, f.x + 0.75, f.y + 0.75, 20, p.fridge);
  const c = iso(f.x + 0.5, f.y + 0.5);
  g.roundRect(c.x - 7, c.y - 40, 14, 20, 5).fill({ color: 0x61afff, alpha: 0.55 });
  g.rect(c.x - 3, c.y - 43, 6, 4).fill({ color: 0x61afff, alpha: 0.7 });
}

/** A round pantry table on a pedestal; plates are set down on its top (`TABLE_H` in kitchen-art.ts). */
function tablePiece(g: Graphics, p: Palette, f: Furniture) {
  const c = iso(f.x + 0.5, f.y + 0.5);
  g.ellipse(c.x, c.y + 1, 20, 9).fill({ color: p.shadow, alpha: 0.16 });
  box(g, f.x + 0.45, f.y + 0.45, f.x + 0.55, f.y + 0.55, 14, p.metal);
  g.ellipse(c.x, c.y - 15, 25, 12.5).fill(p.wood.right);
  g.ellipse(c.x, c.y - 17, 25, 12.5).fill(p.wood.top);
  g.ellipse(c.x + 4, c.y - 18, 5, 2.5).fill({ color: 0xffffff, alpha: 0.75 });
}

/** Tile `i` of the sofa: its seat, its back, and an arm at either end. */
function sofaPiece(g: Graphics, p: Palette, f: Furniture, i: number) {
  const s = { top: p.sofa.seat, left: shade(p.sofa.seat, 0.12), right: shade(p.sofa.seat, 0.25) };
  const b = { top: tint(p.sofa.back, 0.1), left: p.sofa.back, right: shade(p.sofa.back, 0.2) };
  box(g, f.x + i, f.y + 0.2, f.x + i + 1, f.y + 0.9, 10, s);
  box(g, f.x + i, f.y + 0.04, f.x + i + 1, f.y + 0.24, 24, b);
  if (i === 0) box(g, f.x, f.y + 0.2, f.x + 0.14, f.y + 0.9, 16, b);
  if (i === f.w - 1) box(g, f.x + i + 0.86, f.y + 0.2, f.x + i + 1, f.y + 0.9, 16, b);
}

/** Tile `i` of the foosball table: felt in a wooden box, and the rods across. */
function foosballPiece(g: Graphics, p: Palette, f: Furniture, i: number) {
  box(g, f.x + i, f.y + 0.15, f.x + i + 1, f.y + 0.85, 16, p.wood);
  diamond(g, f.x + i + (i ? 0 : 0.08), f.y + 0.24, f.x + i + 1 - (i ? 0.08 : 0), f.y + 0.76, 16).fill(p.felt);
  for (const r of [0.35, 0.7]) {
    const a = iso(f.x + i + r, f.y + 0.1);
    const b = iso(f.x + i + r, f.y + 0.95);
    g.moveTo(a.x, a.y - 20)
      .lineTo(b.x, b.y - 20)
      .stroke({ width: 1.4, color: p.metal.top });
  }
}

/** A walnut side table with a brass lamp, its light pooled on the wall and the floor. */
function lampPiece(g: Graphics, p: Palette, f: Furniture) {
  const c = iso(f.x + 0.5, f.y + 0.5);
  g.ellipse(c.x, c.y + 1, 22, 10).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.08 : 0.05 });
  box(g, f.x + 0.2, f.y + 0.2, f.x + 0.8, f.y + 0.8, 18, p.wood);
  box(g, f.x + 0.47, f.y + 0.47, f.x + 0.53, f.y + 0.53, 16, p.wood, 18);
  g.ellipse(c.x, c.y - 19, 5, 2.4).fill(p.brass);
  g.ellipse(c.x, c.y - 40, 16, 12).fill({ color: p.glow, alpha: p.theme === 'dark' ? 0.16 : 0.1 });
  g.poly([c.x - 8, c.y - 34, c.x + 8, c.y - 34, c.x + 5.5, c.y - 45, c.x - 5.5, c.y - 45]).fill(
    mix(p.glow, 0xffffff, 0.35),
  );
  g.rect(c.x - 8, c.y - 34, 16, 1.5).fill(p.brass);
}

/** The edges of the pool table's tile (dx, dy): its frame is inset `e` at the table's outer sides. */
export function poolTileEdges(f: Furniture, dx: number, dy: number, e = 0.12) {
  const x0 = f.x + dx;
  const y0 = f.y + dy;
  return {
    x0,
    y0,
    lx0: dx === 0 ? x0 + e : x0,
    lx1: dx === f.w - 1 ? x0 + 1 - e : x0 + 1,
    ly0: dy === 0 ? y0 + e : y0,
    ly1: dy === f.h - 1 ? y0 + 1 - e : y0 + 1,
  };
}

/** Tile (dx, dy) of the pool table: felt on a wooden frame on four legs, pockets and a few balls. */
function poolPiece(g: Graphics, p: Palette, f: Furniture, dx: number, dy: number) {
  const e = 0.12;
  const { x0, y0, lx0, lx1, ly0, ly1 } = poolTileEdges(f, dx, dy, e);
  if ((dx === 0 || dx === f.w - 1) && (dy === 0 || dy === f.h - 1)) {
    const lx = dx === 0 ? lx0 + 0.08 : lx1 - 0.16;
    const ly = dy === 0 ? ly0 + 0.08 : ly1 - 0.16;
    box(g, lx, ly, lx + 0.08, ly + 0.08, 16, p.wood);
  }
  box(g, lx0, ly0, lx1, ly1, 6, p.wood, 16);
  const fx0 = dx === 0 ? lx0 + 0.14 : lx0;
  const fx1 = dx === f.w - 1 ? lx1 - 0.14 : lx1;
  const fy0 = dy === 0 ? ly0 + 0.14 : ly0;
  const fy1 = dy === f.h - 1 ? ly1 - 0.14 : ly1;
  diamond(g, fx0, fy0, fx1, fy1, 22).fill(p.felt);
  // Pockets at the corners and the middle of the long sides.
  for (const [px2, py2] of [
    [f.x + e + 0.1, f.y + e + 0.1],
    [f.x + f.w - e - 0.1, f.y + e + 0.1],
    [f.x + e + 0.1, f.y + f.h - e - 0.1],
    [f.x + f.w - e - 0.1, f.y + f.h - e - 0.1],
    [f.x + e + 0.1, f.y + f.h / 2],
    [f.x + f.w - e - 0.1, f.y + f.h / 2],
  ] as const)
    if (px2 >= x0 && px2 < x0 + 1 && py2 >= y0 && py2 < y0 + 1) {
      const c = iso(px2, py2);
      g.ellipse(c.x, c.y - 22, 2.6, 1.4).fill(0x111111);
    }
  // A few balls.
  const balls: [number, number, number][] = [
    [f.x + 0.9, f.y + 0.8, 0xf4f1de],
    [f.x + 1.1, f.y + 2.0, 0xe63946],
    [f.x + 0.8, f.y + 2.2, 0xf1c40f],
    [f.x + 1.25, f.y + 2.25, 0x1d3557],
  ];
  for (const [bx, by, color] of balls)
    if (bx >= x0 && bx < x0 + 1 && by >= y0 && by < y0 + 1) {
      const c = iso(bx, by);
      g.circle(c.x, c.y - 24, 2).fill(color);
    }
}

/** A rack of cues on the lounge's wall side. */
function cueRackPiece(g: Graphics, p: Palette, f: Furniture) {
  box(g, f.x + 0.1, f.y + 0.3, f.x + 0.3, f.y + 0.7, 8, p.wood);
  for (const [k, color] of [
    [0.38, 0xc8a165],
    [0.5, 0xb88a50],
    [0.62, 0xc8a165],
  ] as const) {
    const a = iso(f.x + 0.2, f.y + k);
    g.moveTo(a.x, a.y - 6)
      .lineTo(a.x + 2, a.y - 56)
      .stroke({ width: 1.8, color });
  }
}

/** The default art kit: Headquarters, the study. A theme overrides what it restyles (themes/types.ts). */
export const defaultArt: ThemeArt = {
  floor: floorTile,
  rug,
  runner,
  walls,
  window: curtainedWindow,
  view: skyView,
  entrance: doorway,
  feature: worldMap,
  suite: study,
  door: walnutDoor,
  partition: glassPiece,
  doorway: glassDoorway,
  plant: plantPiece,
  lamp: lampPiece,
  desk: deskPiece,
  chair: chairPiece,
  stool: stoolPiece,
  rope: ropePiece,
  counter: counterPiece,
  coffee: coffeePiece,
  fridge: fridgePiece,
  cooler: coolerPiece,
  table: tablePiece,
  sofa: sofaPiece,
  foosball: foosballPiece,
  poolTable: poolPiece,
  cueRack: cueRackPiece,
};

/** A theme's art: its own slots, and the default kit's for the rest. */
export function artFor(theme: OfficeTheme): ThemeArt {
  return { ...defaultArt, ...theme.art };
}

export function buildStatic(
  layout: OfficeLayout,
  p: Palette,
  doorLabel: string,
  kit: ThemeArt = defaultArt,
): StaticOffice {
  const floor = drawFloor(layout, p, kit);
  const { walls, door, sky, motion } = drawWalls(layout, p, doorLabel, kit);
  const pieces: Container[] = [];
  const awaySigns = new Map<string, Graphics>();
  const teamIndex = new Map(layout.teams.map((t, i) => [t.project, i]));
  const roomBoards = new Map<string, Container>();
  /** A new drawing, drawn by `draw`. */
  const drawn = (draw: (g: Graphics) => void) => {
    const g = new Graphics();
    draw(g);
    return g;
  };

  for (const t of layout.teams) {
    // The room's whiteboard, a piece of its own so whoever walks past draws over it.
    const spot = boardSpots(layout).find((b) => b.project === t.project)!;
    const frame = new Graphics();
    whiteboard(frame, p, spot);
    const foot = iso(t.board.x + 0.2, (t.board.y0 + t.board.y1) / 2);
    frame.ellipse(foot.x, foot.y, 28, 6).fill({ color: p.shadow, alpha: 0.14 });
    const writing = new Container();
    roomBoards.set(spot.id, writing);
    pieces.push(piece(depth(t.board.x + 0.15, (t.board.y0 + t.board.y1) / 2), frame, writing));
    for (const d of t.desks) {
      pieces.push(
        piece(
          zOf(d.seat.x, d.seat.y, -20),
          drawn((g) => kit.chair(g, p, d.seat.x, d.seat.y)),
        ),
      );
      const f: Furniture = { kind: 'desk', x: d.desk.x, y: d.desk.y, w: 1, h: 1, team: t.project, desk: d.n };
      const sign = new Graphics();
      const c = iso(d.desk.x + 0.5, d.desk.y + 0.45);
      sign.poly([c.x - 9, c.y - 17, c.x + 9, c.y - 17, c.x + 7, c.y - 30, c.x - 7, c.y - 30]).fill(0xf4f1de);
      sign.poly([c.x - 5, c.y - 25, c.x + 5, c.y - 25, c.x + 5, c.y - 23, c.x - 5, c.y - 23]).fill(p.ink);
      sign.visible = false;
      awaySigns.set(`${t.project}/${d.n}`, sign);
      pieces.push(
        piece(
          zOf(d.desk.x, d.desk.y),
          drawn((g) => kit.desk(g, p, f, d.desk.x, d.desk.y, true)),
          sign,
        ),
      );
    }
    const ls = t.leadSeat;
    pieces.push(
      piece(
        zOf(ls.x, ls.y, -20),
        drawn((g) => kit.chair(g, p, ls.x, ls.y)),
      ),
    );
    // The glass, a piece per pane drawn at the pane's middle: the back panes behind whoever is inside,
    // the front ones in front of them.
    for (const e of t.walls)
      pieces.push(
        piece(
          depth((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2),
          drawn((g) => kit.partition(g, p, e)),
        ),
      );
    const color = p.carpets[(teamIndex.get(t.project) ?? 0) % p.carpets.length]![0];
    pieces.push(
      piece(
        depth((t.doorway.x0 + t.doorway.x1) / 2, t.doorway.y) + 1,
        doorPlate(p, t, p.theme === 'dark' ? tint(color, 0.15) : color, kit),
      ),
    );
  }

  for (const f of layout.furniture) {
    switch (f.kind) {
      case 'lead_desk':
        for (let i = 0; i < f.w; i++)
          pieces.push(
            piece(
              zOf(f.x + i, f.y),
              drawn((g) => kit.desk(g, p, f, f.x + i, f.y, i === 0)),
            ),
          );
        break;
      case 'team_sign': {
        const color = p.carpets[(teamIndex.get(f.team ?? '') ?? 0) % p.carpets.length]![0];
        pieces.push(
          piece(
            zOf(f.x, f.y),
            signPiece(p, f.x, f.y, f.team ?? '', p.theme === 'dark' ? tint(color, 0.15) : color),
          ),
        );
        break;
      }
      case 'counter':
        for (let i = 0; i < f.w; i++)
          pieces.push(
            piece(
              zOf(f.x + i, f.y),
              drawn((g) => kit.counter(g, p, f, i)),
            ),
          );
        break;
      case 'coffee':
        pieces.push(
          piece(
            zOf(f.x, f.y, 5),
            drawn((g) => kit.coffee(g, p, f)),
          ),
        );
        break;
      case 'fridge':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.fridge(g, p, f)),
          ),
        );
        break;
      case 'cooler':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.cooler(g, p, f)),
          ),
        );
        break;
      case 'plant':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.plant(g, p, f.x, f.y)),
          ),
        );
        break;
      case 'range':
        pieces.push(piece(zOf(f.x, f.y), rangePiece(p, f)));
        break;
      case 'sink':
        pieces.push(piece(zOf(f.x, f.y), sinkPiece(p, f)));
        break;
      case 'prep_counter':
        for (let i = 0; i < f.w; i++) pieces.push(piece(zOf(f.x + i, f.y), islandPiece(p, f.x + i, f.y)));
        break;
      case 'table':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.table(g, p, f)),
          ),
        );
        break;
      case 'sofa':
        for (let i = 0; i < f.w; i++)
          pieces.push(
            piece(
              zOf(f.x + i, f.y, -20),
              drawn((g) => kit.sofa(g, p, f, i)),
            ),
          );
        break;
      case 'foosball':
        for (let i = 0; i < f.w; i++)
          pieces.push(
            piece(
              zOf(f.x + i, f.y),
              drawn((g) => kit.foosball(g, p, f, i)),
            ),
          );
        break;
      case 'side_table':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.lamp(g, p, f)),
          ),
        );
        break;
      case 'pool_table':
        // One piece per tile, so people round it sort right.
        for (let dy = 0; dy < f.h; dy++)
          for (let dx = 0; dx < f.w; dx++)
            pieces.push(
              piece(
                zOf(f.x + dx, f.y + dy),
                drawn((g) => kit.poolTable(g, p, f, dx, dy)),
              ),
            );
        break;
      case 'cue_rack':
        pieces.push(
          piece(
            zOf(f.x, f.y),
            drawn((g) => kit.cueRack(g, p, f)),
          ),
        );
        break;
      case 'rope':
        // A piece per tile, so the east rope passes in front of the line and the west one behind it.
        for (let ty = f.y; ty < f.y + f.h; ty++)
          pieces.push(
            piece(
              zOf(f.x, ty),
              drawn((g) => kit.rope(g, p, f, layout.door.x, ty)),
            ),
          );
        break;
      default:
        break;
    }
  }

  // Stools at the pantry tables.
  for (const s of layout.pantry.spots.filter((x) => x.seat === 'chair'))
    pieces.push(
      piece(
        zOf(s.tile.x, s.tile.y, -20),
        drawn((g) => kit.stool(g, p, s.tile.x, s.tile.y)),
      ),
    );

  return { floor, walls, pieces, door, awaySigns, windows: windowsOf(layout), sky, roomBoards, motion };
}
