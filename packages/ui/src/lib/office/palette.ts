/**
 * Office art colours (SPEC §14.5): a night office for the dark theme, a day office for the light one.
 * Status colours and the accent come from the dashboard's own tokens, so a bubble's red is the same
 * red as the Needs-you pill next to it.
 */

export interface Palette {
  theme: 'dark' | 'light';
  bg: number;
  /** Hardwood planks, and the seams between them. */
  corridor: [number, number];
  seam: number;
  pantry: [number, number];
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

export function makePalette(theme: 'dark' | 'light'): Palette {
  const status = {
    red: token('--st-red', theme === 'dark' ? 0xfa8486 : 0xb52427),
    yellow: token('--st-yellow', theme === 'dark' ? 0xf9cd03 : 0x7d5800),
    green: token('--st-green', theme === 'dark' ? 0x34d27b : 0x106e40),
    blue: token('--st-blue', theme === 'dark' ? 0x61afff : 0x095db7),
    violet: token('--st-violet', theme === 'dark' ? 0xc599ea : 0x732cec),
    cyan: token('--st-cyan', theme === 'dark' ? 0x38c6e0 : 0x0a6879),
    muted: token('--st-muted', theme === 'dark' ? 0x8f9193 : 0x5e6168),
  };
  // Dark: a study at night, after the reference photo: near-black panelling, walnut, brass, cognac
  // leather, a charcoal rug and leather-bound books.
  if (theme === 'dark')
    return {
      theme,
      bg: token('--background', 0x17191a),
      corridor: [0x2b2019, 0x2f231b],
      seam: 0x1b140f,
      pantry: [0x2d3033, 0x282b2e],
      carpets: [
        [0x232a35, 0x262e3a],
        [0x1f2d27, 0x22322b],
        [0x34201f, 0x382322],
        [0x2d2233, 0x312538],
        [0x352a1c, 0x392e1f],
        [0x1f2f33, 0x223438],
      ],
      wallLeft: 0x141919,
      wallRight: 0x192020,
      wallTop: 0x262e2d,
      trim: 0x2f3836,
      baseboard: 0x0e1212,
      window: 0x14263a,
      windowFrame: 0x2a3231,
      glass: { pane: 0x7fb4d9, rail: 0x8a939c },
      curtain: 0x3b2c25,
      wood: { top: 0x6e4a32, left: 0x573823, right: 0x472c1c },
      metal: { top: 0x5a5e67, left: 0x43464d, right: 0x383b41 },
      monitor: 0x15171b,
      screen: 0x3d7fc4,
      chair: 0x232528,
      plant: { pot: 0x6b4a32, leaf: 0x2f7a4a, leafLight: 0x46a066 },
      fridge: { top: 0x8f959e, left: 0x777d86, right: 0x666b73 },
      sofa: { seat: 0x5c3a28, back: 0x4b2f20 },
      felt: 0x2f6f4a,
      door: 0x5e3b25,
      doorFrame: 0x2e1f15,
      brass: 0xc29a48,
      sign: 0x15181a,
      signText: 0xe9d9b0,
      panel: { face: 0x1b2122, frame: 0x262e2e, shadow: 0x101414 },
      rope: 0x7a2b2b,
      runner: { base: 0x2a2d31, border: 0x3a3f45, pattern: 0x33373c },
      glow: 0xffc87a,
      map: { paper: 0xe2d4b8, land: 0x8a5a36, frame: 0x6e4a32 },
      // A little dimmer than paper white, so it does not glare in the dark study.
      board: { surface: 0xdde1e4, frame: 0x8e979f, ink: 0x1d3a6b, done: 0x7d8891, red: 0xb3392f },
      books: [0x7a3b22, 0x8c4a28, 0x5a3420, 0x9a5a30, 0x6b2f2a, 0xb07a4a],
      shadow: 0x000000,
      ink: 0x2a2421,
      nameplate: 0x1f2125,
      nameplateText: 0xf4f4f5,
      bubble: token('--card', 0x27292d),
      accent: token('--primary', 0xb780e5),
      status,
    };
  // Light: the navy study by day, after the reference photo: navy walls with white trim, espresso floor,
  // cream rugs, walnut, brass, curtains and a framed world map.
  return {
    theme,
    bg: token('--background', 0xeef0f2),
    corridor: [0x3d2c22, 0x392920],
    seam: 0x281c15,
    pantry: [0xe7e4dd, 0xdcd8cf],
    carpets: [
      [0xe9e3d6, 0xe3dccd],
      [0xd9dfd0, 0xd2d9c8],
      [0xe6d9c3, 0xe0d2b9],
      [0xd6dde4, 0xcfd7df],
      [0xe8d8d3, 0xe2d0ca],
      [0xdedbd2, 0xd7d3c9],
    ],
    wallLeft: 0x2c3e52,
    wallRight: 0x34495f,
    wallTop: 0xf1eee8,
    trim: 0xf1eee8,
    baseboard: 0xece8e0,
    window: 0xcfe7f7,
    windowFrame: 0xffffff,
    glass: { pane: 0x9cc9e6, rail: 0x9aa3ad },
    curtain: 0xeee4d3,
    wood: { top: 0x8b5a3a, left: 0x70462c, right: 0x5c3923 },
    metal: { top: 0xb7bcc5, left: 0x9ea4ae, right: 0x8a909a },
    monitor: 0x2b2e35,
    screen: 0x8fc4f5,
    chair: 0x3a3d44,
    plant: { pot: 0xc0784d, leaf: 0x3f9a5c, leafLight: 0x62bb7c },
    fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
    sofa: { seat: 0x6e4632, back: 0x5c3826 },
    felt: 0x3f8f5f,
    door: 0x7a4e30,
    doorFrame: 0x4f321f,
    brass: 0xc29a48,
    sign: 0x1f2a36,
    signText: 0xf1e6c8,
    panel: { face: 0x2c3e52, frame: 0x3b5169, shadow: 0x223244 },
    rope: 0x8c2f2f,
    runner: { base: 0xe6dfd1, border: 0xcfc5b2, pattern: 0xd9d0bf },
    glow: 0xffd28a,
    map: { paper: 0xf3ecdd, land: 0x9a6a44, frame: 0x7a4e30 },
    board: { surface: 0xf8f9fa, frame: 0xa9b1b8, ink: 0x1d3a6b, done: 0x8a949c, red: 0xb3392f },
    books: [0x7a3b22, 0x8c4a28, 0xb07a4a, 0x2f4a5c, 0x5a3420, 0xd8c7a8],
    shadow: 0x2a2d35,
    ink: 0x2a2421,
    nameplate: 0x16171a,
    nameplateText: 0xf4f4f5,
    bubble: token('--card', 0xfcfcfd),
    accent: token('--primary', 0x7c3aed),
    status,
  };
}
