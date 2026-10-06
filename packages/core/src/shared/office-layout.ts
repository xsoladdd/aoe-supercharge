import type { Grid, Tile } from './pathfind.ts';

/**
 * The office floor plan (SPEC §14.5), in tiles: x runs along the back wall, y along the left wall.
 * One team block per project (lead desk, then rows of desks), your door with the queue lane in front
 * of it, the pantry in the far corner, and the entrance on the left wall. It grows with the teams.
 *
 *   wall A (y = -1): whiteboard ...... your door ...... pantry counter, fridge
 *   x = 0 corridor | team blocks | lane (queue) | pantry
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
  | 'foosball';

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

export interface OfficeLayout {
  width: number;
  height: number;
  grid: Grid;
  /** First tile inside the entrance on the left wall; new workers walk in from here. */
  entrance: Tile;
  /** The tile in front of your door; a called worker steps through it. */
  door: Tile;
  /** Queue spots, front of the line first. */
  queue: Tile[];
  pantry: { area: Rect; spots: { tile: Tile; seat: PantrySeat }[] };
  teams: TeamPlan[];
  furniture: Furniture[];
  floors: { kind: 'carpet' | 'pantry' | 'lane'; rect: Rect; team?: string }[];
  /** Camera targets: `office`, `door`, `pantry` and each project name. */
  areas: Record<string, Rect>;
}

const PANTRY_W = 8;
const PANTRY_H = 7;

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
  const teamsW = teamCols * blockW + (teamCols - 1);
  const teamsH = rowHeights.reduce((a, b) => a + b, 0) + Math.max(0, rowHeights.length - 1);

  const laneX = 1 + teamsW + 1;
  const q = laneX + 1;
  const px = laneX + 3 + 1;
  const width = px + PANTRY_W + 1;
  const height = Math.max(1 + teamsH + 1, PANTRY_H + 2, 10);

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

  // Team blocks.
  const plans: TeamPlan[] = [];
  let rowY = 1;
  teams.forEach((t, i) => {
    const c = i % teamCols;
    const r = Math.floor(i / teamCols);
    if (c === 0 && r > 0) rowY += rowHeights[r - 1]! + 1;
    const bx = 1 + c * (blockW + 1);
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

  // The lane in front of your door, and the queue snaking through it.
  floors.push({ kind: 'lane', rect: { x: laneX, y: 0, w: 3, h: height } });
  const queue: Tile[] = [];
  for (let y = 1; y < height - 1; y++) queue.push({ x: q, y });
  for (let y = height - 2; y >= 1; y--) queue.push({ x: q + 1, y });
  for (let y = 1; y < height - 1; y++) queue.push({ x: q - 1, y });

  // The pantry, against the back wall in the far corner.
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

  // Plants in the corners by the entrance and the lane.
  put({ kind: 'plant', x: 0, y: height - 1, w: 1, h: 1 });
  put({ kind: 'plant', x: laneX - 1, y: 0, w: 1, h: 1 });

  areas.office = { x: 0, y: 0, w: width, h: height };
  areas.door = { x: q - 2, y: 0, w: 5, h: Math.min(height, 9) };
  areas.pantry = pantryArea;

  return {
    width,
    height,
    grid: {
      width,
      height,
      blocked: (x, y) => x < 0 || y < 0 || x >= width || y >= height || blocked[y * width + x] === 1,
    },
    entrance: { x: 0, y: 1 },
    door: { x: q, y: 0 },
    queue,
    pantry: { area: pantryArea, spots },
    teams: plans,
    furniture,
    floors,
    areas,
  };
}
