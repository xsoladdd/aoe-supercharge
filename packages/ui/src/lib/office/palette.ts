import { headquarters } from './themes/headquarters';
import type { OfficeTheme } from './themes/types';

/**
 * Office art colours (SPEC §14.5): a night office for the dark theme, a day office for the light one, in
 * the office theme's colours (Headquarters by default). Status colours and the accent come from the
 * dashboard's own tokens, so a bubble's red is the same red as the Needs-you pill next to it; they, the
 * bubbles, the nameplates and the whiteboard's surface and inks are the same in every office theme.
 */

export interface Palette {
  theme: 'dark' | 'light';
  bg: number;
  /** Hardwood planks, and the seams between them. */
  corridor: [number, number];
  seam: number;
  pantry: [number, number];
  /** The review lounge's carpet. */
  lounge: [number, number];
  /** The kitchen: its checkered floor, the cast-iron ranges, the tiled splashback (and grout), the island's butcher block and cabinets, and copper pots. */
  kitchen: {
    floor: [number, number];
    iron: { top: number; left: number; right: number };
    tile: number;
    grout: number;
    block: number;
    cabinet: { left: number; right: number };
    copper: number;
  };
  /** Rug under each team, picked per project. */
  carpets: [number, number][];
  wallLeft: number;
  wallRight: number;
  wallTop: number;
  /** Crown moulding and skirting. */
  trim: number;
  baseboard: number;
  window: number;
  windowFrame: number;
  /** The rooms' low glass partitions: the pane, and the aluminium rail and posts. */
  glass: { pane: number; rail: number };
  curtain: number;
  wood: { top: number; left: number; right: number };
  metal: { top: number; left: number; right: number };
  monitor: number;
  screen: number;
  chair: number;
  plant: { pot: number; leaf: number; leafLight: number };
  fridge: { top: number; left: number; right: number };
  sofa: { seat: number; back: number };
  felt: number;
  door: number;
  doorFrame: number;
  brass: number;
  sign: number;
  signText: number;
  /** Your corner: painted panelling, the line's runner and velvet ropes, lamp light, the map, books. */
  panel: { face: number; frame: number; shadow: number };
  rope: number;
  runner: { base: number; border: number; pattern: number };
  glow: number;
  map: { paper: number; land: number; frame: number };
  /** The whiteboard: its surface and aluminium frame, and the marker colours written on it. */
  board: { surface: number; frame: number; ink: number; done: number; red: number };
  books: number[];
  shadow: number;
  ink: number;
  nameplate: number;
  nameplateText: number;
  bubble: number;
  accent: number;
  status: Record<'red' | 'yellow' | 'green' | 'blue' | 'violet' | 'cyan' | 'muted', number>;
}

const hex = (s: string, fallback: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  return m ? parseInt(m[1]!, 16) : fallback;
};

function token(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  return hex(getComputedStyle(document.documentElement).getPropertyValue(name), fallback);
}

export function makePalette(theme: 'dark' | 'light', office: OfficeTheme = headquarters): Palette {
  const status = {
    red: token('--st-red', theme === 'dark' ? 0xfa8486 : 0xb52427),
    yellow: token('--st-yellow', theme === 'dark' ? 0xf9cd03 : 0x7d5800),
    green: token('--st-green', theme === 'dark' ? 0x34d27b : 0x106e40),
    blue: token('--st-blue', theme === 'dark' ? 0x61afff : 0x095db7),
    violet: token('--st-violet', theme === 'dark' ? 0xc599ea : 0x732cec),
    cyan: token('--st-cyan', theme === 'dark' ? 0x38c6e0 : 0x0a6879),
    muted: token('--st-muted', theme === 'dark' ? 0x8f9193 : 0x5e6168),
  };
  const colours = office.colours[theme];
  if (theme === 'dark')
    return {
      ...colours,
      theme,
      bg: token('--background', 0x17191a),
      // A little dimmer than paper white, so it does not glare in the dark.
      board: { surface: 0xdde1e4, frame: colours.board.frame, ink: 0x1d3a6b, done: 0x7d8891, red: 0xb3392f },
      ink: 0x2a2421,
      nameplate: 0x1f2125,
      nameplateText: 0xf4f4f5,
      bubble: token('--card', 0x27292d),
      accent: token('--primary', 0xb780e5),
      status,
    };
  return {
    ...colours,
    theme,
    bg: token('--background', 0xeef0f2),
    board: { surface: 0xf8f9fa, frame: colours.board.frame, ink: 0x1d3a6b, done: 0x8a949c, red: 0xb3392f },
    ink: 0x2a2421,
    nameplate: 0x16171a,
    nameplateText: 0xf4f4f5,
    bubble: token('--card', 0xfcfcfd),
    accent: token('--primary', 0x7c3aed),
    status,
  };
}
