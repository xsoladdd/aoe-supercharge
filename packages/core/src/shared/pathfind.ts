/**
 * A* on a tile grid, for workers walking around the office (SPEC §14.5). Eight directions, but a
 * diagonal step never cuts the corner of a blocked tile, so nobody clips through a desk.
 */

export interface Tile {
  x: number;
  y: number;
}

export interface Grid {
  width: number;
  height: number;
  /** True where furniture stands. Outside the grid counts as blocked. */
  blocked(x: number, y: number): boolean;
  /**
   * True when a wall runs between two neighbouring tiles (a glass partition along a room's edge), so
   * nobody walks through it. Optional: a grid without one has no walls between tiles.
   */
  wall?(ax: number, ay: number, bx: number, by: number): boolean;
}

/** The key of the grid line between two orthogonal neighbours: `v<x>,<y>` or `h<x>,<y>`. */
export function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  return ay === by ? `v${Math.max(ax, bx)},${ay}` : `h${ax},${Math.max(ay, by)}`;
}

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/** A binary min-heap of [score, node] pairs. Scores are snapshots, so a re-push never breaks it. */
class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(score: number, node: number) {
    const a = this.items;
    a.push([score, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top[1];
  }
}

/**
 * The shortest path from `from` to `to`, both ends included, or null when there is none. The start
 * may be blocked (a worker getting up from a sofa); the goal may not.
 */
export function findPath(grid: Grid, from: Tile, to: Tile): Tile[] | null {
  const { width: w, height: h } = grid;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  if (!inside(from.x, from.y) || !inside(to.x, to.y) || grid.blocked(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  const free = (x: number, y: number) => inside(x, y) && !grid.blocked(x, y);
  const wall = grid.wall ? grid.wall.bind(grid) : () => false;
  const n = w * h;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  g[start] = 0;
  const open = new Heap();
  open.push(octile(from.x, from.y, to.x, to.y), start);
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!free(nx, ny)) continue;
      if (!(dx && dy) && wall(cx, cy, nx, ny)) continue;
      // No corner cutting: both sides of a diagonal step must be open, and no wall on either way round.
      if (dx && dy && (!free(cx + dx, cy) || !free(cx, cy + dy))) continue;
      if (
        dx &&
        dy &&
        (wall(cx, cy, cx + dx, cy) ||
          wall(cx + dx, cy, nx, ny) ||
          wall(cx, cy, cx, cy + dy) ||
          wall(cx, cy + dy, nx, ny))
      )
        continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const tentative = g[cur]! + cost;
      if (tentative < g[ni]!) {
        g[ni] = tentative;
        came[ni] = cur;
        open.push(tentative + octile(nx, ny, to.x, to.y), ni);
      }
    }
  }
  if (came[goal] === -1) return null;
  const path: Tile[] = [];
  for (let i = goal; i !== -1; i = came[i]!) path.push({ x: i % w, y: Math.floor(i / w) });
  return path.reverse();
}
