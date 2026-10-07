import type { OfficeModel } from './office-model.ts';

/**
 * The office's light, clocks and weather (SPEC §14.5). Pure: lighting follows what the office is
 * doing, the clocks come from IANA time zones (so daylight saving is handled by `Intl`), and the
 * weather is parsed from Open-Meteo's forecast API.
 */

// ---------------------------------------------------------------------------------------------------
// Lighting

/** Day: someone is working. Dim: nobody is. Night: nobody has worked for `NIGHT_AFTER_MS`. */
export type LightMode = 'day' | 'dim' | 'night';

export const NIGHT_AFTER_MS = 60 * 60_000;

/**
 * How the office looks: `shade` darkens the whole scene (0 to 1), `warmth` turns that shade from a
 * cool blue to a warm lamp-lit brown (0 to 1), `sky` is how bright the windows are (0 to 1).
 */
export interface Ambience {
  shade: number;
  warmth: number;
  sky: number;
}

export const AMBIENCE: Record<LightMode, Ambience> = {
  day: { shade: 0, warmth: 0, sky: 1 },
  dim: { shade: 0.12, warmth: 0.15, sky: 0.6 },
  night: { shade: 0.3, warmth: 1, sky: 0.12 },
};

/** The light the office's activity calls for, and since when it has been quiet (null while busy). */
export function activityLight(
  model: Pick<OfficeModel, 'everyone'>,
  now: Date,
): { mode: LightMode; quietSince: string | null } {
  const sessions = model.everyone.map((w) => w.session).filter((s) => !!s);
  if (sessions.some((s) => s.status === 'working')) return { mode: 'day', quietSince: null };
  // The last time anyone's status changed: when the office went quiet.
  const quietSince =
    sessions
      .map((s) => s.statusSince)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? null;
  const quietFor = quietSince ? now.getTime() - Date.parse(quietSince) : Infinity;
  return { mode: quietFor >= NIGHT_AFTER_MS ? 'night' : 'dim', quietSince };
}

/** When the light changes by itself (dim turns to night), or null. */
export function nextLightChange(quietSince: string | null, now: Date): number | null {
  if (!quietSince) return null;
  const at = Date.parse(quietSince) + NIGHT_AFTER_MS;
  return at > now.getTime() ? at : null;
}

/** One step of a smooth change from `from` towards `to` after `dtMs` (exponential, time constant `tauMs`). */
export function approach(from: Ambience, to: Ambience, dtMs: number, tauMs = 1200): Ambience {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const step = (a: number, b: number) => (Math.abs(b - a) < 0.002 ? b : a + (b - a) * k);
  return {
    shade: step(from.shade, to.shade),
    warmth: step(from.warmth, to.warmth),
    sky: step(from.sky, to.sky),
  };
}

export const sameAmbience = (a: Ambience, b: Ambience) =>
  a.shade === b.shade && a.warmth === b.warmth && a.sky === b.sky;

// ---------------------------------------------------------------------------------------------------
// Weather (Open-Meteo)

export interface Weather {
  /** Air temperature at 2 m, °C. */
  tempC: number;
  /** WMO weather code. */
  code: number;
  isDay: boolean;
  /** When the reading is for (local time at the place, as Open-Meteo gives it). */
  at: string;
  /** When the daemon fetched it (ISO, UTC). */
  fetchedAt: string;
}

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

/** The WMO codes Open-Meteo documents, grouped for an icon and the windows. */
export function weatherKind(code: number): { kind: WeatherKind; label: string } {
  if (code === 0) return { kind: 'clear', label: 'Clear sky' };
  if (code === 1) return { kind: 'clear', label: 'Mainly clear' };
  if (code === 2) return { kind: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { kind: 'cloudy', label: 'Overcast' };
  if (code === 45 || code === 48) return { kind: 'fog', label: 'Fog' };
  if (code >= 51 && code <= 57) return { kind: 'drizzle', label: 'Drizzle' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { kind: 'rain', label: 'Rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { kind: 'snow', label: 'Snow' };
  if (code >= 95 && code <= 99) return { kind: 'storm', label: 'Thunderstorm' };
  return { kind: 'cloudy', label: 'Cloudy' };
}

/** The forecast URL for the current temperature, weather code and day/night at a place. */
export function weatherUrl(base: string, latitude: number, longitude: number, timeZone: string): string {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,weather_code,is_day',
    timezone: timeZone,
  });
  return `${base.replace(/\/+$/, '')}/v1/forecast?${q}`;
}

/** Open-Meteo's `current` block, or null when the response is not what it should be. */
export function parseWeather(body: unknown, fetchedAt: Date): Weather | null {
  const current = (body as { current?: Record<string, unknown> } | null)?.current;
  if (!current) return null;
  const { temperature_2m: t, weather_code: code, is_day: isDay, time } = current;
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof code !== 'number' || typeof time !== 'string')
    return null;
  return { tempC: t, code, isDay: isDay !== 0, at: time, fetchedAt: fetchedAt.toISOString() };
}

/** How long a reading is used: fetched again after this. */
export const WEATHER_TTL_MS = 15 * 60_000;
/** A reading older than this is dropped when fetching fails: the clock shows without it. */
export const WEATHER_STALE_MS = 60 * 60_000;

// ---------------------------------------------------------------------------------------------------
// Windows

/** What the windows show: the office's own light (`activity`), or the real sky at home (`weather`). */
export type WindowsMode = 'activity' | 'weather';

export interface WindowLook {
  /** Brightness of the sky, 0 (night) to 1 (bright day). */
  sky: number;
  /** How grey the sky is, 0 (blue) to 1 (overcast). */
  cloud: number;
  precip: 'rain' | 'snow' | null;
}

export function windowLook(mode: WindowsMode, light: Ambience, weather: Weather | null): WindowLook {
  if (mode !== 'weather' || !weather) return { sky: light.sky, cloud: 0, precip: null };
  const { kind } = weatherKind(weather.code);
  const cloud = {
    clear: 0,
    partly: 0.35,
    cloudy: 0.8,
    fog: 1,
    drizzle: 0.7,
    rain: 0.85,
    snow: 0.7,
    storm: 1,
  }[kind];
  const precip =
    kind === 'rain' || kind === 'drizzle' || kind === 'storm' ? 'rain' : kind === 'snow' ? 'snow' : null;
  return { sky: weather.isDay ? 1 - cloud * 0.3 : 0.12, cloud, precip };
}

// ---------------------------------------------------------------------------------------------------
// Clocks

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Stockholm" from "Europe/Stockholm", "Ho Chi Minh" from "Asia/Ho_Chi_Minh". */
export function cityOf(tz: string): string {
  return (tz.split('/').at(-1) ?? tz).replace(/_/g, ' ');
}

/** The zone's offset from UTC at `at`, in minutes (Stockholm in summer: 120). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

export interface ClockFace {
  city: string;
  /** "14:05" */
  time: string;
  /** "Tue 7 Oct" */
  date: string;
  /** For `<time dateTime>`. */
  iso: string;
}

export function clockFace(tz: string, at: Date): ClockFace {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(at)
    .replace(',', '');
  return { city: cityOf(tz), time, date, iso: at.toISOString() };
}

/** How far `away` is ahead of `home` (negative: behind), in minutes, and in words. */
export function timeDifference(home: string, away: string, at: Date): { minutes: number; label: string } {
  const minutes = tzOffsetMinutes(away, at) - tzOffsetMinutes(home, at);
  const a = cityOf(away);
  const h = cityOf(home);
  if (minutes === 0) return { minutes, label: `${a} is on ${h} time` };
  const abs = Math.abs(minutes);
  const span = `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ''}`;
  return { minutes, label: `${a} is ${span} ${minutes > 0 ? 'ahead of' : 'behind'} ${h}` };
}
