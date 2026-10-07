import { describe, expect, it } from 'vitest';
import { edgeKey, findPath, officeLayout, type Grid, type Tile } from '../src/shared/index.ts';

const open = (w: number, h: number, walls: string[] = []): Grid => ({
  width: w,
  height: h,
  blocked: (x, y) => x < 0 || y < 0 || x >= w || y >= h || walls.includes(`${x},${y}`),
});

describe('pathfind', () => {
  it('walks straight when nothing is in the way, and diagonally when shorter', () => {
    expect(findPath(open(5, 1), { x: 0, y: 0 }, { x: 4, y: 0 })).toHaveLength(5);
    expect(findPath(open(5, 5), { x: 0, y: 0 }, { x: 4, y: 4 })).toHaveLength(5);
    expect(findPath(open(3, 3), { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
  });

  it('goes around furniture without cutting its corners', () => {
    // A wall at x = 1 except the bottom row.
    const g = open(3, 3, ['1,0', '1,1']);
    const path = findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path.at(-1)).toEqual({ x: 2, y: 0 });
    for (const t of path) expect(g.blocked(t.x, t.y)).toBe(false);
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [path[i - 1]!, path[i]!];
      if (a.x !== b.x && a.y !== b.y) {
        expect(g.blocked(b.x, a.y)).toBe(false);
        expect(g.blocked(a.x, b.y)).toBe(false);
      }
    }
  });

  it('gives up when the goal is walled in or blocked', () => {
    expect(findPath(open(3, 3, ['1,0', '1,1', '1,2']), { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
    expect(findPath(open(3, 3, ['2,2']), { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });
});

describe('office layout', () => {
  const reachable = (grid: Grid, from: Tile, tiles: Tile[]) =>
    tiles.filter((t) => !findPath(grid, from, t)).map((t) => `${t.x},${t.y}`);

  it('every seat, queue spot, pantry spot and the door can be walked to from the entrance', () => {
    for (const teams of [
      [],
      [{ project: 'a', desks: 1 }],
      [
        { project: 'a', desks: 6 },
        { project: 'b', desks: 2 },
      ],
      Array.from({ length: 5 }, (_, i) => ({ project: `p${i}`, desks: 3 + i * 2 })),
    ]) {
      const l = officeLayout(teams);
      const goals = [
        l.door,
        ...l.queue,
        ...l.pantry.spots.map((s) => s.tile),
        ...l.review.spots,
        ...l.teams.flatMap((t) => [t.leadSeat, ...t.spare, ...t.desks.map((d) => d.seat)]),
      ];
      for (const g of goals) expect(l.grid.blocked(g.x, g.y), `${g.x},${g.y}`).toBe(false);
      expect(reachable(l.grid, l.entrance, goals)).toEqual([]);
      const keys = goals.map((g) => `${g.x},${g.y}`);
      // Seats, queue and pantry spots never share a tile (spares may sit on the queue's corridor).
      const seats = l.teams
        .flatMap((t) => [t.leadSeat, ...t.desks.map((d) => d.seat)])
        .map((g) => `${g.x},${g.y}`);
      expect(new Set(seats).size).toBe(seats.length);
      expect(keys.length).toBeGreaterThan(0);
    }
  });

  it('has a desk for every number in use, and grows with the teams', () => {
    const small = officeLayout([{ project: 'a', desks: 2 }]);
    const big = officeLayout([
      { project: 'a', desks: 9 },
      { project: 'b', desks: 3 },
      { project: 'c', desks: 1 },
    ]);
    expect(big.teams[0]!.desks.map((d) => d.n).slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(big.width * big.height).toBeGreaterThan(small.width * small.height);
    expect(Object.keys(big.areas).sort()).toEqual([
      'a',
      'b',
      'board',
      'c',
      'door',
      'office',
      'pantry',
      'review',
    ]);
    // The whiteboard hangs between the pantry and your corner, in every office.
    for (const l of [small, big]) {
      expect(l.board.x1).toBeLessThanOrEqual(l.suite.x);
      expect(l.board.x0).toBeGreaterThanOrEqual(l.pantry.area.x + l.pantry.area.w);
    }
    // The front of the line stands just in front of your door.
    expect(big.queue[0]).toEqual({ x: big.door.x, y: big.door.y + 1 });
    expect(big.pantry.spots.length).toBeGreaterThanOrEqual(16);
  });

  it('puts your door at the far east end of the back wall, with the line standing out from it', () => {
    const l = officeLayout([
      { project: 'a', desks: 4 },
      { project: 'b', desks: 4 },
    ]);
    // Your door is on the back wall, east of every team and the pantry, near the east edge.
    expect(l.door.y).toBe(0);
    expect(l.width - l.door.x).toBeLessThanOrEqual(4);
    for (const t of l.teams) expect(t.area.x + t.area.w).toBeLessThan(l.door.x);
    expect(l.pantry.area.x + l.pantry.area.w).toBeLessThan(l.door.x);
    // No chairs: the line stands in single file straight out from your door, one step apart, then
    // turns west along the front of the office.
    const straight = l.queue.filter((t) => t.x === l.door.x);
    expect(straight.map((t) => t.y)).toEqual(straight.map((_, i) => l.door.y + 1 + i));
    expect(straight.length).toBeGreaterThanOrEqual(8);
    const turn = l.queue.slice(straight.length);
    expect(turn.map((t) => t.y)).toEqual(turn.map(() => straight.at(-1)!.y));
    expect(turn.map((t) => l.door.x - t.x)).toEqual(turn.map((_, i) => i + 1));
    for (const t of l.queue) expect(l.grid.blocked(t.x, t.y)).toBe(false);
    // Ropes run along both sides of the front of the line, so nobody walks in from the side: the way
    // in to the first place is up the line from behind.
    const ropes = l.furniture.filter((f) => f.kind === 'rope');
    expect(ropes.map((f) => f.x).sort((a, b) => a - b)).toEqual([l.door.x - 1, l.door.x + 1]);
    for (const f of ropes) for (let y = f.y; y < f.y + f.h; y++) expect(l.grid.blocked(f.x, y)).toBe(true);
    const path = findPath(l.grid, l.entrance, l.queue[0]!)!;
    const roped = ropes[0]!.y + ropes[0]!.h;
    const into = path.findIndex((t) => t.x === l.door.x && t.y < roped);
    expect(path.slice(into).every((t) => t.x === l.door.x)).toBe(true);
  });

  it('is the same for the same teams', () => {
    const t = [
      { project: 'a', desks: 4 },
      { project: 'b', desks: 2 },
    ];
    expect(JSON.stringify(officeLayout(t).furniture)).toBe(JSON.stringify(officeLayout(t).furniture));
  });
});

describe('rooms', () => {
  const tileIn = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
    x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

  it('a wall between two tiles stops a straight step and a diagonal round it', () => {
    const g: Grid = { ...open(3, 3), wall: (ax, ay, bx, by) => edgeKey(ax, ay, bx, by) === 'v1,0' };
    // Down, across and back up: no diagonal past either end of the wall.
    expect(findPath(g, { x: 0, y: 0 }, { x: 1, y: 0 })).toHaveLength(4);
    const diag: Grid = { ...open(2, 2), wall: (ax, ay, bx, by) => edgeKey(ax, ay, bx, by) === 'v1,0' };
    // (0,0) to (1,1) the short way would pass along the wall's end: it goes round by (0,1).
    expect(findPath(diag, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('every room has glass all round but a doorway, and nobody walks through the glass', () => {
    const l = officeLayout([
      { project: 'a', desks: 10 },
      { project: 'b', desks: 7 },
      { project: 'c', desks: 5 },
    ]);
    for (const t of l.teams) {
      const { x, y, w, h } = t.area;
      // Perimeter, less the doorway's two panes.
      expect(t.walls).toHaveLength(2 * w + 2 * h - 2);
      expect(t.doorway.x1 - t.doorway.x0).toBe(2);
      expect(t.doorway.y).toBe(y + h);
      // Every path from the entrance to a seat in the room comes in through the doorway.
      for (const d of t.desks) {
        const path = findPath(l.grid, l.entrance, d.seat)!;
        expect(path).not.toBeNull();
        const into = path.findIndex((p) => tileIn(t.area, p.x, p.y));
        const before = path[into - 1]!;
        const at = path[into]!;
        expect(before.y, `${t.project} desk ${d.n}`).toBe(y + h);
        expect(at.y).toBe(y + h - 1);
        expect(at.x >= t.doorway.x0 && at.x < t.doorway.x1).toBe(true);
        // Straight in, or diagonally within the doorway's width.
        expect(before.x >= t.doorway.x0 && before.x < t.doorway.x1).toBe(true);
        // Once inside, it stays inside.
        expect(path.slice(into).every((p) => tileIn(t.area, p.x, p.y))).toBe(true);
      }
      expect(x).toBeGreaterThan(0);
    }
  });

  it('2 to 3 projects with 5 to 10 desks each fit without overlap', () => {
    for (const n of [2, 3])
      for (const desks of [5, 10]) {
        const l = officeLayout(Array.from({ length: n }, (_, i) => ({ project: `p${i}`, desks })));
        const rects = [...l.teams.map((t) => t.area), l.pantry.area, l.suite];
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i]!;
            const b = rects[j]!;
            const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            expect(apart, `${n}x${desks}: ${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(true);
          }
        // Every desk number in use has a seat, and no two blocking pieces share a tile.
        for (const t of l.teams) expect(t.desks.length).toBeGreaterThanOrEqual(desks);
        const tiles = l.furniture
          .filter((f) => f.kind !== 'coffee' && f.kind !== 'sofa')
          .flatMap((f) =>
            Array.from({ length: f.w * f.h }, (_, k) => `${f.x + (k % f.w)},${f.y + Math.floor(k / f.w)}`),
          );
        expect(new Set(tiles).size).toBe(tiles.length);
        // The doorway's tiles inside and out are free.
        for (const t of l.teams)
          for (let x = t.doorway.x0; x < t.doorway.x1; x++) {
            expect(l.grid.blocked(x, t.doorway.y - 1)).toBe(false);
            expect(l.grid.blocked(x, t.doorway.y)).toBe(false);
          }
      }
  });
});

describe('review lounge', () => {
  it('stands round a pool table in front of the pantry, clear of the rooms and the entrance', () => {
    for (const n of [0, 1, 3]) {
      const l = officeLayout(Array.from({ length: n }, (_, i) => ({ project: `p${i}`, desks: 10 })));
      const a = l.review.area;
      expect(l.areas.review).toEqual(a);
      expect(l.furniture.filter((f) => f.kind === 'pool_table')).toHaveLength(1);
      expect(a.y).toBeGreaterThanOrEqual(l.pantry.area.y + l.pantry.area.h);
      expect(l.entrance.x).toBeLessThan(a.x);
      for (const t of l.teams) expect(t.area.x).toBeGreaterThanOrEqual(a.x + a.w);
      // Room for a crowd: at least ten places, the first ones right by the table, all different.
      expect(l.review.spots.length).toBeGreaterThanOrEqual(10);
      const keys = l.review.spots.map((t) => `${t.x},${t.y}`);
      expect(new Set(keys).size).toBe(keys.length);
      const table = l.furniture.find((f) => f.kind === 'pool_table')!;
      const first = l.review.spots[0]!;
      expect(first.x >= table.x - 1 && first.x <= table.x + table.w && first.y >= table.y - 1).toBe(true);
    }
  });
});
