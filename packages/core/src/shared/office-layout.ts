import { STOVES } from './office-kitchen.ts';
import { edgeKey, type Grid, type Tile } from './pathfind.ts';

/**
 * The office floor plan (SPEC §14.5), in tiles: x runs along the back wall (wall A), y along the left
 * wall (wall B), towards the viewer. West to east: the pantry in the back-left corner, the kitchen next
 * to it, the team rooms in rows (low glass all round, a doorway in the front, a nameplate over it), and
 * your door at the far east end of the back wall, set in panelling with bookshelves, a lamp on either
 * side. The line to see you stands in single file on a runner straight out from your door, between
 * brass posts and ropes. The entrance is at the front of the left wall. It grows with the teams.
 *
 *   wall A (y = -1): pantry | ranges under a hood | world map ... whiteboard | shelves, lamp, YOUR DOOR, lamp, shelves
 *   x = 0 entrance | pantry | kitchen | team blocks   | the line, out from your door
 *   Each team room also has a whiteboard against its left glass (`TeamPlan.board`).
 */

/** Whiteboard ids: the one by your door, and one per room (also the camera area and `?focus=` name). */
export const DOOR_BOARD = 'board';
export const roomBoardId = (project: string) => `board:${project}`;

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
  /** The review lounge's pool table, two tiles by three. */
  | 'pool_table'
  /** A rack of cues on the lounge's wall side. */
  | 'cue_rack'
  /** Brass posts and a rope along the side of the line that faces it. Blocks its column, so people join at the back. */
  | 'rope'
  /** A cast-iron kitchen range against the back wall, one tile; `n` is its number from 1, west to east. */
  | 'range'
  /** The kitchen's prep island: a butcher block, one piece per tile. */
  | 'prep_counter'
  /** The kitchen sink. */
  | 'sink';

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  team?: string;
  desk?: number;
  /** A range's number (1 to `STOVES`). */
  n?: number;
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
  /**
   * The room's whiteboard (SPEC §14.6): a rolling board against the room's left glass, facing east, over
   * the empty aisle in the first column. `x` is the glass line, `y0`..`y1` the stretch it covers.
   */
  board: { x: number; y0: number; y1: number };
  leadSeat: Tile;
  desks: { n: number; seat: Tile; desk: Tile }[];
  /** Where a worker stands when it has no desk yet. */
  spare: Tile[];
}

export type PantrySeat = 'stand' | 'chair' | 'sofa';

/** A place at the prep counter: where to stand, which way to face, and the tile its board lies on. */
export interface CounterPlace {
  tile: Tile;
  face: [number, number];
  /** The island tile its cutting board lies on; null past the counter (the board is held). */
  board: Tile | null;
}

export interface KitchenPlan {
  area: Rect;
  /** The ranges, west to east: the range's tile and where its cook stands, facing it. */
  stoves: { range: Tile; stand: Tile }[];
  /** Places at the prep counter: the back row first (facing the room), then the front, the ends, then the rest of the floor. */
  counter: CounterPlace[];
}

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
  /** The kitchen (SPEC §14.5), shared by every project: planners cook here. */
  kitchen: KitchenPlan;
  teams: TeamPlan[];
  furniture: Furniture[];
  /** The review lounge (SPEC §14.5): a pool table, where workers with an MR out wait with their folder. */
  review: { area: Rect; spots: Tile[] };
  floors: { kind: 'carpet' | 'pantry' | 'kitchen' | 'runner' | 'lounge'; rect: Rect; team?: string }[];
  /** Camera targets: `office`, `door`, `pantry`, `kitchen`, `review`, `board`, each project name and `board:<project>`. */
  areas: Record<string, Rect>;
}

const PANTRY_W = 8;
const PANTRY_H = 7;
/** The kitchen, east of the pantry along the back wall. */
const KITCHEN_W = 7;
const KITCHEN_H = 7;
/** Ranges on the back wall, one per stove; the prep island is as long. */
const RANGES = STOVES;
/** The review lounge, in front of the pantry. */
const LOUNGE_H = 7;
/** Your corner, to the east wall: a tile to walk by, a plant and a lamp on either side of your door. */
const SUITE_W = 7;
/** Places in the line between the ropes. */
const ROPED = 6;
/** Places in the line once it turns along the front of the office. */
const TURN = 6;
/** Tiles of wall the whiteboard takes, just west of your corner. */
const BOARD_W = 4;
/** Tiles of glass a room's whiteboard covers. */
const ROOM_BOARD_W = 2.2;

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
  const kx = px + PANTRY_W + 1;
  const tx = kx + KITCHEN_W + 1;
  const sx = tx + teamsW + 1;
  const doorX = sx + 3;
  const width = sx + SUITE_W;
  const height = Math.max(PANTRY_H + 1 + LOUNGE_H + 3, 1 + teamsH + 2, ROPED + 6);

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
    put({ kind: 'team_sign', x: bx + 2, y: by, w: 1, h: 1, team: t.project });
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
    // Half way down the glass, so it is nowhere near the sign of the room behind it on screen.
    const boardAt = by + (area.h - ROOM_BOARD_W) / 2;
    const roomBoard = { x: bx, y0: boardAt, y1: boardAt + ROOM_BOARD_W };
    areas[roomBoardId(t.project)] = { x: bx, y: Math.floor(boardAt) - 1, w: 3, h: 4 };
    plans.push({
      project: t.project,
      area,
      board: roomBoard,
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

  // The kitchen, east of the pantry: five ranges under a hood on the back wall, each cook standing in
  // front of its own; a sink in the corner; and a butcher-block island with an aisle behind the cooks.
  // The prep counter's places run along the island's back (facing the room), its front, then its ends.
  const kitchenArea = { x: kx, y: 0, w: KITCHEN_W, h: KITCHEN_H };
  floors.push({ kind: 'kitchen', rect: kitchenArea });
  const stoves: KitchenPlan['stoves'] = [];
  for (let n = 1; n <= RANGES; n++) {
    const range = { x: kx + n, y: 0 };
    put({ kind: 'range', ...range, w: 1, h: 1, n });
    stoves.push({ range, stand: { x: range.x, y: 1 } });
  }
  put({ kind: 'sink', x: kx + RANGES + 1, y: 0, w: 1, h: 1 });
  const islandY = 4;
  put({ kind: 'prep_counter', x: kx + 1, y: islandY, w: RANGES, h: 1 });
  const counter: CounterPlace[] = [];
  for (let k = 1; k <= RANGES; k++)
    counter.push({ tile: { x: kx + k, y: islandY - 1 }, face: [0, 1], board: { x: kx + k, y: islandY } });
  for (let k = 1; k <= RANGES; k++)
    counter.push({ tile: { x: kx + k, y: islandY + 1 }, face: [0, -1], board: { x: kx + k, y: islandY } });
  counter.push({ tile: { x: kx, y: islandY }, face: [1, 0], board: { x: kx + 1, y: islandY } });
  counter.push({
    tile: { x: kx + RANGES + 1, y: islandY },
    face: [-1, 0],
    board: { x: kx + RANGES, y: islandY },
  });
  // No cap: past the counter, the rest of the kitchen floor, board in hand.
  const placed = new Set([
    ...stoves.map((s) => `${s.stand.x},${s.stand.y}`),
    ...counter.map((c) => `${c.tile.x},${c.tile.y}`),
  ]);
  for (let y = 1; y < KITCHEN_H; y++)
    for (let x = kx; x < kx + KITCHEN_W; x++)
      if (!blocked[y * width + x] && !placed.has(`${x},${y}`))
        counter.push({ tile: { x, y }, face: [0, y < islandY ? 1 : -1], board: null });

  // The review lounge, in front of the pantry: a pool table in the middle, a cue rack against the
  // left wall side, and room to stand round the table with a folder.
  const lounge = { x: px, y: PANTRY_H + 1, w: PANTRY_W, h: LOUNGE_H };
  floors.push({ kind: 'lounge', rect: lounge });
  const table = { x: px + 3, y: lounge.y + 2, w: 2, h: 3 };
  put({ kind: 'pool_table', ...table });
  put({ kind: 'cue_rack', x: px, y: lounge.y + 1, w: 1, h: 1 });
  put({ kind: 'plant', x: px + PANTRY_W - 1, y: lounge.y, w: 1, h: 1 });
  const ring: Tile[] = [];
  for (let y = table.y - 1; y <= table.y + table.h; y++)
    for (let x = table.x - 1; x <= table.x + table.w; x++)
      if (
        !blocked[y * width + x] &&
        (x < table.x || x >= table.x + table.w || y < table.y || y >= table.y + table.h)
      )
        ring.push({ x, y });
  // Round the table first (the long sides, then the ends), then the rest of the lounge.
  ring.sort(
    (a, b) =>
      Number(a.y === table.y - 1 || a.y === table.y + table.h) -
      Number(b.y === table.y - 1 || b.y === table.y + table.h),
  );
  const reviewSpots = [...ring];
  const ringKeys = new Set(ring.map((t) => `${t.x},${t.y}`));
  for (let y = lounge.y; y < lounge.y + lounge.h; y++)
    for (let x = lounge.x; x < lounge.x + lounge.w; x++)
      if (!blocked[y * width + x] && !ringKeys.has(`${x},${y}`)) reviewSpots.push({ x, y });

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
  areas.kitchen = kitchenArea;
  areas.review = lounge;

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
    kitchen: { area: kitchenArea, stoves, counter },
    review: { area: lounge, spots: reviewSpots },
    teams: plans,
    furniture,
    floors,
    areas,
  };
}
