import { edgeKey, type Grid, type Tile } from './pathfind.ts';

/**
 * The office floor plan (SPEC §14.5), in tiles: x runs along the back wall (wall A), y along the left
 * wall (wall B), towards the viewer. West to east: the pantry in the back-left corner, the team rooms
 * in rows (low glass all round, a doorway in the front, a nameplate over it), and your door at the far east end of the back wall, set in panelling with bookshelves, a lamp
 * on either side. The line to see you stands in single file on a runner straight out from your door,
 * between brass posts and ropes. The entrance is at the front of the left wall. It grows with the teams.
 *
 *   wall A (y = -1): pantry | world map ... whiteboard | shelves, lamp, YOUR DOOR, lamp, shelves
 *   x = 0 entrance | pantry | team blocks   | the line, out from your door
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
  | 'side_table'
  /** Brass posts and a rope along the side of the line that faces it. Blocks its column, so people join at the back. */
  | 'rope';

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  team?: string;
  desk?: number;
}

/** A unit stretch of grid line, from (x0, y0) to (x1, y1): one pane of a glass partition. */
export interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TeamPlan {
  project: string;
  /** The room: its floor, inside the glass. */
  area: Rect;
  /** Glass panes along the room's edges, leaving the doorway open. */
  walls: Edge[];
  /** The doorway in the front glass (towards the viewer): tiles x0 to x1 - 1, on grid line y. */
  doorway: { x0: number; x1: number; y: number };
  leadSeat: Tile;
  desks: { n: number; seat: Tile; desk: Tile }[];
  /** Where a worker stands when it has no desk yet. */
  spare: Tile[];
}

export type PantrySeat = 'stand' | 'chair' | 'sofa';

export interface OfficeLayout {
  width: number;
  height: number;
  grid: Grid;
  /** First tile inside the entrance on the left wall; new workers walk in from here. */
  entrance: Tile;
  /** The tile in front of your door; a called worker steps through it. */
  door: Tile;
  /**
   * The line at your door, front first: single file straight out from your door, between the ropes and
   * on past them, then turning west along the front of the office.
   */
  queue: Tile[];
  /** Your corner of the back wall: the panelled stretch round your door. */
  suite: Rect;
  /** The whiteboard with your notes and todos (SPEC §14.6): the stretch of wall A it hangs on, by your corner. */
  board: { x0: number; x1: number };
  pantry: { area: Rect; spots: { tile: Tile; seat: PantrySeat }[] };
  teams: TeamPlan[];
  furniture: Furniture[];
  floors: { kind: 'carpet' | 'pantry' | 'runner'; rect: Rect; team?: string }[];
  /** Camera targets: `office`, `door`, `pantry`, `board` and each project name. */
  areas: Record<string, Rect>;
}

const PANTRY_W = 8;
const PANTRY_H = 7;
/** Your corner, to the east wall: a tile to walk by, a plant and a lamp on either side of your door. */
const SUITE_W = 7;
/** Places in the line between the ropes. */
const ROPED = 6;
/** Places in the line once it turns along the front of the office. */
const TURN = 6;
/** Tiles of wall the whiteboard takes, just west of your corner. */
const BOARD_W = 4;

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
  const teamsW = teams.length ? teamCols * blockW + (teamCols - 1) : 4;
  const teamsH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(0, rowHeights.length - 1);

  const px = 1;
  const tx = px + PANTRY_W + 1;
  const sx = tx + teamsW + 1;
  const doorX = sx + 3;
  const width = sx + SUITE_W;
  const height = Math.max(PANTRY_H + 5, 1 + teamsH + 2, ROPED + 6);

  const blocked = new Uint8Array(width * height);
  const walls = new Set<string>();
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

  // Team blocks, in rows between the pantry and your corner.
  const plans: TeamPlan[] = [];
  let rowY = 1;
  teams.forEach((t, i) => {
    const c = i % teamCols;
    const r = Math.floor(i / teamCols);
    if (c === 0 && r > 0) rowY += rowHeights[r - 1]! + 1;
    const bx = tx + c * (blockW + 1);
    const by = rowY;
    const area = { x: bx, y: by, w: blockW, h: blockH(t) };
    floors.push({ kind: 'carpet', rect: area, team: t.project });
    areas[t.project] = area;
    put({ kind: 'lead_desk', x: bx + 1, y: by + 1, w: 2, h: 1, team: t.project });
    put({ kind: 'team_sign', x: bx + blockW - 2, y: by, w: 1, h: 1, team: t.project });
    // The room's glass: all round, but for a doorway two tiles wide in the middle of the front.
    const roomWalls: Edge[] = [];
    const doorX0 = bx + Math.floor((blockW - 2) / 2);
    const doorway = { x0: doorX0, x1: doorX0 + 2, y: by + area.h };
    const pane = (e: Edge) => {
      roomWalls.push(e);
      if (e.y0 === e.y1) walls.add(edgeKey(e.x0, e.y0 - 1, e.x0, e.y0));
      else walls.add(edgeKey(e.x0 - 1, e.y0, e.x0, e.y0));
    };
    for (let x = bx; x < bx + blockW; x++) {
      pane({ x0: x, y0: by, x1: x + 1, y1: by });
      if (x < doorway.x0 || x >= doorway.x1) pane({ x0: x, y0: by + area.h, x1: x + 1, y1: by + area.h });
    }
    for (let y = by; y < by + area.h; y++) {
      pane({ x0: bx, y0: y, x1: bx, y1: y + 1 });
      pane({ x0: bx + blockW, y0: y, x1: bx + blockW, y1: y + 1 });
    }
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
      walls: roomWalls,
      doorway,
      leadSeat: { x: bx + 1, y: by },
      desks,
      spare: Array.from({ length: cols }, (_, k) => ({ x: bx + 1 + k, y: by + 2 })),
    });
  });

  // Your corner: a lamp on a side table either side of your door, a plant past each, and the runner
  // straight out from your door with the ropes along it. The line stands on it in single file, front
  // first, one to a tile, and carries on past the ropes to the front of the office, then turns west.
  const suite = { x: sx, y: 0, w: SUITE_W, h: ROPED + 2 };
  floors.push({ kind: 'runner', rect: { x: doorX, y: 0, w: 1, h: ROPED + 1 } });
  for (const side of [-1, 1]) {
    put({ kind: 'side_table', x: doorX + side, y: 0, w: 1, h: 1 });
    put({ kind: 'plant', x: doorX + 2 * side, y: 0, w: 1, h: 1 });
    put({ kind: 'rope', x: doorX + side, y: 1, w: 1, h: ROPED });
  }
  const queue: Tile[] = [];
  for (let y = 1; y <= height - 2; y++) queue.push({ x: doorX, y });
  for (let k = 1; k <= TURN; k++) queue.push({ x: doorX - k, y: height - 2 });

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

  // Plants by the entrance and at the front corner of the east side.
  const entrance = { x: 0, y: height - 3 };
  put({ kind: 'plant', x: 0, y: height - 1, w: 1, h: 1 });
  put({ kind: 'plant', x: width - 1, y: height - 1, w: 1, h: 1 });

  // The whiteboard: on the wall just west of your corner, past the teams (always clear of the pantry).
  const board = { x0: sx - 0.5 - BOARD_W, x1: sx - 0.5 };

  areas.office = { x: 0, y: 0, w: width, h: height };
  areas.board = { x: Math.floor(board.x0), y: 0, w: BOARD_W + 1, h: 2 };
  areas.door = { x: sx - 1, y: 0, w: SUITE_W + 2, h: ROPED + 3 };
  areas.pantry = pantryArea;

  return {
    width,
    height,
    grid: {
      width,
      height,
      blocked: (x, y) => x < 0 || y < 0 || x >= width || y >= height || blocked[y * width + x] === 1,
      wall: (ax, ay, bx, by) => walls.has(edgeKey(ax, ay, bx, by)),
    },
    entrance,
    door: { x: doorX, y: 0 },
    queue,
    suite,
    board,
    pantry: { area: pantryArea, spots },
    teams: plans,
    furniture,
    floors,
    areas,
  };
}
