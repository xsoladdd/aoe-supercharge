import type { Grid, Tile } from './pathfind.ts';

/**
 * The office floor plan (SPEC §14.5), in tiles: x runs along the back wall (wall A), y along the left
 * wall (wall B), towards the viewer. Your office is a glass room in the middle of the back wall, with
 * your desk inside and a row of waiting chairs outside its door; the pantry is in the back-left corner.
 * The team blocks fill the floor in front of the main aisle, and the entrance is at the front of the left
 * wall. It grows with the teams.
 *
 *   wall A (y = -1): pantry | your office (glass) | whiteboard
 *                            waiting chairs
 *   ─────────────────────── main aisle ───────────────────────
 *   team blocks, left to right, in rows
 *   entrance (x = 0, near the front)
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutTeam {
  project: string;
  /** The highest desk number in use; the block always has room for at least two. */
  desks: number;
}

export type FurnitureKind =
  | 'desk'
  | 'lead_desk'
  | 'team_sign'
  | 'counter'
  | 'coffee'
  | 'fridge'
  | 'cooler'
  | 'plant'
  | 'table'
  | 'sofa'
  | 'foosball'
  | 'exec_desk'
  | 'bookshelf'
  | 'armchair';

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  team?: string;
  desk?: number;
}

export interface TeamPlan {
  project: string;
  area: Rect;
  leadSeat: Tile;
  desks: { n: number; seat: Tile; desk: Tile }[];
  /** Where a worker stands when it has no desk yet. */
  spare: Tile[];
}

export type PantrySeat = 'stand' | 'chair' | 'sofa';

/** Your office: a glass room whose walls stand on the edge tiles of `area`, with a door in the front. */
export interface OfficeRoom {
  area: Rect;
  /** Wall tiles: the side columns and the front row, except the doorway. */
  walls: Tile[];
  /** The doorway in the front wall. */
  doorway: Tile;
  /** Your chair, behind your desk. */
  seat: Tile;
}

export interface OfficeLayout {
  width: number;
  height: number;
  grid: Grid;
  /** First tile inside the entrance on the left wall; new workers walk in from here. */
  entrance: Tile;
  /** The tile just outside your office door; the front of the line steps in through it. */
  door: Tile;
  /** Where the worker you called in stands, across your desk. */
  visitor: Tile;
  room: OfficeRoom;
  /** The line at your door, front first: on the waiting chairs, then standing in the aisle. */
  queue: Tile[];
  /** How many of the first `queue` spots are chairs. */
  queueSeats: number;
  pantry: { area: Rect; spots: { tile: Tile; seat: PantrySeat }[] };
  teams: TeamPlan[];
  furniture: Furniture[];
  floors: { kind: 'carpet' | 'pantry' | 'office'; rect: Rect; team?: string }[];
  /** Camera targets: `office`, `door`, `pantry` and each project name. */
  areas: Record<string, Rect>;
}

const PANTRY_W = 8;
const PANTRY_H = 7;
/** Your office, walls included: 5 tiles inside, with the side walls on its edge columns. */
const ROOM_W = 7;
/** Rows 0..3 inside (your chair, your desk, the visitor, a step in), then the front wall. */
const ROOM_H = 5;
const WAITING_CHAIRS = 4;

export function officeLayout(input: LayoutTeam[]): OfficeLayout {
  const teams = input.length ? input : [];
  const cols = Math.min(4, Math.max(2, ...teams.map((t) => t.desks)));
  const blockW = cols + 2;
  const rowsOf = (t: LayoutTeam) => Math.max(1, Math.ceil(Math.max(t.desks, 2) / cols));
  const blockH = (t: LayoutTeam) => 3 + rowsOf(t) * 3;
  const teamCols = teams.length <= 2 ? Math.max(1, teams.length) : teams.length <= 4 ? 2 : 3;

  // Rows of team blocks; each row is as tall as its tallest block.
  const rowHeights: number[] = [];
  teams.forEach((t, i) => {
    const r = Math.floor(i / teamCols);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, blockH(t));
  });
  const teamsW = teams.length ? teamCols * blockW + (teamCols - 1) : 0;
  const teamsH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(0, rowHeights.length - 1);

  // The back band: pantry, a walkway, your office with its waiting chairs, room for the line.
  const px = 1;
  const minRoomX = px + PANTRY_W + 1;
  const backW = minRoomX + ROOM_W + WAITING_CHAIRS + 3;
  // Wide enough that your office sits in the middle, clear of the pantry.
  const width = Math.max(backW, 1 + teamsW + 1, 2 * minRoomX + ROOM_W);
  const rx = Math.max(minRoomX, Math.floor((width - ROOM_W) / 2));
  const doorX = rx + Math.floor(ROOM_W / 2);
  const front = ROOM_H - 1;
  const waitY = ROOM_H;
  const aisleY = ROOM_H + 1;
  const teamsY = Math.max(PANTRY_H, aisleY + 1) + 1;
  const height = Math.max(teamsY + teamsH + 2, 14);

  const blocked = new Uint8Array(width * height);
  const block = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) blocked[y * width + x] = 1;
  };
  const furniture: Furniture[] = [];
  const put = (f: Furniture, blocks = true) => {
    furniture.push(f);
    if (blocks) for (let dx = 0; dx < f.w; dx++) for (let dy = 0; dy < f.h; dy++) block(f.x + dx, f.y + dy);
  };
  const floors: OfficeLayout['floors'] = [];
  const areas: Record<string, Rect> = {};

  // Your office. The walls stand on its edge tiles; you sit behind your desk, facing the door.
  const roomArea = { x: rx, y: 0, w: ROOM_W, h: ROOM_H };
  floors.push({ kind: 'office', rect: { x: rx + 1, y: 0, w: ROOM_W - 2, h: front } });
  const walls: Tile[] = [];
  for (let y = 0; y <= front; y++) walls.push({ x: rx, y }, { x: rx + ROOM_W - 1, y });
  for (let x = rx + 1; x < rx + ROOM_W - 1; x++) if (x !== doorX) walls.push({ x, y: front });
  for (const w of walls) block(w.x, w.y);
  const seat = { x: doorX, y: 0 };
  put({ kind: 'exec_desk', x: doorX - 1, y: 1, w: 3, h: 1 });
  put({ kind: 'bookshelf', x: rx + 1, y: 0, w: 1, h: 1 });
  put({ kind: 'plant', x: rx + 1, y: front - 1, w: 1, h: 1 });
  put({ kind: 'armchair', x: rx + ROOM_W - 2, y: front - 1, w: 1, h: 1 });
  const visitor = { x: doorX, y: 2 };

  // The line: chairs along the glass on the door's right, then standing down the aisle.
  const queue: Tile[] = [];
  for (let k = 1; k <= WAITING_CHAIRS; k++) queue.push({ x: doorX + k, y: waitY });
  for (let x = doorX + WAITING_CHAIRS; x >= rx - 1; x--) queue.push({ x, y: aisleY });
  for (let x = rx - 2; x > px + PANTRY_W; x--) queue.push({ x, y: aisleY });
  put({ kind: 'plant', x: doorX + WAITING_CHAIRS + 1, y: waitY, w: 1, h: 1 });

  // Team blocks, in front of the aisle.
  const plans: TeamPlan[] = [];
  let rowY = teamsY;
  teams.forEach((t, i) => {
    const c = i % teamCols;
    const r = Math.floor(i / teamCols);
    if (c === 0 && r > 0) rowY += rowHeights[r - 1]! + 1;
    // The teams sit centred under your office.
    const bx = Math.max(1, Math.floor((width - teamsW) / 2)) + c * (blockW + 1);
    const by = rowY;
    const area = { x: bx, y: by, w: blockW, h: blockH(t) };
    floors.push({ kind: 'carpet', rect: area, team: t.project });
    areas[t.project] = area;
    put({ kind: 'lead_desk', x: bx + 1, y: by + 1, w: 2, h: 1, team: t.project });
    put({ kind: 'team_sign', x: bx + blockW - 2, y: by, w: 1, h: 1, team: t.project });
    const desks: TeamPlan['desks'] = [];
    const count = rowsOf(t) * cols;
    for (let n = 1; n <= count; n++) {
      const dc = (n - 1) % cols;
      const dr = Math.floor((n - 1) / cols);
      const seat = { x: bx + 1 + dc, y: by + 3 + dr * 3 };
      const desk = { x: seat.x, y: seat.y + 1 };
      put({ kind: 'desk', x: desk.x, y: desk.y, w: 1, h: 1, team: t.project, desk: n });
      desks.push({ n, seat, desk });
    }
    plans.push({
      project: t.project,
      area,
      leadSeat: { x: bx + 1, y: by },
      desks,
      spare: Array.from({ length: cols }, (_, k) => ({ x: bx + 1 + k, y: by + 2 })),
    });
  });

  // The pantry, in the back-left corner.
  const pantryArea = { x: px, y: 0, w: PANTRY_W, h: PANTRY_H };
  floors.push({ kind: 'pantry', rect: pantryArea });
  put({ kind: 'counter', x: px + 1, y: 0, w: 3, h: 1 });
  put({ kind: 'coffee', x: px + 1, y: 0, w: 1, h: 1 }, false);
  put({ kind: 'fridge', x: px + 5, y: 0, w: 1, h: 1 });
  put({ kind: 'cooler', x: px + 6, y: 0, w: 1, h: 1 });
  put({ kind: 'plant', x: px + 7, y: 0, w: 1, h: 1 });
  put({ kind: 'table', x: px + 2, y: 3, w: 1, h: 1 });
  put({ kind: 'table', x: px + 5, y: 3, w: 1, h: 1 });
  put({ kind: 'sofa', x: px + 1, y: 5, w: 3, h: 1 }, false);
  put({ kind: 'foosball', x: px + 5, y: 5, w: 2, h: 1 });
  const at = (dx: number, dy: number) => ({ x: px + dx, y: dy });
  const spots: OfficeLayout['pantry']['spots'] = [
    ...[at(1, 1), at(2, 1), at(3, 1)].map((tile) => ({ tile, seat: 'stand' as const })),
    ...[at(1, 5), at(2, 5), at(3, 5)].map((tile) => ({ tile, seat: 'sofa' as const })),
    ...[at(1, 3), at(3, 3), at(2, 2), at(2, 4), at(4, 3), at(6, 3), at(5, 2), at(5, 4)].map((tile) => ({
      tile,
      seat: 'chair' as const,
    })),
    ...[at(5, 6), at(6, 6)].map((tile) => ({ tile, seat: 'stand' as const })),
  ];
  // A full pantry spills onto its free tiles.
  const taken = new Set(spots.map((s) => `${s.tile.x},${s.tile.y}`));
  for (let y = 1; y < PANTRY_H; y++)
    for (let x = px; x < px + PANTRY_W; x++)
      if (!blocked[y * width + x] && !taken.has(`${x},${y}`)) spots.push({ tile: { x, y }, seat: 'stand' });

  // Plants by the entrance and in the far back corner.
  const entrance = { x: 0, y: height - 3 };
  put({ kind: 'plant', x: 0, y: height - 1, w: 1, h: 1 });
  put({ kind: 'plant', x: width - 1, y: 0, w: 1, h: 1 });

  areas.office = { x: 0, y: 0, w: width, h: height };
  areas.door = { x: rx - 1, y: 0, w: ROOM_W + WAITING_CHAIRS + 2, h: aisleY + 1 };
  areas.pantry = pantryArea;

  return {
    width,
    height,
    grid: {
      width,
      height,
      blocked: (x, y) => x < 0 || y < 0 || x >= width || y >= height || blocked[y * width + x] === 1,
    },
    entrance,
    door: { x: doorX, y: waitY },
    visitor,
    room: { area: roomArea, walls, doorway: { x: doorX, y: front }, seat },
    queue,
    queueSeats: WAITING_CHAIRS,
    pantry: { area: pantryArea, spots },
    teams: plans,
    furniture,
    floors,
    areas,
  };
}
