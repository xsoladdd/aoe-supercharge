/**
 * Office art colours (SPEC §14.5): a night office for the dark theme, a day office for the light one.
 * Status colours and the accent come from the dashboard's own tokens, so a bubble's red is the same
 * red as the Needs-you pill next to it.
 */

export interface Palette {
  theme: 'dark' | 'light';
  bg: number;
  corridor: [number, number];
  /** Your office's wood floor, and its glass walls. */
  officeFloor: [number, number];
  rug: number;
  glass: number;
  glassFrame: number;
  pantry: [number, number];
  /** Carpet under each team, picked per project. */
  carpets: [number, number][];
  wallLeft: number;
  wallRight: number;
  wallTop: number;
  baseboard: number;
  window: number;
  windowFrame: number;
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
  if (theme === 'dark')
    return {
      theme,
      bg: token('--background', 0x17191a),
      corridor: [0x2b2d33, 0x2f3238],
      officeFloor: [0x4a3a2c, 0x45362a],
      rug: 0x2f4a5c,
      glass: 0x7fb3d5,
      glassFrame: 0x8a8f99,
      pantry: [0x3a3f47, 0x333840],
      carpets: [
        [0x2c3756, 0x303b5c],
        [0x3a2c50, 0x3f3056],
        [0x2a4641, 0x2e4b46],
        [0x463829, 0x4b3c2d],
        [0x47293a, 0x4d2d3f],
        [0x2e4630, 0x324b34],
      ],
      wallLeft: 0x24272c,
      wallRight: 0x2c2f35,
      wallTop: 0x3a3d43,
      baseboard: 0x1d1f23,
      window: 0x1f3550,
      windowFrame: 0x3a3d43,
      wood: { top: 0x7a5c43, left: 0x5c4532, right: 0x4b3829 },
      metal: { top: 0x5a5e67, left: 0x43464d, right: 0x383b41 },
      monitor: 0x15171b,
      screen: 0x3d7fc4,
      chair: 0x3c3f46,
      plant: { pot: 0x8a5a3c, leaf: 0x2f7a4a, leafLight: 0x46a066 },
      fridge: { top: 0xb9bec8, left: 0x9aa0aa, right: 0x858b95 },
      sofa: { seat: 0x5b4a82, back: 0x4a3c6c },
      felt: 0x2f6f4a,
      door: 0x6b4f36,
      doorFrame: 0x3a2c20,
      brass: 0xc9a227,
      sign: 0x27292d,
      signText: 0xf4f4f5,
      shadow: 0x000000,
      ink: 0x2a2421,
      nameplate: 0x1f2125,
      nameplateText: 0xf4f4f5,
      bubble: token('--card', 0x27292d),
      accent: token('--primary', 0xb780e5),
      status,
    };
  return {
    theme,
    bg: token('--background', 0xeef0f2),
    corridor: [0xe4e6ea, 0xdfe1e6],
    officeFloor: [0xd9b88f, 0xd2b087],
    rug: 0x7c9fb8,
    glass: 0xa9d4ee,
    glassFrame: 0x9aa1ab,
    pantry: [0xf6f6f3, 0xe8e9e4],
    carpets: [
      [0xcdd8f2, 0xc6d2ef],
      [0xe1d3f0, 0xdccdec],
      [0xcce7e0, 0xc4e2da],
      [0xefdfca, 0xebd8c1],
      [0xf1d2db, 0xeccad4],
      [0xd5ebcf, 0xcde6c6],
    ],
    wallLeft: 0xd5d9e0,
    wallRight: 0xe3e6eb,
    wallTop: 0xc4c9d1,
    baseboard: 0xb8bdc6,
    window: 0xbfe0fb,
    windowFrame: 0xffffff,
    wood: { top: 0xc9a27a, left: 0xa8835f, right: 0x8e6d4f },
    metal: { top: 0xb7bcc5, left: 0x9ea4ae, right: 0x8a909a },
    monitor: 0x2b2e35,
    screen: 0x8fc4f5,
    chair: 0x5f636c,
    plant: { pot: 0xc0784d, leaf: 0x3f9a5c, leafLight: 0x62bb7c },
    fridge: { top: 0xf4f5f7, left: 0xdfe2e7, right: 0xcdd1d8 },
    sofa: { seat: 0x8c7ac0, back: 0x76649f },
    felt: 0x3f8f5f,
    door: 0x9a7350,
    doorFrame: 0x6b4f36,
    brass: 0xc9a227,
    sign: 0x2b2e35,
    signText: 0xf4f4f5,
    shadow: 0x2a2d35,
    ink: 0x2a2421,
    nameplate: 0x16171a,
    nameplateText: 0xf4f4f5,
    bubble: token('--card', 0xfcfcfd),
    accent: token('--primary', 0x7c3aed),
    status,
  };
}
