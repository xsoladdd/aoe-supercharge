import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { officeLayout, type Furniture, type WindowLook } from '@aoe-supercharge/core/shared';
import { artFor, defaultArt, featureSpan, windowsOf } from '../src/lib/office/art.ts';
import { shade, tint } from '../src/lib/office/iso.ts';
import { makePalette, type Palette } from '../src/lib/office/palette.ts';
import { DEFAULT_THEME, resolveTheme, THEMES } from '../src/lib/office/themes/index.ts';
import { headquarters } from '../src/lib/office/themes/headquarters.ts';
import type { Mode, OfficeTheme } from '../src/lib/office/themes/types.ts';

const MODES: Mode[] = ['dark', 'light'];
/** The characters' outline and shirt (character.ts): one of them has to stand out on every floor. */
const INK = 0x231f20;
const SHIRT = 0xeef0f2;

/** WCAG relative luminance and contrast ratio. */
function luminance(c: number) {
  const ch = (s: number) => {
    const v = ((c >> s) & 0xff) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}
function contrast(a: number, b: number) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Every floor tone a character can stand on. */
function floors(p: Palette): [string, number][] {
  return [
    ...p.corridor.map((c, i) => [`corridor ${i}`, c] as [string, number]),
    ...p.pantry.map((c, i) => [`pantry ${i}`, c] as [string, number]),
    ...p.lounge.map((c, i) => [`lounge ${i}`, c] as [string, number]),
    ...p.kitchen.floor.map((c, i) => [`kitchen ${i}`, c] as [string, number]),
    ...p.carpets.flatMap((pair, k) => pair.map((c, i) => [`carpet ${k}.${i}`, c] as [string, number])),
    ['runner', p.runner.base],
  ];
}

/** A room's nameplate and its team sign: the fill behind the project's name, in its carpet colour. */
const plateFill = (p: Palette, carpet: number) =>
  p.theme === 'dark' ? shade(tint(carpet, 0.15), 0.1) : tint(carpet, 0.35);
const plateText = (p: Palette) => (p.theme === 'dark' ? 0xf4f4f5 : 0x16171a);

describe('office themes: picking one', () => {
  it('finds a theme by id, whatever its case or spacing', () => {
    for (const t of THEMES) {
      expect(resolveTheme(t.id).id).toBe(t.id);
      expect(resolveTheme(`  ${t.id.toUpperCase()} `).id).toBe(t.id);
    }
  });

  it('falls back to Headquarters for an unknown, removed or missing theme', () => {
    for (const id of ['', 'nope', 'grand-library', 'headquarters2', null, undefined])
      expect(resolveTheme(id).id).toBe('headquarters');
  });

  it('lists Headquarters first, as the default, and each theme once', () => {
    expect(THEMES[0]).toBe(headquarters);
    expect(DEFAULT_THEME).toBe('headquarters');
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) {
      expect(t.id).toMatch(/^[a-z][a-z-]*$/);
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.blurb.length).toBeLessThanOrEqual(34);
    }
  });
});

describe('office themes: colours', () => {
  it('Headquarters is the office as it was, colour for colour', () => {
    const before = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/headquarters-palette.json'), 'utf8'),
    );
    expect(JSON.parse(JSON.stringify({ dark: makePalette('dark'), light: makePalette('light') }))).toEqual(
      before,
    );
    expect(makePalette('dark', headquarters)).toEqual(makePalette('dark'));
  });

  it('never changes what carries meaning: status, accent, bubbles, nameplates, the whiteboard', () => {
    for (const mode of MODES) {
      const hq = makePalette(mode, headquarters);
      for (const t of THEMES) {
        const p = makePalette(mode, t);
        expect(p.theme).toBe(mode);
        expect(p.status, `${t.id} ${mode}`).toEqual(hq.status);
        expect([p.accent, p.bubble, p.bg, p.nameplate, p.nameplateText, p.ink]).toEqual([
          hq.accent,
          hq.bubble,
          hq.bg,
          hq.nameplate,
          hq.nameplateText,
          hq.ink,
        ]);
        const { frame: _f, ...board } = p.board;
        const { frame: _h, ...hqBoard } = hq.board;
        expect(board).toEqual(hqBoard);
      }
    }
  });

  const each = (fn: (t: OfficeTheme, p: Palette, hq: Palette) => void) => {
    for (const mode of MODES)
      for (const t of THEMES) fn(t, makePalette(mode, t), makePalette(mode, headquarters));
  };

  it('keeps every room name readable on its plate (4.5:1)', () => {
    each((t, p) => {
      for (const [carpet] of p.carpets) {
        const ratio = contrast(plateText(p), plateFill(p, carpet));
        expect(ratio, `${t.id} ${p.theme}: name on ${hex(plateFill(p, carpet))}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(p.signText, p.sign), `${t.id} ${p.theme}: door sign`).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('keeps the selection ring as visible as at Headquarters, and characters clear of every floor (3:1)', () => {
    each((t, p, hq) => {
      // Headquarters' own day floor is under 3:1 for the ring: no theme may be less readable than it.
      const bar = Math.min(3, ...floors(hq).map(([, c]) => contrast(hq.accent, c))) - 0.005;
      for (const [name, c] of floors(p)) {
        expect(contrast(p.accent, c), `${t.id} ${p.theme}: ring on ${name} ${hex(c)}`).toBeGreaterThanOrEqual(
          bar,
        );
        const fig = Math.max(contrast(INK, c), contrast(SHIRT, c));
        expect(fig, `${t.id} ${p.theme}: a character on ${name} ${hex(c)}`).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

describe('office themes: art', () => {
  const layout = officeLayout([
    { project: 'web', desks: 3 },
    { project: 'api', desks: 2 },
    { project: 'docs', desks: 4 },
  ]);
  const looks: WindowLook[] = [
    { sky: 1, cloud: 0, precip: null },
    { sky: 0, cloud: 0, precip: null },
    { sky: 0.6, cloud: 1, precip: 'rain' },
    { sky: 0.3, cloud: 1, precip: 'snow' },
  ];
  const sound = (g: Graphics, what: string) => {
    const b = g.getLocalBounds();
    for (const v of [b.x, b.y, b.width, b.height])
      expect(Number.isFinite(v), `${what}: bounds ${JSON.stringify(b)}`).toBe(true);
    g.destroy();
  };
  const piece = (kind: Furniture['kind']) => layout.furniture.find((f) => f.kind === kind)!;

  it('draws every part of every theme, in both modes, without a slip', () => {
    for (const mode of MODES)
      for (const t of THEMES) {
        const p = makePalette(mode, t);
        const kit = artFor(t);
        const at = `${t.id} ${mode}`;
        const draw = (what: string, fn: (g: Graphics) => void) => {
          const g = new Graphics();
          fn(g);
          sound(g, `${at} ${what}`);
        };
        draw('floor', (g) => {
          for (let y = 0; y < layout.height; y++)
            for (let x = 0; x < layout.width; x++)
              kit.floor(g, p, x, y, { kind: x % 3 ? 'open' : 'carpet', rect: null, tones: p.corridor });
        });
        draw('rugs and runner', (g) => {
          for (const team of layout.teams) kit.rug(g, p, team.area, p.carpets[0]![0]);
          kit.runner(g, p, layout.floors.find((f) => f.kind === 'runner')!.rect);
        });
        draw('walls', (g) => kit.walls(g, p, layout));
        for (const gy of windowsOf(layout)) {
          const drapes = new Graphics();
          draw('window', (g) => kit.window(g, drapes, p, gy));
          sound(drapes, `${at} window dressing`);
          for (const look of looks) draw(`view ${JSON.stringify(look)}`, (g) => kit.view(g, p, gy, look));
        }
        draw('entrance', (g) => kit.entrance(g, p, layout.entrance.y));
        const span = featureSpan(layout)!;
        expect(span).not.toBeNull();
        draw('feature', (g) => kit.feature(g, p, span.x0, span.x1));
        draw('suite', (g) => kit.suite(g, p, { x0: layout.suite.x, x1: layout.width, door: layout.door.x }));
        for (const open of [false, true]) draw(`door ${open}`, (g) => kit.door(g, p, layout.door.x, open));
        draw('extras', (g) => {
          for (const m of kit.extras?.(g, p, layout, () => new Graphics()) ?? []) {
            m.draw(0);
            m.draw(12345);
            sound(m.g, `${at} moving bit`);
          }
        });
        for (const team of layout.teams) {
          for (const e of team.walls) draw('partition', (g) => kit.partition(g, p, e));
          draw('doorway', (g) => kit.doorway(g, p, team));
        }
        const desk = piece('lead_desk');
        draw('desk', (g) => kit.desk(g, p, desk, desk.x, desk.y, true));
        draw('chair', (g) => kit.chair(g, p, 3, 3));
        draw('stool', (g) => kit.stool(g, p, 3, 3));
        draw('plant', (g) => kit.plant(g, p, 3, 3));
        draw('lamp', (g) => kit.lamp(g, p, piece('side_table')));
        const rope = piece('rope');
        for (let ty = rope.y; ty < rope.y + rope.h; ty++)
          draw('rope', (g) => kit.rope(g, p, rope, layout.door.x, ty));
        const counter = piece('counter');
        for (let i = 0; i < counter.w; i++) draw('counter', (g) => kit.counter(g, p, counter, i));
        draw('coffee', (g) => kit.coffee(g, p, piece('coffee')));
        draw('fridge', (g) => kit.fridge(g, p, piece('fridge')));
        draw('cooler', (g) => kit.cooler(g, p, piece('cooler')));
        draw('table', (g) => kit.table(g, p, piece('table')));
        const sofa = piece('sofa');
        for (let i = 0; i < sofa.w; i++) draw('sofa', (g) => kit.sofa(g, p, sofa, i));
        const foos = piece('foosball');
        for (let i = 0; i < foos.w; i++) draw('foosball', (g) => kit.foosball(g, p, foos, i));
        const pool = piece('pool_table');
        for (let dy = 0; dy < pool.h; dy++)
          for (let dx = 0; dx < pool.w; dx++) draw('pool table', (g) => kit.poolTable(g, p, pool, dx, dy));
        draw('cue rack', (g) => kit.cueRack(g, p, piece('cue_rack')));
      }
  });

  it('starts from the Headquarters kit, so a theme only draws what it restyles', () => {
    expect(artFor(headquarters)).toEqual(defaultArt);
    for (const t of THEMES)
      for (const [slot, fn] of Object.entries(artFor(t)))
        expect(typeof fn, `${t.id}.${slot}`).toBe('function');
  });
});
