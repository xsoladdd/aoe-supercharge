import { Container, Graphics, Text } from 'pixi.js';
import type { Accessory, BottomKind, HairStyle, Outfit, Prop, TopKind } from '@aoe-supercharge/core/shared';
import { FONT } from './art';
import { shade, tint } from './iso';
import type { Palette } from './palette';

/**
 * One worker in the office: a big-headed character drawn from its outfit, seen from the front or the
 * back, standing or sitting, with legs that swing while it walks (SPEC §14.5). Its bubble and
 * nameplate live in a separate overlay so furniture never hides them.
 */

export type Stance = 'stand' | 'sit';
export type Hands = 'down' | 'typing' | 'mug' | 'paper' | 'magnifier' | 'letter';

const SHIRT = 0xeef0f2;
const BLUSH = 0xe8838f;

type G = Graphics;

/**
 * The look: a sticker-style chibi. One near-black ink line round every shape, a rounded-square head,
 * dot eyes, chunky hair, mitten hands and boots, flat colours.
 */
const INK = 0x231f20;
const line = (_c: number, width = 1.3) => ({ width: width * 1.45, color: INK });

/** An outfit with its colours as numbers, ready to draw. */
interface Look {
  skin: number;
  hair: { style: HairStyle; color: number };
  top: { kind: TopKind; color: number; trim: number };
  bottom: { kind: BottomKind; color: number };
  shoes: number;
  accessory: Accessory;
}

const num = (c: string) => parseInt(c.replace('#', ''), 16);

function look(o: Outfit): Look {
  return {
    skin: num(o.skin),
    hair: { style: o.hair.style, color: num(o.hair.color) },
    top: { kind: o.top.kind, color: num(o.top.color), trim: num(o.top.trim) },
    bottom: { kind: o.bottom.kind, color: num(o.bottom.color) },
    shoes: num(o.shoes),
    accessory: o.accessory,
  };
}

function hairBack(g: G, o: Look, view: 'front' | 'back') {
  const c = o.hair.color;
  switch (o.hair.style) {
    case 'long':
      g.roundRect(-12, -40, 24, view === 'back' ? 28 : 24, 9)
        .fill(c)
        .stroke(line(c));
      break;
    case 'bob':
      g.roundRect(-12.5, -40, 25, 17, 8).fill(c).stroke(line(c));
      break;
    case 'ponytail':
      if (view === 'front') g.ellipse(11, -31, 3.6, 7.4).fill(c).stroke(line(c));
      break;
    default:
      break;
  }
}

function hairFront(g: G, o: Look) {
  const c = o.hair.color;
  switch (o.hair.style) {
    case 'bald':
      g.ellipse(-3.5, -42, 3, 1.6).fill({ color: 0xffffff, alpha: 0.25 });
      return;
    case 'buzz':
      g.moveTo(-11, -37.5)
        .bezierCurveTo(-10.6, -49.5, 10.6, -49.5, 11, -37.5)
        .quadraticCurveTo(0, -42.5, -11, -37.5)
        .fill({ color: c, alpha: 0.9 })
        .stroke(line(c, 1));
      return;
    case 'curly':
      for (const [x, y] of [
        [-8, -41],
        [-4, -45],
        [0.5, -46.5],
        [5, -45],
        [8.6, -41.5],
        [-10, -36.5],
        [10.4, -36.5],
      ])
        g.circle(x!, y!, 4.3).fill(c).stroke(line(c, 1.1));
      g.ellipse(-3, -44.5, 3, 1.5).fill({ color: 0xffffff, alpha: 0.22 });
      return;
    case 'short':
      // Chunky tufts on top, a ragged fringe.
      g.poly([
        -12.8, -33, -13.4, -44, -10, -50, -6.5, -48.2, -3.2, -52.4, 0.8, -49.4, 4.6, -52.8, 7.8, -48.8, 11.4,
        -50.6, 13.6, -43.5, 12.8, -33, 10, -38.2, 6.4, -41.6, 2.8, -40.2, -1.2, -42.4, -5.2, -40.6, -9.4,
        -41.8,
      ])
        .fill(c)
        .stroke(line(c));
      g.moveTo(-6, -47).lineTo(-3.6, -44.6).stroke({ width: 1.2, color: 0xffffff, alpha: 0.25 });
      return;
    default:
      if (o.hair.style === 'bun') g.circle(0, -52, 5.2).fill(c).stroke(line(c));
      // A swept fringe: fuller on one side, with a parting.
      g.moveTo(-12.6, -33.5)
        .bezierCurveTo(-13.6, -55, 13.6, -55, 12.6, -33.5)
        .quadraticCurveTo(8, -42.5, 1.5, -41.4)
        .quadraticCurveTo(-5, -43.5, -12.6, -33.5)
        .fill(c)
        .stroke(line(c));
      if (o.hair.style === 'bob') {
        g.roundRect(-12.6, -38.5, 4.4, 13.5, 2.2).fill(c).stroke(line(c, 1));
        g.roundRect(8.2, -38.5, 4.4, 13.5, 2.2).fill(c).stroke(line(c, 1));
      }
      if (o.hair.style === 'long') {
        g.roundRect(-12.6, -38.5, 3.8, 16, 1.9).fill(c).stroke(line(c, 1));
        g.roundRect(8.8, -38.5, 3.8, 16, 1.9).fill(c).stroke(line(c, 1));
      }
      // A sheen across the top.
      g.moveTo(-6.5, -46).quadraticCurveTo(-1, -48.8, 4, -46.8).stroke({
        width: 1.8,
        color: 0xffffff,
        alpha: 0.22,
      });
  }
}

function hairBackView(g: G, o: Look) {
  const c = o.hair.color;
  if (o.hair.style === 'bald') return;
  if (o.hair.style === 'buzz') {
    g.ellipse(0, -37, 11.2, 10.6).fill({ color: c, alpha: 0.8 }).stroke(line(c, 1));
    return;
  }
  // Stops short of the ears, so a head of fair hair still reads as hair and not as skin.
  g.moveTo(-11.2, -31)
    .bezierCurveTo(-13, -51, 13, -51, 11.2, -31)
    .quadraticCurveTo(0, -27.5, -11.2, -31)
    .fill(c)
    .stroke(line(c));
  if (o.hair.style === 'curly') for (const x of [-8, -3, 3, 8]) g.circle(x, -45, 4).fill(c);
  if (o.hair.style === 'bun') g.circle(0, -49.5, 4.8).fill(c);
  if (o.hair.style === 'ponytail') g.roundRect(-2.6, -36, 5.2, 14, 2.6).fill(shade(c, 0.08));
  // A parting and a sheen.
  g.moveTo(0, -46.5)
    .quadraticCurveTo(1.6, -41.5, 0.4, -37)
    .stroke({ width: 1, color: shade(c, 0.28), alpha: 0.8 });
  g.ellipse(-4, -42.5, 3.6, 2).fill({ color: 0xffffff, alpha: 0.2 });
}

/** The upper body: rounded shoulders narrowing a touch to the waist. */
function chest(g: G, color: number) {
  g.moveTo(-9.8, -20.5)
    .quadraticCurveTo(-9.8, -26, -4, -26)
    .lineTo(4, -26)
    .quadraticCurveTo(9.8, -26, 9.8, -20.5)
    .lineTo(8.8, -12.5)
    .quadraticCurveTo(8.6, -10, 6, -10)
    .lineTo(-6, -10)
    .quadraticCurveTo(-8.6, -10, -8.8, -12.5)
    .closePath()
    .fill(color)
    .stroke(line(color));
  // Shade down the far side, for some volume.
  g.moveTo(4.5, -25.4)
    .quadraticCurveTo(9.2, -25.4, 9.2, -20.5)
    .lineTo(8.3, -12.5)
    .quadraticCurveTo(8.1, -10.6, 6, -10.6)
    .lineTo(5.2, -10.6)
    .quadraticCurveTo(7, -18, 4.5, -27)
    .fill({ color: 0x000000, alpha: 0.06 });
}

function torsoFront(g: G, o: Look) {
  const { kind, color, trim } = o.top;
  if (kind === 'tunic') g.roundRect(-11, -27.5, 22, 19, 6).fill(trim).stroke(line(trim)); // cloak behind
  chest(g, color);
  if (kind !== 'tunic' && kind !== 'hoodie' && kind !== 'track_jacket')
    g.rect(-8.6, -12.6, 17.2, 1.4).fill({ color: shade(o.bottom.color, 0.15), alpha: 0.9 });
  switch (kind) {
    case 'suit':
      g.poly([-3.6, -27, 3.6, -27, 0, -19]).fill(SHIRT);
      if (o.accessory === 'tie') g.poly([-1.3, -25, 1.3, -25, 1.8, -15.5, 0, -13.8, -1.8, -15.5]).fill(trim);
      g.moveTo(-3.6, -27)
        .lineTo(-1.2, -16)
        .moveTo(3.6, -27)
        .lineTo(1.2, -16)
        .stroke({ width: 0.9, color: shade(color, 0.3) });
      break;
    case 'blazer':
      g.poly([-3.8, -27, 3.8, -27, 0, -17.5]).fill(trim);
      break;
    case 'hoodie':
      g.roundRect(-6.5, -28.2, 13, 3.2, 1.6).fill(shade(color, 0.18));
      g.moveTo(-2, -25).lineTo(-2, -19.5).moveTo(2, -25).lineTo(2, -19.5).stroke({ width: 1, color: trim });
      g.roundRect(-5.5, -16.5, 11, 4.6, 2).fill(shade(color, 0.12));
      break;
    case 'sweater':
      g.roundRect(-5.5, -28.2, 11, 2.8, 1.4).fill(trim);
      g.rect(-8.5, -19, 17, 2.2).fill({ color: trim, alpha: 0.85 });
      break;
    case 'aloha':
      g.poly([-3.4, -27, 3.4, -27, 0, -22]).fill(shade(color, 0.2));
      for (const [x, y] of [
        [-5, -23],
        [4.5, -21.5],
        [-2, -17],
        [5.5, -14.5],
        [-5.5, -13.5],
      ])
        g.circle(x!, y!, 1.5).fill(trim);
      break;
    case 'track_jacket':
      g.rect(-0.5, -27, 1, 17).fill(tint(color, 0.5));
      g.rect(-8.5, -24, 1.8, 13).fill(trim);
      g.rect(6.7, -24, 1.8, 13).fill(trim);
      break;
    case 'tunic':
      g.poly([-4, -27, 4, -27, 0, -22.5]).fill(trim);
      g.rect(-8.5, -15.5, 17, 2.2).fill(0x3b2f2f);
      g.rect(-1.2, -15.8, 2.4, 2.8).fill(0xc9a227);
      break;
  }
}

function torsoBack(g: G, o: Look) {
  const { kind, color, trim } = o.top;
  if (kind === 'tunic') {
    g.roundRect(-11, -27.5, 22, 20, 6).fill(trim).stroke(line(trim));
    return;
  }
  chest(g, color);
  if (kind === 'hoodie') g.roundRect(-6, -29, 12, 7, 3).fill(shade(color, 0.12));
  if (kind === 'track_jacket') {
    g.rect(-8.5, -24, 1.8, 13).fill(trim);
    g.rect(6.7, -24, 1.8, 13).fill(trim);
  }
  if (kind === 'sweater') g.rect(-8.5, -19, 17, 2.2).fill({ color: trim, alpha: 0.85 });
  if (kind === 'aloha')
    for (const [x, y] of [
      [-4, -22],
      [4, -18],
      [-1, -14],
    ])
      g.circle(x!, y!, 1.5).fill(trim);
}

function face(g: G) {
  // Dot eyes with a glint, short ink brows, a small mouth.
  for (const x of [-4.4, 4.4]) {
    g.ellipse(x, -35, 1.6, 2.05).fill(INK);
    g.circle(x + 0.55, -35.8, 0.55).fill(0xffffff);
    g.moveTo(x - 1.7, -39)
      .lineTo(x + 1.5, -39.4)
      .stroke({ width: 1.2, color: INK, alpha: 0.85 });
  }
  g.moveTo(-1.6, -30.9).quadraticCurveTo(0, -29.6, 1.6, -30.9).stroke({ width: 1.2, color: INK });
  for (const x of [-7.2, 7.2]) g.ellipse(x, -31.8, 1.9, 1.1).fill({ color: BLUSH, alpha: 0.3 });
}

function accessoryFront(g: G, o: Look, ink: number) {
  switch (o.accessory) {
    case 'glasses':
      g.circle(-4.1, -35.3, 3)
        .circle(4.1, -35.3, 3)
        .moveTo(-1.1, -35.5)
        .lineTo(1.1, -35.5)
        .stroke({ width: 1, color: ink });
      g.circle(-4.1, -35.3, 3).circle(4.1, -35.3, 3).fill({ color: 0xffffff, alpha: 0.12 });
      break;
    case 'sunglasses':
      g.roundRect(-7.1, -37.2, 6, 4, 1.6).roundRect(1.1, -37.2, 6, 4, 1.6).fill(ink);
      g.rect(-6.2, -36.6, 2, 0.8).rect(2, -36.6, 2, 0.8).fill({ color: 0xffffff, alpha: 0.35 });
      g.moveTo(-1.2, -36).lineTo(1.2, -36).stroke({ width: 0.9, color: ink });
      break;
    case 'headphones':
      g.moveTo(-11, -36).bezierCurveTo(-11, -51, 11, -51, 11, -36).stroke({ width: 2.2, color: ink });
      g.roundRect(-13, -38.5, 4, 7, 1.8).roundRect(9, -38.5, 4, 7, 1.8).fill(o.top.color);
      break;
    case 'beanie':
      g.moveTo(-11.6, -38.5)
        .bezierCurveTo(-12, -54, 12, -54, 11.6, -38.5)
        .fill(o.top.color)
        .stroke(line(o.top.color));
      g.roundRect(-11.6, -40.5, 23.2, 3.6, 1.6).fill(o.top.trim);
      break;
    case 'cap':
      g.moveTo(-11.2, -39)
        .bezierCurveTo(-11.6, -52, 11.6, -52, 11.2, -39)
        .fill(o.top.color)
        .stroke(line(o.top.color));
      g.ellipse(3, -39.5, 9.5, 2.8).fill(shade(o.top.color, 0.15));
      break;
    case 'scarf':
      g.roundRect(-7.5, -28.6, 15, 4, 2).fill(o.top.trim);
      g.roundRect(2.2, -26, 3.4, 8, 1.5).fill(shade(o.top.trim, 0.1));
      break;
    case 'lei':
      [-6, -3.6, -1.2, 1.2, 3.6, 6].forEach((x, i) =>
        g
          .circle(x, -26.8 + (Math.abs(x) < 2 ? 1.2 : Math.abs(x) < 5 ? 0.6 : 0), 1.8)
          .fill(i % 2 ? 0xef476f : 0xffd166),
      );
      break;
    case 'sweatband':
      g.roundRect(-10.8, -42, 21.6, 3, 1.4).fill(o.top.trim);
      break;
    case 'circlet':
      g.moveTo(-10.4, -41).quadraticCurveTo(0, -44.5, 10.4, -41).stroke({ width: 1.6, color: 0xc9a227 });
      g.circle(0, -43, 1.5).fill(0x3c6fb4);
      break;
    case 'hood':
      g.moveTo(-12.6, -28)
        .bezierCurveTo(-15, -52, 15, -52, 12.6, -28)
        .lineTo(10, -28)
        .bezierCurveTo(11.4, -46, -11.4, -46, -10, -28)
        .closePath()
        .fill(o.top.trim);
      break;
    default:
      break;
  }
}

function accessoryBack(g: G, o: Look, ink: number) {
  switch (o.accessory) {
    case 'headphones':
      g.moveTo(-11, -36).bezierCurveTo(-11, -51, 11, -51, 11, -36).stroke({ width: 2.2, color: ink });
      break;
    case 'beanie':
      g.moveTo(-11.6, -38.5)
        .bezierCurveTo(-12, -54, 12, -54, 11.6, -38.5)
        .fill(o.top.color)
        .stroke(line(o.top.color));
      g.roundRect(-11.6, -40.5, 23.2, 3.6, 1.6).fill(o.top.trim);
      break;
    case 'cap':
      g.moveTo(-11.2, -39)
        .bezierCurveTo(-11.6, -52, 11.6, -52, 11.2, -39)
        .fill(o.top.color)
        .stroke(line(o.top.color));
      break;
    case 'hood':
      g.circle(0, -37, 12.6).fill(o.top.trim);
      break;
    case 'circlet':
      g.moveTo(-10.4, -41).quadraticCurveTo(0, -42.5, 10.4, -41).stroke({ width: 1.6, color: 0xc9a227 });
      break;
    case 'scarf':
      g.roundRect(-7.5, -28.6, 15, 4, 2).fill(o.top.trim);
      break;
    default:
      break;
  }
}

/** One leg from the hip (or, sitting, from the knee) down, with its shoe. */
function legShape(g: G, o: Look, len: number) {
  const shorts = o.bottom.kind === 'shorts';
  const cloth = o.bottom.color;
  g.roundRect(-2.7, 0, 5.4, len, 2.4)
    .fill(shorts ? o.skin : cloth)
    .stroke(line(shorts ? o.skin : cloth, 1.1));
  if (shorts && len > 8) g.roundRect(-3, 0, 6, 4.8, 2).fill(cloth).stroke(line(cloth, 1.1));
  // A rounded shoe, toe towards the viewer, with a shine.
  g.roundRect(-3.6, len - 2.4, 7.6, 4.2, 2)
    .fill(o.shoes)
    .stroke(line(o.shoes, 1.1));
  g.ellipse(1.4, len - 1.4, 1.5, 0.6).fill({ color: 0xffffff, alpha: 0.2 });
}

function armShape(g: G, o: Look) {
  const short = o.top.kind === 'aloha';
  const sleeve = o.top.kind === 'tunic' ? o.top.trim : o.top.color;
  g.roundRect(-2.5, -0.5, 5, 12, 2.5)
    .fill(short ? o.skin : sleeve)
    .stroke(line(short ? o.skin : sleeve, 1.1));
  if (short) g.roundRect(-2.8, -0.5, 5.6, 4.8, 2.2).fill(sleeve).stroke(line(sleeve, 1.1));
  else g.rect(-2.3, 9.2, 4.6, 1.2).fill({ color: shade(sleeve, 0.2), alpha: 0.8 });
  g.circle(0, 12.4, 2.6).fill(o.skin).stroke(line(o.skin, 1));
}

function heldItem(g: G, hands: Hands, p: Palette) {
  switch (hands) {
    case 'mug':
      g.roundRect(5, -33, 6, 7, 1.6).fill(0xffffff).stroke({ width: 0.8, color: 0xd8d2c6 });
      g.circle(11.6, -29.5, 2).stroke({ width: 1, color: 0xd8d2c6 });
      g.moveTo(7, -36)
        .quadraticCurveTo(6, -38.5, 7.5, -40.5)
        .moveTo(9.5, -36)
        .quadraticCurveTo(8.5, -38.5, 10, -40.5)
        .stroke({
          width: 0.8,
          color: p.theme === 'dark' ? 0xd9dce2 : 0x9aa0aa,
          alpha: 0.7,
        });
      break;
    case 'paper':
      g.roundRect(-5, -23, 10, 8, 1).fill(0xffd166);
      g.rect(-3.4, -21, 6.8, 0.8).rect(-3.4, -18.6, 5, 0.8).fill(0x7f5539);
      break;
    case 'letter':
      g.rect(-5.5, -22.5, 11, 7.5).fill(0xffffff).stroke({ width: 0.7, color: 0xbfc4cc });
      g.moveTo(-5.5, -22.5).lineTo(0, -18.5).lineTo(5.5, -22.5).stroke({ width: 0.7, color: 0xbfc4cc });
      break;
    case 'magnifier':
      g.circle(3, -22, 3.6).fill({ color: 0xbfe0fb, alpha: 0.6 }).stroke({ width: 1.4, color: 0x4a4e57 });
      g.moveTo(0.6, -19.5).lineTo(-2, -16.5).stroke({ width: 1.8, color: 0x4a4e57 });
      break;
    default:
      break;
  }
}

/** Bubble colour and icon for each prop, matching the Needs-you colours. */
function propColor(prop: Exclude<Prop, null>, p: Palette): number {
  switch (prop) {
    case 'speech':
    case 'folder_closed':
    case 'warning':
    case 'lost':
    case 'pipeline_failed':
      return p.status.red;
    case 'folder':
      return p.status.green;
    case 'envelope':
    case 'pipeline':
      return p.status.violet;
    case 'letter':
      return p.status.cyan;
    case 'mug':
      return p.status.muted;
    default:
      return p.status.yellow;
  }
}

function drawIcon(g: G, prop: Exclude<Prop, null>, c: number, bg: number, glyph: Container) {
  switch (prop) {
    case 'speech':
    case 'lost': {
      const t = new Text({
        text: '?',
        style: { fontFamily: FONT, fontSize: 15, fontWeight: '800', fill: c },
        resolution: 4,
        anchor: 0.5,
      });
      t.position.set(0, -1);
      glyph.addChild(t);
      if (prop === 'lost') g.circle(0, -1, 7.5).stroke({ width: 1.4, color: c });
      break;
    }
    case 'warning': {
      g.poly([0, -9, 8, 5, -8, 5]).fill(c);
      const t = new Text({
        text: '!',
        style: { fontFamily: FONT, fontSize: 10, fontWeight: '800', fill: bg },
        resolution: 4,
        anchor: 0.5,
      });
      t.position.set(0, 0.5);
      glyph.addChild(t);
      break;
    }
    case 'scroll':
      g.roundRect(-6, -6.5, 12, 11, 1.5).fill(0xf1e3c8).stroke({ width: 1.2, color: c });
      g.rect(-4, -3.5, 8, 1).rect(-4, -1, 6, 1).rect(-4, 1.5, 7, 1).fill(c);
      break;
    case 'shield':
      g.moveTo(0, -8)
        .lineTo(7, -5)
        .quadraticCurveTo(7, 3.5, 0, 7)
        .quadraticCurveTo(-7, 3.5, -7, -5)
        .closePath()
        .fill(c);
      g.moveTo(-3, -0.5).lineTo(-0.5, 2).lineTo(3.5, -3).stroke({ width: 1.6, color: bg });
      break;
    case 'hand':
      g.roundRect(-4.5, -2, 9, 8, 3).fill(c);
      for (const [x, h] of [
        [-3.6, 7],
        [-1.2, 8.5],
        [1.2, 8.5],
        [3.6, 7],
      ])
        g.roundRect(x! - 1, -2 - h!, 2, h! + 1, 1).fill(c);
      g.roundRect(4, -0.5, 4, 2, 1).fill(c);
      break;
    case 'clipboard':
      g.roundRect(-5.5, -7, 11, 14, 1.6).fill(c);
      g.roundRect(-2.5, -8.5, 5, 3, 1).fill(bg);
      g.rect(-3.5, -2, 7, 1).rect(-3.5, 1, 5, 1).fill(bg);
      break;
    case 'folder':
    case 'folder_closed':
      g.poly([-7, -5, -2.5, -5, -1, -3.5, 7, -3.5, 7, 6, -7, 6]).fill(c);
      g.rect(-7, -2, 14, 1).fill({ color: bg, alpha: 0.5 });
      if (prop === 'folder_closed')
        g.moveTo(-2.5, -0.5)
          .lineTo(2.5, 4.5)
          .moveTo(2.5, -0.5)
          .lineTo(-2.5, 4.5)
          .stroke({ width: 1.6, color: bg });
      else g.moveTo(-3, 1).lineTo(-0.8, 3.2).lineTo(3.5, -1).stroke({ width: 1.6, color: bg });
      break;
    case 'envelope':
      g.rect(-7, -5, 14, 10).stroke({ width: 1.5, color: c });
      g.moveTo(-7, -5).lineTo(0, 1).lineTo(7, -5).stroke({ width: 1.5, color: c });
      break;
    case 'pipeline':
      g.poly([-5, -7, 5, -7, 0, 0]).poly([-5, 7, 5, 7, 0, 0]).fill(c);
      g.rect(-6, -8, 12, 1.4).rect(-6, 6.6, 12, 1.4).fill(c);
      break;
    case 'pipeline_failed':
      g.circle(0, 0, 7).fill(c);
      g.moveTo(-3, -3).lineTo(3, 3).moveTo(3, -3).lineTo(-3, 3).stroke({ width: 1.8, color: bg });
      break;
    default:
      break;
  }
}

export class Character {
  readonly root = new Container();
  readonly overlay = new Container();
  private ring = new Graphics();
  private shadow = new Graphics();
  private body = new Container();
  private back = new Graphics();
  private legL = new Graphics();
  private legR = new Graphics();
  private armL = new Graphics();
  private armR = new Graphics();
  private torso = new Graphics();
  private head = new Graphics();
  private front = new Graphics();
  private held = new Graphics();
  /** Little motion marks beside someone waiting on you. */
  private wiggle = new Graphics();
  private bubble = new Container();
  private plate = new Container();
  private plateText: Text;
  private plateBg = new Graphics();
  private view: 'front' | 'back' = 'front';
  private stance: Stance = 'stand';
  private hands: Hands = 'down';
  private prop: Prop = null;
  private thought = false;
  private selected = false;
  private hovered = false;
  /** When the bubble last appeared, for its pop. */
  bubbleSince = 0;
  private pop = 1;
  private overlayScale = 1;

  private o: Look;

  constructor(
    outfit: Outfit,
    name: string,
    private p: Palette,
  ) {
    this.o = look(outfit);
    this.legL.position.set(-3.7, -11.5);
    this.legR.position.set(3.7, -11.5);
    this.armL.position.set(-10.2, -23.6);
    this.armR.position.set(10.2, -23.6);
    this.root.addChild(this.ring, this.shadow, this.body);
    this.plateText = new Text({
      text: name,
      style: { fontFamily: FONT, fontSize: 10.5, fontWeight: '600', fill: p.nameplateText },
      resolution: 4,
      anchor: 0.5,
    });
    this.plate.addChild(this.plateBg, this.plateText);
    // Scale from the bubble's tail tip and the plate's top edge, so they grow away from the body.
    this.bubble.pivot.y = 16;
    this.plate.pivot.y = -8;
    this.overlay.addChild(this.bubble, this.plate);
    this.plate.visible = false;
    this.redraw();
  }

  setPalette(p: Palette) {
    this.p = p;
    this.plateText.style.fill = p.nameplateText;
    this.redraw();
    this.drawBubble();
  }

  setName(name: string) {
    if (this.plateText.text !== name) {
      this.plateText.text = name;
      this.drawPlate();
    }
  }

  /** Look along grid direction (dx, dy): towards the viewer shows the face; leftwards flips. */
  face(dx: number, dy: number) {
    const sx = dx - dy;
    const sy = dx + dy;
    const view = sy > 0 || (sy === 0 && sx === 0) ? 'front' : 'back';
    this.body.scale.x = sx < 0 ? -1 : 1;
    if (view !== this.view) {
      this.view = view;
      this.redraw();
    }
  }

  pose(stance: Stance, hands: Hands) {
    if (stance === this.stance && hands === this.hands) return;
    this.stance = stance;
    this.hands = hands;
    this.redraw();
    this.still();
  }

  /** Feet planted, arms in the pose's place. */
  still() {
    const sit = this.stance === 'sit';
    // Seated on a chair: a little lower, the shins drawn from the knee (see redraw).
    this.body.y = sit ? 3 : 0;
    for (const leg of [this.legL, this.legR]) {
      leg.rotation = 0;
      leg.scale.y = 1;
    }
    const [l, r, s] =
      this.hands === 'typing'
        ? [-0.62, 0.62, 0.72]
        : this.hands === 'mug'
          ? [0.08, 2.5, 0.78]
          : this.hands === 'down'
            ? [0.1, -0.1, 1]
            : [-0.72, 0.72, 0.8];
    this.armL.rotation = l;
    this.armR.rotation = r;
    this.armL.scale.y = this.hands === 'mug' ? 1 : s;
    this.armR.scale.y = s;
  }

  /** One frame of walking: legs and arms swing with `phase` (radians), the body bobs. */
  stride(phase: number) {
    const s = Math.sin(phase);
    this.body.y = -Math.abs(Math.sin(phase)) * 1.8;
    this.legL.scale.y = this.legR.scale.y = 1;
    this.legL.rotation = s * 0.55;
    this.legR.rotation = -s * 0.55;
    this.armL.scale.y = this.armR.scale.y = 1;
    this.armL.rotation = -s * 0.45;
    this.armR.rotation = s * 0.45;
  }

  setProp(prop: Prop, thought: boolean, now: number) {
    const shown = prop && prop !== 'mug' && prop !== 'letter' ? prop : null;
    if (shown === this.prop && thought === this.thought) return;
    if (shown && !this.prop) this.bubbleSince = now;
    this.prop = shown;
    this.thought = thought;
    this.wiggle.visible = !!shown && !thought;
    this.drawBubble();
  }

  /** Bubble pop when it appears: 0..1 progress. */
  popBubble(t: number) {
    const k = Math.min(1, Math.max(0, t)) - 1;
    this.pop = this.prop ? 0.4 + 0.6 * (1 + 2.2 * k * k * k + 1.2 * k * k) : 1;
    this.bubble.scale.set(this.pop * this.overlayScale);
  }

  /** Keep bubbles and nameplates readable when zoomed out. */
  scaleOverlay(s: number) {
    this.overlayScale = s;
    this.bubble.scale.set(this.pop * s);
    this.plate.scale.set(s);
  }

  setSelected(selected: boolean, hovered: boolean, showName: boolean) {
    this.selected = selected;
    this.hovered = hovered;
    this.ring.clear();
    if (selected || hovered)
      this.ring
        .ellipse(0, 0, 16, 8)
        .stroke({ width: selected ? 2.6 : 1.6, color: this.p.accent, alpha: selected ? 1 : 0.7 });
    this.plate.visible = selected || hovered || showName;
    if (this.plate.visible) this.drawPlate();
  }

  get isSelected() {
    return this.selected || this.hovered;
  }

  /** Where the bubble and nameplate sit, in world coordinates. */
  syncOverlay(x: number, y: number) {
    const lift = this.stance === 'sit' ? 3 : 0;
    this.bubble.position.set(x, y - 51 + lift);
    this.plate.position.set(x, y + 5);
  }

  private drawPlate() {
    const w = this.plateText.width + 12;
    this.plateBg
      .clear()
      .roundRect(-w / 2, -8, w, 16, 8)
      .fill({ color: this.p.nameplate, alpha: 0.88 });
    if (this.selected) this.plateBg.stroke({ width: 1.4, color: this.p.accent });
  }

  private drawBubble() {
    this.bubble.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!this.prop) return;
    const p = this.p;
    const c = propColor(this.prop, p);
    const g = new Graphics();
    if (this.thought) {
      g.circle(-5, 15, 2.6).circle(-8.5, 20.5, 1.6).fill(p.bubble).stroke({ width: 1.2, color: c });
    } else {
      g.poly([-5, 9, 5, 9, 0, 16]).fill(p.bubble).stroke({ width: 1.6, color: c });
    }
    g.roundRect(-13, -13, 26, 24, 9).fill(p.bubble).stroke({ width: 1.8, color: c });
    if (!this.thought) g.rect(-4.2, 9.5, 8.4, 2.6).fill(p.bubble);
    const icon = new Graphics();
    const glyph = new Container();
    drawIcon(icon, this.prop, c, p.bubble, glyph);
    icon.position.set(0, -1);
    this.bubble.addChild(g, icon, glyph);
  }

  private redraw() {
    const o = this.o;
    const ink = this.p.ink;
    for (const g of [
      this.back,
      this.legL,
      this.legR,
      this.armL,
      this.armR,
      this.torso,
      this.head,
      this.front,
      this.held,
    ])
      g.clear();
    this.wiggle.clear();
    for (const side of [-1, 1])
      for (const [dx, y0, y1] of [
        [17, -36, -29],
        [20.5, -34, -30],
      ] as const)
        this.wiggle
          .moveTo(side * dx, y0)
          .quadraticCurveTo(side * (dx + 2.2), (y0 + y1) / 2, side * dx, y1)
          .stroke({ width: 1.5, color: INK, alpha: 0.55 });
    this.wiggle.visible = !!this.prop && !this.thought;
    this.shadow
      .clear()
      .ellipse(0, 0.5, 12.5, 5)
      .fill({ color: this.p.shadow, alpha: this.p.theme === 'dark' ? 0.32 : 0.16 })
      .ellipse(0, 0.5, 8, 3.2)
      .fill({ color: this.p.shadow, alpha: this.p.theme === 'dark' ? 0.2 : 0.1 });
    // Sitting: the shins hang from the knees, under a lap.
    const sit = this.stance === 'sit';
    const legLen = sit ? 5.6 : 8.2;
    for (const leg of [this.legL, this.legR]) leg.y = sit ? -7.4 : -10;
    legShape(this.legL, o, legLen);
    legShape(this.legR, o, legLen);
    armShape(this.armL, o);
    armShape(this.armR, o);
    // Neck, ears and head, with a soft shadow under the far cheek.
    this.head.rect(-2.6, -29.5, 5.2, 3.8).fill(shade(o.skin, 0.12));
    for (const x of [-12.2, 12.2])
      this.head.circle(x, -34.6, 2.5).fill(shade(o.skin, 0.04)).stroke(line(o.skin, 1));
    this.head.roundRect(-12.2, -46.8, 24.4, 22, 9.8).fill(o.skin).stroke(line(o.skin));
    if (this.view === 'front') {
      hairBack(this.back, o, 'front');
      if (o.accessory === 'hood') this.back.circle(0, -37, 13.2).fill(shade(o.top.trim, 0.15));
      torsoFront(this.torso, o);
      if (sit)
        this.torso
          .roundRect(-8.8, -13, 17.6, 5.6, 2.6)
          .fill(o.bottom.kind === 'shorts' ? o.bottom.color : o.bottom.color)
          .stroke(line(o.bottom.color, 1.1));
      face(this.head);
      hairFront(this.front, o);
      accessoryFront(this.front, o, ink);
      heldItem(this.held, this.hands, this.p);
      this.body.removeChildren();
      this.body.addChild(
        this.wiggle,
        this.back,
        this.legL,
        this.legR,
        this.torso,
        this.head,
        this.front,
        this.armL,
        this.armR,
        this.held,
      );
    } else {
      torsoBack(this.torso, o);
      hairBackView(this.front, o);
      hairBack(this.front, o, 'back');
      accessoryBack(this.front, o, ink);
      heldItem(this.held, this.hands, this.p);
      this.body.removeChildren();
      this.body.addChild(
        this.wiggle,
        this.held,
        this.legL,
        this.legR,
        this.armL,
        this.armR,
        this.torso,
        this.head,
        this.front,
      );
    }
  }

  /** Is world point (x, y) on this character standing at (fx, fy)? */
  hits(x: number, y: number, fx: number, fy: number): boolean {
    return x >= fx - 13 && x <= fx + 13 && y >= fy - 50 && y <= fy + 4;
  }

  destroy() {
    this.root.destroy({ children: true });
    this.overlay.destroy({ children: true });
  }
}
