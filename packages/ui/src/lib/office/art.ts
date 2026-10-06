import { Container, Graphics, Text } from 'pixi.js';
import { fnv1a, type Furniture, type OfficeLayout } from '@aoe-supercharge/core/shared';
import { box, depth, diamond, iso, quad, shade, tint, wallA, wallB, WALL_H, type Pt } from './iso';
import type { Palette } from './palette';

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
}

const teamColor = (p: Palette, index: number) => p.carpets[index % p.carpets.length]!;

function floorKind(layout: OfficeLayout, x: number, y: number) {
  for (const f of layout.floors) {
    const r = f.rect;
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return f;
  }
  return null;
}

function drawFloor(layout: OfficeLayout, p: Palette): Graphics {
  const g = new Graphics();
  const teamIndex = new Map(layout.teams.map((t, i) => [t.project, i]));
  for (let y = 0; y < layout.height; y++)
    for (let x = 0; x < layout.width; x++) {
      const f = floorKind(layout, x, y);
      const odd = (x + y) % 2;
      const pair =
        f?.kind === 'carpet'
          ? teamColor(p, teamIndex.get(f.team ?? '') ?? 0)
          : f?.kind === 'pantry'
            ? p.pantry
            : f?.kind === 'office'
              ? p.officeFloor
              : p.corridor;
      diamond(g, x, y, x + 1, y + 1).fill(pair[odd]!);
    }
  // A border round each team's carpet, so the teams read as places.
  for (const t of layout.teams) {
    const { x, y, w, h } = t.area;
    const c = teamColor(p, teamIndex.get(t.project) ?? 0)[0];
    diamond(g, x + 0.08, y + 0.08, x + w - 0.08, y + h - 0.08).stroke({
      width: 2,
      color: p.theme === 'dark' ? tint(c, 0.18) : shade(c, 0.12),
      alpha: 0.9,
    });
  }
  // A rug in your office, between your desk and the door.
  const r = layout.room.area;
  diamond(g, r.x + 1.6, 1.55, r.x + r.w - 1.6, r.h - 1.45)
    .fill({ color: p.rug, alpha: 0.9 })
    .stroke({ width: 2, color: tint(p.rug, 0.25), alpha: 0.8 });
  diamond(g, r.x + 1.85, 1.8, r.x + r.w - 1.85, r.h - 1.7).stroke({
    width: 1,
    color: tint(p.rug, 0.35),
    alpha: 0.6,
  });
  return g;
}

function drawWalls(layout: OfficeLayout, p: Palette): { walls: Container } {
  const walls = new Container();
  const g = new Graphics();
  walls.addChild(g);
  const W = layout.width;
  const H = layout.height;
  const T = 0.18; // wall thickness, in tiles

  // Wall B (left) and wall A (back), with caps and baseboards.
  quad(g, [wallB(0, 0), wallB(H, 0), wallB(H, WALL_H), wallB(0, WALL_H)]).fill(p.wallLeft);
  quad(g, [wallA(0, 0), wallA(W, 0), wallA(W, WALL_H), wallA(0, WALL_H)]).fill(p.wallRight);
  quad(g, [wallB(0, 0), wallB(H, 0), wallB(H, 6), wallB(0, 6)]).fill(p.baseboard);
  quad(g, [wallA(0, 0), wallA(W, 0), wallA(W, 6), wallA(0, 6)]).fill(p.baseboard);
  const capB = [iso(0, 0), iso(0, H), iso(-T, H), iso(-T, -T)].map((q) => ({ x: q.x, y: q.y - WALL_H }));
  const capA = [iso(0, 0), iso(W, 0), iso(W, -T), iso(-T, -T)].map((q) => ({ x: q.x, y: q.y - WALL_H }));
  quad(g, capB).fill(p.wallTop);
  quad(g, capA).fill(p.wallTop);

  // Windows along the left wall, up to the entrance near the front.
  for (let gy = 1.2; gy + 1.8 < layout.entrance.y - 0.4; gy += 3.4) {
    const pts = [wallB(gy, 30), wallB(gy + 1.8, 30), wallB(gy + 1.8, 70), wallB(gy, 70)];
    quad(g, pts).fill(p.window).stroke({ width: 2.5, color: p.windowFrame });
    quad(g, [wallB(gy + 0.9, 30), wallB(gy + 0.9, 70), wallB(gy + 0.92, 70), wallB(gy + 0.92, 30)]).fill(
      p.windowFrame,
    );
    // A sky glint.
    quad(g, [wallB(gy + 0.2, 60), wallB(gy + 0.6, 66), wallB(gy + 0.6, 62), wallB(gy + 0.2, 56)]).fill({
      color: 0xffffff,
      alpha: p.theme === 'dark' ? 0.08 : 0.5,
    });
  }

  // The entrance on the left wall: an open doorway with a mat and an exit sign.
  const e = layout.entrance.y;
  quad(g, [wallB(e + 0.12, 0), wallB(e + 0.88, 0), wallB(e + 0.88, 60), wallB(e + 0.12, 60)])
    .fill(shade(p.wallLeft, 0.55))
    .stroke({ width: 2.5, color: p.doorFrame });
  quad(g, [wallB(e + 0.3, 66), wallB(e + 0.7, 66), wallB(e + 0.7, 74), wallB(e + 0.3, 74)]).fill(0x1f9d55);
  diamond(g, 0.04, e + 0.15, 0.7, e + 0.85).fill({ color: p.doorFrame, alpha: 0.55 });

  // A whiteboard on the back wall, right of your office, with somebody's diagram.
  const wb0 = layout.room.area.x + layout.room.area.w + 1;
  const wb1 = Math.min(W - 2, wb0 + 5);
  if (wb1 - wb0 > 2) {
    quad(g, [wallA(wb0, 30), wallA(wb1, 30), wallA(wb1, 70), wallA(wb0, 70)])
      .fill(p.theme === 'dark' ? 0xd9dce2 : 0xffffff)
      .stroke({ width: 2, color: p.metal.right });
    const s = new Graphics();
    const a = wallA(wb0 + 0.6, 58);
    const b = wallA(wb0 + 1.6, 46);
    const c = wallA(wb0 + 2.6, 56);
    s.moveTo(a.x, a.y).lineTo(b.x, b.y).lineTo(c.x, c.y).stroke({ width: 1.6, color: 0x3c6fb4 });
    for (const q of [a, b, c]) s.circle(q.x, q.y, 2.6).fill(0xb23a48);
    const d = wallA(wb1 - 1.4, 60);
    s.rect(d.x - 10, d.y, 20, 2).fill({ color: 0x2f8f8a, alpha: 0.8 });
    s.rect(d.x - 10, d.y + 6, 14, 2).fill({ color: 0x2f8f8a, alpha: 0.8 });
    walls.addChild(s);
  }

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

  // Inside your office: a clock and a framed picture on the back wall.
  const room = layout.room;
  const clock = wallA(room.seat.x - 1.2, 64);
  const cg = new Graphics()
    .circle(clock.x, clock.y, 8)
    .fill(0xf4f4f5)
    .stroke({ width: 2, color: p.metal.right })
    .moveTo(clock.x, clock.y)
    .lineTo(clock.x, clock.y - 5)
    .moveTo(clock.x, clock.y)
    .lineTo(clock.x + 4, clock.y + 1)
    .stroke({ width: 1.4, color: p.ink });
  walls.addChild(cg);
  const f0 = room.seat.x + 0.2;
  const f1 = room.seat.x + 1.5;
  quad(g, [wallA(f0, 36), wallA(f1, 36), wallA(f1, 70), wallA(f0, 70)])
    .fill(p.wood.right)
    .stroke({ width: 1, color: shade(p.wood.right, 0.3) });
  quad(g, [wallA(f0 + 0.12, 40), wallA(f1 - 0.12, 40), wallA(f1 - 0.12, 66), wallA(f0 + 0.12, 66)]).fill(
    p.theme === 'dark' ? 0x3d6b5a : 0x8fc4a8,
  );
  // Hills and a sun in the picture.
  quad(g, [wallA(f0 + 0.12, 40), wallA(f0 + 0.7, 52), wallA(f1 - 0.12, 44), wallA(f1 - 0.12, 40)]).fill(
    p.theme === 'dark' ? 0x2c5244 : 0x5f9f7f,
  );
  const sun = wallA(f1 - 0.4, 60);
  g.circle(sun.x, sun.y, 3).fill(0xf2c94c);

  return { walls };
}

/** Glass partition heights, in px: a solid sill, then glass up to the frame. */
const SILL_H = 12;
const GLASS_H = 62;

/**
 * Your office: glass walls standing on the room's edge tiles, cut into one piece per tile so people
 * inside and outside sort correctly against them, and the door in the front wall with your name over it.
 */
function drawRoom(
  layout: OfficeLayout,
  p: Palette,
  doorLabel: string,
): { pieces: Container[]; door: StaticOffice['door'] } {
  const room = layout.room;
  const { x: rx, w } = room.area;
  const front = room.doorway.y + 0.5;
  const pieces: Container[] = [];
  const sill = { top: tint(p.wallTop, 0.05), left: p.wallLeft, right: p.wallRight };

  /** A stretch of glass wall from grid point a to b (along one axis), drawn as one piece. */
  const panel = (a: Pt, b: Pt, z: number) => {
    const g = new Graphics();
    const A = iso(a.x, a.y);
    const B = iso(b.x, b.y);
    const up = (q: Pt, h: number) => ({ x: q.x, y: q.y - h });
    // Sill.
    quad(g, [A, B, up(B, SILL_H), up(A, SILL_H)]).fill(a.x === b.x ? sill.left : sill.right);
    // Glass, with a soft glint.
    quad(g, [up(A, SILL_H), up(B, SILL_H), up(B, GLASS_H), up(A, GLASS_H)]).fill({
      color: p.glass,
      alpha: p.theme === 'dark' ? 0.16 : 0.28,
    });
    const g0 = { x: A.x + (B.x - A.x) * 0.15, y: A.y + (B.y - A.y) * 0.15 };
    const g1 = { x: A.x + (B.x - A.x) * 0.35, y: A.y + (B.y - A.y) * 0.35 };
    quad(g, [up(g0, GLASS_H - 8), up(g1, GLASS_H - 8), up(g1, SILL_H + 30), up(g0, SILL_H + 22)]).fill({
      color: 0xffffff,
      alpha: p.theme === 'dark' ? 0.06 : 0.22,
    });
    // Frame: the top rail and the posts at both ends.
    g.moveTo(up(A, GLASS_H).x, up(A, GLASS_H).y)
      .lineTo(up(B, GLASS_H).x, up(B, GLASS_H).y)
      .stroke({ width: 3, color: p.glassFrame });
    for (const q of [A, B])
      g.moveTo(q.x, q.y - SILL_H)
        .lineTo(q.x, q.y - GLASS_H)
        .stroke({ width: 2, color: p.glassFrame });
    pieces.push(piece(z, g));
  };

  // Side walls, back to front, then the front wall either side of the door.
  for (const sx of [rx + 0.5, rx + w - 0.5])
    for (let y = 0; y < room.doorway.y; y++)
      panel({ x: sx, y }, { x: sx, y: Math.min(y + 1, front) }, depth(sx, y + 0.5));
  for (let x = rx + 0.5; x < rx + w - 0.5; x += 0.5) {
    const tile = Math.floor(x);
    if (tile === room.doorway.x) continue;
    const x1 = Math.min(x + 0.5, rx + w - 0.5);
    panel({ x, y: front }, { x: x1, y: front }, depth(x + 0.25, front));
  }

  // The door: a glass leaf with a handle, open while you have someone in.
  const dx = room.doorway.x;
  const doorG = new Graphics();
  const L0 = iso(dx, front);
  const L1 = iso(dx + 1, front);
  const up = (q: Pt, h: number) => ({ x: q.x, y: q.y - h });
  const frame = [L0, L1, up(L1, GLASS_H), up(L0, GLASS_H)];
  const setOpen = (open: boolean) => {
    doorG.clear();
    // The frame round the doorway.
    for (const q of [L0, L1])
      doorG
        .moveTo(q.x, q.y)
        .lineTo(q.x, q.y - GLASS_H)
        .stroke({ width: 3, color: p.doorFrame });
    doorG
      .moveTo(up(L0, GLASS_H).x, up(L0, GLASS_H).y)
      .lineTo(up(L1, GLASS_H).x, up(L1, GLASS_H).y)
      .stroke({ width: 4, color: p.doorFrame });
    if (open) {
      // Swung into the room, against the wall beside the doorway.
      const in1 = iso(dx, front - 0.9);
      quad(doorG, [L0, in1, up(in1, GLASS_H - 4), up(L0, GLASS_H - 4)])
        .fill({ color: p.glass, alpha: p.theme === 'dark' ? 0.22 : 0.35 })
        .stroke({ width: 2, color: p.glassFrame });
    } else {
      quad(doorG, [L0, L1, up(L1, GLASS_H - 4), up(L0, GLASS_H - 4)])
        .fill({ color: p.glass, alpha: p.theme === 'dark' ? 0.24 : 0.36 })
        .stroke({ width: 2, color: p.glassFrame });
      const k = iso(dx + 0.8, front);
      doorG.roundRect(k.x - 1.5, k.y - 34, 3, 12, 1.5).fill(p.brass);
    }
  };
  setOpen(false);
  // Your name over the door.
  const signAt = up(iso(dx + 0.5, front), GLASS_H + 13);
  const text = label(doorLabel, 11, p.signText, '600');
  const plateW = Math.min(Math.max(text.width + 16, 64), 190);
  if (text.width > plateW - 12) text.scale.set((plateW - 12) / text.width);
  const plate = new Graphics()
    .roundRect(signAt.x - plateW / 2, signAt.y - 9, plateW, 18, 5)
    .fill(p.sign)
    .stroke({ width: 1.5, color: p.brass });
  text.position.set(signAt.x, signAt.y);
  pieces.push(piece(depth(dx + 0.5, front) - 1, doorG, plate, text));

  return { pieces, door: { graphics: doorG, hit: frame, setOpen } };
}

function piece(z: number, ...gs: Container[]): Container {
  const c = new Container();
  c.zIndex = z;
  c.addChild(...gs);
  return c;
}

/** A tile-sized piece of furniture's draw order: its tile, nudged so sitters draw over seats. */
const zOf = (x: number, y: number, nudge = 0) => depth(x + 0.5, y + 0.5) + nudge;

function deskPiece(f: Furniture, p: Palette, x: number, y: number, monitor: boolean): Graphics {
  const g = new Graphics();
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
  return g;
}

function chairPiece(p: Palette, x: number, y: number): Graphics {
  const g = new Graphics();
  const c = { top: tint(p.chair, 0.12), left: p.chair, right: shade(p.chair, 0.2) };
  box(g, x + 0.47, y + 0.47, x + 0.53, y + 0.53, 8, {
    top: p.metal.left,
    left: p.metal.left,
    right: p.metal.right,
  });
  box(g, x + 0.24, y + 0.26, x + 0.76, y + 0.74, 4, c, 8);
  // The backrest, behind whoever sits here.
  box(g, x + 0.22, y + 0.16, x + 0.78, y + 0.26, 16, c, 10);
  return g;
}

/** Your chair: taller, padded, in leather. */
function execChairPiece(p: Palette, x: number, y: number): Graphics {
  const g = new Graphics();
  const leather = p.theme === 'dark' ? 0x2a2c31 : 0x3a3d44;
  const c = { top: tint(leather, 0.12), left: leather, right: shade(leather, 0.25) };
  box(g, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 8, {
    top: p.metal.left,
    left: p.metal.left,
    right: p.metal.right,
  });
  box(g, x + 0.2, y + 0.24, x + 0.8, y + 0.78, 6, c, 8);
  box(g, x + 0.18, y + 0.12, x + 0.82, y + 0.26, 30, c, 10);
  return g;
}

function stoolPiece(p: Palette, x: number, y: number): Graphics {
  const g = new Graphics();
  box(g, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 9, {
    top: p.metal.left,
    left: p.metal.left,
    right: p.metal.right,
  });
  const c = iso(x + 0.5, y + 0.5);
  g.ellipse(c.x, c.y - 10, 11, 5.5)
    .fill(p.wood.top)
    .stroke({ width: 1, color: p.wood.right });
  return g;
}

function plantPiece(p: Palette, x: number, y: number): Graphics {
  const g = new Graphics();
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
  return g;
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

export function buildStatic(layout: OfficeLayout, p: Palette, doorLabel: string): StaticOffice {
  const floor = drawFloor(layout, p);
  const { walls } = drawWalls(layout, p);
  const room = drawRoom(layout, p, doorLabel);
  const door = room.door;
  const pieces: Container[] = [...room.pieces];
  const awaySigns = new Map<string, Graphics>();
  const teamIndex = new Map(layout.teams.map((t, i) => [t.project, i]));

  for (const t of layout.teams) {
    for (const d of t.desks) {
      pieces.push(piece(zOf(d.seat.x, d.seat.y, -20), chairPiece(p, d.seat.x, d.seat.y)));
      const f: Furniture = { kind: 'desk', x: d.desk.x, y: d.desk.y, w: 1, h: 1, team: t.project, desk: d.n };
      const sign = new Graphics();
      const c = iso(d.desk.x + 0.5, d.desk.y + 0.45);
      sign.poly([c.x - 9, c.y - 17, c.x + 9, c.y - 17, c.x + 7, c.y - 30, c.x - 7, c.y - 30]).fill(0xf4f1de);
      sign.poly([c.x - 5, c.y - 25, c.x + 5, c.y - 25, c.x + 5, c.y - 23, c.x - 5, c.y - 23]).fill(p.ink);
      sign.visible = false;
      awaySigns.set(`${t.project}/${d.n}`, sign);
      pieces.push(piece(zOf(d.desk.x, d.desk.y), deskPiece(f, p, d.desk.x, d.desk.y, true), sign));
    }
    const ls = t.leadSeat;
    pieces.push(piece(zOf(ls.x, ls.y, -20), chairPiece(p, ls.x, ls.y)));
  }

  for (const f of layout.furniture) {
    switch (f.kind) {
      case 'lead_desk':
        for (let i = 0; i < f.w; i++)
          pieces.push(piece(zOf(f.x + i, f.y), deskPiece(f, p, f.x + i, f.y, i === 0)));
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
        for (let i = 0; i < f.w; i++) {
          const g = new Graphics();
          box(g, f.x + i, f.y + 0.05, f.x + i + 1, f.y + 0.95, 24, {
            top: p.metal.top,
            left: tint(p.wood.left, 0.05),
            right: p.wood.right,
          });
          const m = iso(f.x + i + 0.5, f.y + 0.95);
          g.rect(m.x - 1, m.y - 18, 2, 8).fill(p.brass);
          pieces.push(piece(zOf(f.x + i, f.y), g));
        }
        break;
      case 'coffee': {
        const g = new Graphics();
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
        pieces.push(piece(zOf(f.x, f.y, 5), g));
        break;
      }
      case 'fridge': {
        const g = new Graphics();
        box(g, f.x + 0.08, f.y + 0.06, f.x + 0.92, f.y + 0.9, 50, p.fridge);
        const a = iso(f.x + 0.3, f.y + 0.9);
        g.rect(a.x - 1, a.y - 36, 2, 14).fill(p.metal.right);
        const b = iso(f.x + 0.92, f.y + 0.3);
        const c = iso(f.x + 0.08, f.y + 0.9);
        g.moveTo(c.x, c.y - 30)
          .lineTo(b.x, b.y - 30)
          .stroke({ width: 1, color: p.metal.right });
        pieces.push(piece(zOf(f.x, f.y), g));
        break;
      }
      case 'cooler': {
        const g = new Graphics();
        box(g, f.x + 0.25, f.y + 0.25, f.x + 0.75, f.y + 0.75, 20, p.fridge);
        const c = iso(f.x + 0.5, f.y + 0.5);
        g.roundRect(c.x - 7, c.y - 40, 14, 20, 5).fill({ color: 0x61afff, alpha: 0.55 });
        g.rect(c.x - 3, c.y - 43, 6, 4).fill({ color: 0x61afff, alpha: 0.7 });
        pieces.push(piece(zOf(f.x, f.y), g));
        break;
      }
      case 'plant':
        pieces.push(piece(zOf(f.x, f.y), plantPiece(p, f.x, f.y)));
        break;
      case 'table': {
        const g = new Graphics();
        const c = iso(f.x + 0.5, f.y + 0.5);
        g.ellipse(c.x, c.y + 1, 20, 9).fill({ color: p.shadow, alpha: 0.16 });
        box(g, f.x + 0.45, f.y + 0.45, f.x + 0.55, f.y + 0.55, 14, p.metal);
        g.ellipse(c.x, c.y - 15, 25, 12.5).fill(p.wood.right);
        g.ellipse(c.x, c.y - 17, 25, 12.5).fill(p.wood.top);
        g.ellipse(c.x + 4, c.y - 18, 5, 2.5).fill({ color: 0xffffff, alpha: 0.75 });
        pieces.push(piece(zOf(f.x, f.y), g));
        break;
      }
      case 'sofa':
        for (let i = 0; i < f.w; i++) {
          const g = new Graphics();
          const s = { top: p.sofa.seat, left: shade(p.sofa.seat, 0.12), right: shade(p.sofa.seat, 0.25) };
          const b = { top: tint(p.sofa.back, 0.1), left: p.sofa.back, right: shade(p.sofa.back, 0.2) };
          box(g, f.x + i, f.y + 0.2, f.x + i + 1, f.y + 0.9, 10, s);
          box(g, f.x + i, f.y + 0.04, f.x + i + 1, f.y + 0.24, 24, b);
          if (i === 0) box(g, f.x, f.y + 0.2, f.x + 0.14, f.y + 0.9, 16, b);
          if (i === f.w - 1) box(g, f.x + i + 0.86, f.y + 0.2, f.x + i + 1, f.y + 0.9, 16, b);
          pieces.push(piece(zOf(f.x + i, f.y, -20), g));
        }
        break;
      case 'foosball':
        for (let i = 0; i < f.w; i++) {
          const g = new Graphics();
          box(g, f.x + i, f.y + 0.15, f.x + i + 1, f.y + 0.85, 16, p.wood);
          diamond(g, f.x + i + (i ? 0 : 0.08), f.y + 0.24, f.x + i + 1 - (i ? 0.08 : 0), f.y + 0.76, 16).fill(
            p.felt,
          );
          for (const r of [0.35, 0.7]) {
            const a = iso(f.x + i + r, f.y + 0.1);
            const b = iso(f.x + i + r, f.y + 0.95);
            g.moveTo(a.x, a.y - 20)
              .lineTo(b.x, b.y - 20)
              .stroke({ width: 1.4, color: p.metal.top });
          }
          pieces.push(piece(zOf(f.x + i, f.y), g));
        }
        break;
      case 'exec_desk':
        for (let i = 0; i < f.w; i++) {
          const g = deskPiece(f, p, f.x + i, f.y, i === 1);
          // A lamp on one end, a stack of papers on the other.
          if (i === 0) {
            const c = iso(f.x + 0.35, f.y + 0.4);
            g.rect(c.x - 1, c.y - 32, 2, 14).fill(p.metal.right);
            g.poly([c.x - 8, c.y - 30, c.x + 8, c.y - 30, c.x + 5, c.y - 38, c.x - 5, c.y - 38]).fill(
              p.brass,
            );
            g.ellipse(c.x, c.y - 19, 5, 2.5).fill(p.metal.right);
          }
          if (i === f.w - 1)
            for (let k = 0; k < 3; k++)
              box(
                g,
                f.x + i + 0.3,
                f.y + 0.3,
                f.x + i + 0.7,
                f.y + 0.6,
                1.5,
                {
                  top: k === 2 ? 0xffffff : 0xf1efe8,
                  left: 0xe2ded3,
                  right: 0xd6d1c4,
                },
                17 + k * 1.6,
              );
          pieces.push(piece(zOf(f.x + i, f.y), g));
        }
        break;
      case 'bookshelf': {
        const g = new Graphics();
        box(g, f.x + 0.1, f.y + 0.05, f.x + 0.9, f.y + 0.55, 64, p.wood);
        // Book spines on each shelf, on the face towards the room.
        const spines = [0xb23a48, 0x3c6fb4, 0xe0a33a, 0x2f8f8a, 0x7b5ea7, 0xd9d4c7];
        for (let shelf = 0; shelf < 3; shelf++) {
          const h0 = 6 + shelf * 20;
          for (let k = 0; k < 6; k++) {
            const a = iso(f.x + 0.16 + k * 0.12, f.y + 0.55);
            const tall = 11 + ((fnv1a(`${shelf}:${k}`) % 5) as number);
            g.rect(a.x - 2.5, a.y - h0 - tall, 4.5, tall).fill(spines[(shelf * 2 + k) % spines.length]!);
          }
          const s0 = iso(f.x + 0.1, f.y + 0.55);
          const s1 = iso(f.x + 0.9, f.y + 0.55);
          g.moveTo(s0.x, s0.y - h0 + 1)
            .lineTo(s1.x, s1.y - h0 + 1)
            .stroke({ width: 2, color: p.wood.right });
        }
        pieces.push(piece(zOf(f.x, f.y), g));
        break;
      }
      case 'armchair': {
        const g = new Graphics();
        const s0 = { top: p.sofa.seat, left: shade(p.sofa.seat, 0.12), right: shade(p.sofa.seat, 0.25) };
        const b = { top: tint(p.sofa.back, 0.1), left: p.sofa.back, right: shade(p.sofa.back, 0.2) };
        box(g, f.x + 0.1, f.y + 0.25, f.x + 0.9, f.y + 0.9, 10, s0);
        box(g, f.x + 0.1, f.y + 0.08, f.x + 0.9, f.y + 0.28, 24, b);
        box(g, f.x + 0.1, f.y + 0.25, f.x + 0.24, f.y + 0.9, 16, b);
        box(g, f.x + 0.76, f.y + 0.25, f.x + 0.9, f.y + 0.9, 16, b);
        pieces.push(piece(zOf(f.x, f.y, -20), g));
        break;
      }
      default:
        break;
    }
  }

  // Stools at the pantry tables.
  for (const s of layout.pantry.spots.filter((x) => x.seat === 'chair'))
    pieces.push(piece(zOf(s.tile.x, s.tile.y, -20), stoolPiece(p, s.tile.x, s.tile.y)));

  // Your chair behind your desk, and the waiting chairs along the glass outside.
  const seat = layout.room.seat;
  pieces.push(piece(zOf(seat.x, seat.y, -20), execChairPiece(p, seat.x, seat.y)));
  for (const t of layout.queue.slice(0, layout.queueSeats))
    pieces.push(piece(zOf(t.x, t.y, -20), chairPiece(p, t.x, t.y)));

  return { floor, walls, pieces, door, awaySigns };
}
