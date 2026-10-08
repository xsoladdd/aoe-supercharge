import { fjord } from './fjord';
import { foundry } from './foundry';
import { headquarters } from './headquarters';
import { highRoller } from './high-roller';
import { ryokan } from './ryokan';
import { starship } from './starship';
import { throneHall } from './throne-hall';
import type { OfficeTheme } from './types';

/**
 * The office themes (SPEC §14.5), in the picker's order: Headquarters first, the default. A theme is a
 * module of its own; adding one is that module and a line here.
 */
export const THEMES: readonly OfficeTheme[] = [
  headquarters,
  foundry,
  ryokan,
  throneHall,
  highRoller,
  fjord,
  starship,
];

export const DEFAULT_THEME = headquarters.id;

/** The theme with this id; Headquarters for an unknown one (a typo, or a theme since removed) or none. */
export function resolveTheme(id: string | null | undefined): OfficeTheme {
  const want = (id ?? '').trim().toLowerCase();
  return THEMES.find((t) => t.id === want) ?? headquarters;
}
