import type { Graphics } from 'pixi.js';
import type { Edge, Furniture, OfficeLayout, Rect, TeamPlan, WindowLook } from '@aoe-supercharge/core/shared';
import type { Palette } from '../palette';

/**
 * Office themes (SPEC §14.5): a theme restyles the floor, the walls, the windows and some props. It never
 * moves anything: rooms, desks, the line, the pantry, the kitchen and the lounge stay where they are and
 * mean what they mean. Headquarters, the study, is the default and is drawn by the default art kit.
 */

export type Mode = 'dark' | 'light';

/**
 * What a theme colours: the palette, less what carries meaning. Status colours, the accent, bubbles,
 * nameplates and the whiteboard's surface and inks are the same in every theme, so a red bubble is the
 * same red as the Needs-you pill, and notes read the same everywhere. A theme sets only the board's frame.
 */
export type ThemeColours = Omit<
  Palette,
  'theme' | 'bg' | 'status' | 'accent' | 'bubble' | 'nameplate' | 'nameplateText' | 'ink' | 'board'
> & { board: { frame: number } };

/** Which zone a floor tile is in; `open` is the office floor between them. */
export type FloorKind = 'open' | 'carpet' | 'pantry' | 'kitchen' | 'lounge' | 'runner';

export interface FloorTile {
  kind: FloorKind;
  /** The zone's rectangle; null on the open floor. */
  rect: Rect | null;
  /** The zone's two tones (a team's rug, the pantry's tiles), alternating tile by tile. */
  tones: [number, number];
}

/** Your corner of the back wall: from `x0` to the east wall `x1`, your door at `door`. */
export interface SuiteSpot {
  x0: number;
  x1: number;
  door: number;
}

/** A small thing that moves (a flame, a flicker): its own drawing, redrawn for time `t` in ms. */
export interface Motion {
  g: Graphics;
  draw(t: number): void;
}

/**
 * Where a theme draws. Each slot is called where Headquarters draws that part, on the Graphics it draws
 * it on, so a theme can restyle a part without moving it. Anything a theme leaves out is drawn as at
 * Headquarters. Pieces keep their footprint and heights: people stand and sit where they did, and plates
 * and pots land where they did.
 */
export interface ThemeArt {
  /** One floor tile. Headquarters: hardwood planks on the open floor, two-tone tiles in each zone. */
  floor(g: Graphics, p: Palette, x: number, y: number, tile: FloorTile): void;
  /** The border of a team's rug, in its colour. Headquarters: a band and an inner line. */
  rug(g: Graphics, p: Palette, area: Rect, color: number): void;
  /** The runner out from your door, over its floor tiles. Headquarters: a border and a lozenge pattern. */
  runner(g: Graphics, p: Palette, r: Rect): void;
  /** Both walls, their skirting, moulding and caps. Headquarters: painted walls with white trim. */
  walls(g: Graphics, p: Palette, layout: OfficeLayout): void;
  /** One window on the left wall from `gy`: the pane on the wall, its dressing on `drapes` over the sky. */
  window(g: Graphics, drapes: Graphics, p: Palette, gy: number): void;
  /** What one window shows (`look`: how bright, how cloudy, rain or snow), redrawn as the light eases. */
  view(g: Graphics, p: Palette, gy: number, look: WindowLook): void;
  /** The doorway in from the left wall at `e`, and its mat. The green exit sign goes over it regardless. */
  entrance(g: Graphics, p: Palette, e: number): void;
  /** The big piece on the back wall over the teams, from x0 to x1. Headquarters: a framed world map. */
  feature(g: Graphics, p: Palette, x0: number, x1: number): void;
  /** Your corner of the back wall, round your door. Headquarters: panelling, bookcases and sconces. */
  suite(g: Graphics, p: Palette, s: SuiteSpot): void;
  /** Your door at `q`, open or shut, frame and all. Headquarters: a walnut double door. */
  door(g: Graphics, p: Palette, q: number, open: boolean): void;
  /**
   * Wall-hung extras (banners, ducts, lanterns), drawn over the walls; and any small moving bits, each on
   * a drawing of its own from `make`, drawn at rest (t = 0) and now and then at other times.
   */
  extras?(g: Graphics, p: Palette, layout: OfficeLayout, make: () => Graphics): Motion[] | void;
  /** One pane of a room's partition. Headquarters: low glass with a rail. */
  partition(g: Graphics, p: Palette, e: Edge): void;
  /** The posts and lintel of a room's doorway (its nameplate goes over them). */
  doorway(g: Graphics, p: Palette, t: TeamPlan): void;
  plant(g: Graphics, p: Palette, x: number, y: number): void;
  /** The side table and lamp by your door. */
  lamp(g: Graphics, p: Palette, f: Furniture): void;
  /** A desk at (x, y) of desk furniture `f`, with its monitor if `monitor`. */
  desk(g: Graphics, p: Palette, f: Furniture, x: number, y: number, monitor: boolean): void;
  chair(g: Graphics, p: Palette, x: number, y: number): void;
  stool(g: Graphics, p: Palette, x: number, y: number): void;
  /** One tile (`ty`) of the rope beside your line, with the posts that stand on it. */
  rope(g: Graphics, p: Palette, f: Furniture, door: number, ty: number): void;
  /** Tile `i` of the pantry counter. */
  counter(g: Graphics, p: Palette, f: Furniture, i: number): void;
  coffee(g: Graphics, p: Palette, f: Furniture): void;
  fridge(g: Graphics, p: Palette, f: Furniture): void;
  cooler(g: Graphics, p: Palette, f: Furniture): void;
  /** A pantry table: its top at the height plates are set down on. */
  table(g: Graphics, p: Palette, f: Furniture): void;
  /** Tile `i` of the pantry sofa. */
  sofa(g: Graphics, p: Palette, f: Furniture, i: number): void;
  /** Tile `i` of the foosball table. */
  foosball(g: Graphics, p: Palette, f: Furniture, i: number): void;
  /** Tile (dx, dy) of the review lounge's pool table. */
  poolTable(g: Graphics, p: Palette, f: Furniture, dx: number, dy: number): void;
  cueRack(g: Graphics, p: Palette, f: Furniture): void;
}

/** How the picker's thumbnail hints at the floor. */
export type FloorHint = 'planks' | 'slabs' | 'mats' | 'flags' | 'pattern' | 'plates';

export interface OfficeTheme {
  id: string;
  name: string;
  /** A few words for the picker. */
  blurb: string;
  colours: Record<Mode, ThemeColours>;
  art?: Partial<ThemeArt>;
  /** The picker's thumbnail: the floor's pattern, and the colour that says the theme at a glance. */
  thumb: { floor: FloorHint; accent: Record<Mode, number> };
}
