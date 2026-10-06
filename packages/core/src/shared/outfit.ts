import { pick, seeded } from './hash.ts';

/**
 * What each worker wears in the office view: a dress code, then layered parts (skin, hair, top,
 * bottom, shoes, one accessory). Seeded by project and task id, so a worker keeps its outfit across
 * reloads and machines. It never depends on the name: any worker can wear anything.
 *
 * Colours here are character art for the office canvas (SPEC §14.5), not UI tokens.
 */

export const DRESS_CODES = [
  'business',
  'smart_casual',
  'hoodie',
  'cozy_knit',
  'hawaiian',
  'sporty',
  'medieval',
] as const;
export type DressCode = (typeof DRESS_CODES)[number];

export const DRESS_CODE_LABEL: Record<DressCode, string> = {
  business: 'Business formal',
  smart_casual: 'Smart casual',
  hoodie: 'Startup hoodie',
  cozy_knit: 'Cozy knit',
  hawaiian: 'Hawaiian shirt',
  sporty: 'Sporty',
  medieval: 'Medieval garb',
};

export type HairStyle = 'short' | 'long' | 'bun' | 'curly' | 'bald' | 'ponytail' | 'buzz' | 'bob';
export type TopKind = 'suit' | 'blazer' | 'hoodie' | 'sweater' | 'aloha' | 'track_jacket' | 'tunic';
export type BottomKind = 'trousers' | 'chinos' | 'jeans' | 'corduroys' | 'shorts' | 'joggers' | 'hose';
export type Accessory =
  | 'none'
  | 'tie'
  | 'glasses'
  | 'watch'
  | 'headphones'
  | 'beanie'
  | 'cap'
  | 'scarf'
  | 'sunglasses'
  | 'lei'
  | 'sweatband'
  | 'circlet'
  | 'hood';

export interface Outfit {
  dressCode: DressCode;
  skin: string;
  hair: { style: HairStyle; color: string };
  /** `trim` is the second colour: shirt and tie, drawstrings, print, stripes or cloak. */
  top: { kind: TopKind; color: string; trim: string };
  bottom: { kind: BottomKind; color: string };
  shoes: string;
  accessory: Accessory;
}

const SKIN = ['#f6d7c3', '#efc3a4', '#d9a27e', '#c68a62', '#a26a47', '#7d4e33', '#5c3a26', '#3f2a1e'];
const HAIR_STYLES: HairStyle[] = ['short', 'long', 'bun', 'curly', 'bald', 'ponytail', 'buzz', 'bob'];
const HAIR = ['#1f1a17', '#3b2a20', '#6b4226', '#a0522d', '#d9b26f', '#b8b8b8', '#e8e3d9'];
/** One in ten dyes it. */
const HAIR_DYED = ['#4fb3bf', '#e07a9b', '#7d5ba6'];

interface Wardrobe {
  top: TopKind;
  tops: string[];
  trims: string[];
  bottom: BottomKind;
  /** null: trousers match the top (a suit). */
  bottoms: string[] | null;
  shoes: string[];
  accessories: Accessory[];
}

const WARDROBE: Record<DressCode, Wardrobe> = {
  business: {
    top: 'suit',
    tops: ['#2b3a55', '#3a3d42', '#1f2124', '#596273', '#5a2a35'],
    trims: ['#b23a48', '#3c6fb4', '#c9a227', '#2f8f8a'],
    bottom: 'trousers',
    bottoms: null,
    shoes: ['#1b1b1d', '#5a3a22'],
    accessories: ['tie', 'tie', 'glasses', 'watch'],
  },
  smart_casual: {
    top: 'blazer',
    tops: ['#b08a5a', '#34466b', '#6b6b45', '#7c8088'],
    trims: ['#e9ecef', '#bcd4ee', '#efc7cf'],
    bottom: 'chinos',
    bottoms: ['#c8b48a', '#2f3c57', '#a8a29a'],
    shoes: ['#8a5a34', '#1b1b1d'],
    accessories: ['glasses', 'watch', 'none'],
  },
  hoodie: {
    top: 'hoodie',
    tops: ['#e4572e', '#3f88c5', '#44bba4', '#f2a541', '#7d5ba6', '#2d2d34', '#d1495b'],
    trims: ['#f4f4f5', '#1f2124'],
    bottom: 'jeans',
    bottoms: ['#3d5a80', '#2b3a4a', '#5b7aa0'],
    shoes: ['#f4f4f5', '#e4572e', '#1f2124'],
    accessories: ['headphones', 'beanie', 'cap', 'none'],
  },
  cozy_knit: {
    top: 'sweater',
    tops: ['#a44a3f', '#d4a373', '#6a994e', '#bc6c25', '#7f5539', '#457b9d'],
    trims: ['#f1e3c8', '#e9d8a6'],
    bottom: 'corduroys',
    bottoms: ['#7f5539', '#5e503f', '#3d405b'],
    shoes: ['#5a3a22', '#3b2f2f'],
    accessories: ['scarf', 'glasses', 'none'],
  },
  hawaiian: {
    top: 'aloha',
    tops: ['#ef476f', '#06d6a0', '#ffd166', '#118ab2', '#f78c6b'],
    trims: ['#fdfcdc', '#ffd166', '#073b4c'],
    bottom: 'shorts',
    bottoms: ['#c8b48a', '#f4f1de', '#3d5a80'],
    shoes: ['#8a5a34', '#2d2d34'],
    accessories: ['sunglasses', 'lei', 'none'],
  },
  sporty: {
    top: 'track_jacket',
    tops: ['#e63946', '#1d3557', '#2a9d8f', '#f4a261', '#6a4c93'],
    trims: ['#f4f4f5', '#ffd166'],
    bottom: 'joggers',
    bottoms: ['#2d2d34', '#495057', '#1d3557'],
    shoes: ['#f4f4f5', '#e63946'],
    accessories: ['cap', 'sweatband', 'headphones', 'none'],
  },
  medieval: {
    top: 'tunic',
    tops: ['#7b2d26', '#2f4858', '#55654a', '#6d4c7d', '#8c6a3f'],
    trims: ['#c9a227', '#3b2f2f', '#a3a3a3'],
    bottom: 'hose',
    bottoms: ['#3b2f2f', '#4a4e69', '#55654a'],
    shoes: ['#3b2f2f', '#5a3a22'],
    accessories: ['circlet', 'hood', 'none'],
  },
};

/** The outfit for one worker: the same project and task id always give the same clothes. */
export function outfitFor(taskId: string, project: string): Outfit {
  const rng = seeded(`outfit:${project}/${taskId}`);
  const dressCode = pick(rng, DRESS_CODES);
  const w = WARDROBE[dressCode];
  const skin = pick(rng, SKIN);
  const style = pick(rng, HAIR_STYLES);
  const hairColor = rng() < 0.1 ? pick(rng, HAIR_DYED) : pick(rng, HAIR);
  const topColor = pick(rng, w.tops);
  const trim = pick(rng, w.trims);
  return {
    dressCode,
    skin,
    hair: { style, color: hairColor },
    top: { kind: w.top, color: topColor, trim },
    bottom: { kind: w.bottom, color: w.bottoms ? pick(rng, w.bottoms) : topColor },
    shoes: pick(rng, w.shoes),
    accessory: pick(rng, w.accessories),
  };
}
