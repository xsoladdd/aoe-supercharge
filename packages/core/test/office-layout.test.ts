import { describe, expect, it } from 'vitest';
import { findPath, officeLayout, type Grid, type Tile } from '../src/shared/index.ts';

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
    expect(Object.keys(big.areas).sort()).toEqual(['a', 'b', 'c', 'door', 'office', 'pantry']);
    // The front of the line sits on the chair beside your door; the first few spots are chairs.
    expect(big.queue[0]).toEqual({ x: big.door.x - 1, y: big.door.y });
    expect(big.queueSeats).toBeGreaterThan(0);
    expect(big.pantry.spots.length).toBeGreaterThanOrEqual(16);
  });

  it('puts your door at the far east end of the back wall, with the line beside it', () => {
    const l = officeLayout([
      { project: 'a', desks: 4 },
      { project: 'b', desks: 4 },
    ]);
    // Your door is on the back wall, east of every team and the pantry, near the east edge.
    expect(l.door.y).toBe(0);
    expect(l.width - l.door.x).toBeLessThanOrEqual(4);
    for (const t of l.teams) expect(t.area.x + t.area.w).toBeLessThan(l.door.x);
    expect(l.pantry.area.x + l.pantry.area.w).toBeLessThan(l.door.x);
    // The chairs line the wall beside it, nearest first; the rest of the line stands in front of them.
    const chairs = l.queue.slice(0, l.queueSeats);
    expect(chairs.map((t) => t.y)).toEqual(chairs.map(() => 0));
    expect(chairs.map((t) => l.door.x - t.x)).toEqual(chairs.map((_, i) => i + 1));
    for (const t of l.queue) {
      expect(t.x).toBeGreaterThanOrEqual(l.suite.x);
      expect(t.x).toBeLessThan(l.suite.x + l.suite.w);
    }
  });

  it('is the same for the same teams', () => {
    const t = [
      { project: 'a', desks: 4 },
      { project: 'b', desks: 2 },
    ];
    expect(JSON.stringify(officeLayout(t).furniture)).toBe(JSON.stringify(officeLayout(t).furniture));
  });
});
