import { describe, expect, it } from 'vitest';
import {
  activityLight,
  AMBIENCE,
  approach,
  buildOffice,
  cityOf,
  clockFace,
  NIGHT_AFTER_MS,
  nextLightChange,
  parseWeather,
  sameAmbience,
  timeDifference,
  tzOffsetMinutes,
  validTimeZone,
  weatherKind,
  weatherUrl,
  windowLook,
  type Weather,
} from '../src/shared/index.ts';
import { at, input, session, T0, task } from './office-fixtures.ts';

const now = new Date(T0);

describe('activity lighting (SPEC §14.5)', () => {
  const floor = (statuses: [string, 'working' | 'idle', number][]) =>
    buildOffice(
      input(
        [
          session('ctl', 'idle', { statusSince: at(-500) }),
          ...statuses.map(([id, st, m]) => session(id, st, { statusSince: at(m) })),
        ],
        statuses.map(([id], i) => task(`XX-000${i + 1}`, 'alpha', id, { desk: i + 1 })),
      ),
      now,
    );

  it('is day while anyone works', () => {
    expect(
      activityLight(
        floor([
          ['s1', 'working', -5],
          ['s2', 'idle', -90],
        ]),
        now,
      ),
    ).toEqual({
      mode: 'day',
      quietSince: null,
    });
  });

  it('dims when nobody works, and turns to night after an hour of quiet', () => {
    expect(
      activityLight(
        floor([
          ['s1', 'idle', -10],
          ['s2', 'idle', -90],
        ]),
        now,
      ),
    ).toEqual({
      mode: 'dim',
      quietSince: at(-10),
    });
    expect(activityLight(floor([['s1', 'idle', -61]]), now).mode).toBe('night');
    expect(activityLight({ everyone: [] }, now).mode).toBe('night');
  });

  it('knows when dim turns to night', () => {
    expect(nextLightChange(at(-10), now)).toBe(T0 - 10 * 60_000 + NIGHT_AFTER_MS);
    expect(nextLightChange(at(-61), now)).toBeNull();
    expect(nextLightChange(null, now)).toBeNull();
  });

  it('eases towards the target and settles on it', () => {
    let a = AMBIENCE.day;
    const steps: number[] = [];
    for (let i = 0; i < 1000 && !sameAmbience(a, AMBIENCE.night); i++) {
      a = approach(a, AMBIENCE.night, 16);
      steps.push(a.shade);
    }
    expect(sameAmbience(a, AMBIENCE.night)).toBe(true);
    // Monotonic, and it takes a few seconds rather than one frame.
    expect(steps.every((v, i) => i === 0 || v >= steps[i - 1]!)).toBe(true);
    expect(steps.length * 16).toBeGreaterThan(2000);
    expect(steps.length * 16).toBeLessThan(15_000);
    expect(approach(AMBIENCE.dim, AMBIENCE.day, 0)).toEqual(AMBIENCE.dim);
  });
});

describe('clocks', () => {
  it('works out the time difference from the time zones, daylight saving included', () => {
    // Summer: Stockholm is UTC+2, Manila UTC+8 (no DST).
    const summer = new Date('2026-07-01T10:00:00Z');
    expect(timeDifference('Europe/Stockholm', 'Asia/Manila', summer)).toEqual({
      minutes: 360,
      label: 'Manila is 6 h ahead of Stockholm',
    });
    // Winter: Stockholm is UTC+1.
    const winter = new Date('2026-01-15T10:00:00Z');
    expect(timeDifference('Europe/Stockholm', 'Asia/Manila', winter).minutes).toBe(420);
    // Either side of the switch back on 2026-10-25 at 01:00 UTC.
    expect(tzOffsetMinutes('Europe/Stockholm', new Date('2026-10-25T00:59:00Z'))).toBe(120);
    expect(tzOffsetMinutes('Europe/Stockholm', new Date('2026-10-25T01:00:00Z'))).toBe(60);
    expect(timeDifference('Asia/Manila', 'Europe/Stockholm', winter).label).toBe(
      'Stockholm is 7 h behind Manila',
    );
    expect(timeDifference('Europe/Stockholm', 'Asia/Kolkata', winter).label).toBe(
      'Kolkata is 4 h 30 min ahead of Stockholm',
    );
    expect(timeDifference('Europe/Stockholm', 'Europe/Paris', winter).label).toBe(
      'Paris is on Stockholm time',
    );
  });

  it('shows the time and date in each zone', () => {
    const t = new Date('2026-10-06T22:30:00Z');
    expect(clockFace('Europe/Stockholm', t)).toMatchObject({
      city: 'Stockholm',
      time: '00:30',
      date: 'Wed 7 Oct',
    });
    expect(clockFace('Asia/Manila', t)).toMatchObject({ city: 'Manila', time: '06:30', date: 'Wed 7 Oct' });
    expect(cityOf('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });

  it('checks a time zone name', () => {
    expect(validTimeZone('Asia/Manila')).toBe(true);
    expect(validTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('weather (Open-Meteo)', () => {
  // The shape of Open-Meteo's /v1/forecast with current=temperature_2m,weather_code,is_day.
  const body = {
    latitude: 59.33,
    longitude: 18.07,
    timezone: 'Europe/Stockholm',
    current_units: {
      time: 'iso8601',
      interval: 'seconds',
      temperature_2m: '°C',
      weather_code: 'wmo code',
      is_day: '',
    },
    current: { time: '2026-10-07T12:15', interval: 900, temperature_2m: 12.4, weather_code: 61, is_day: 1 },
  };

  it('reads the current temperature, weather code and day or night', () => {
    expect(parseWeather(body, now)).toEqual({
      tempC: 12.4,
      code: 61,
      isDay: true,
      at: '2026-10-07T12:15',
      fetchedAt: now.toISOString(),
    });
    expect(parseWeather({ ...body, current: { ...body.current, is_day: 0 } }, now)?.isDay).toBe(false);
  });

  it('turns anything else into no weather', () => {
    expect(parseWeather(null, now)).toBeNull();
    expect(parseWeather({ error: true, reason: 'x' }, now)).toBeNull();
    expect(parseWeather({ current: { ...body.current, temperature_2m: null } }, now)).toBeNull();
  });

  it('groups the WMO codes', () => {
    expect([0, 1, 2, 3, 45, 53, 63, 81, 73, 86, 95, 99].map((c) => weatherKind(c).kind)).toEqual([
      'clear',
      'clear',
      'partly',
      'cloudy',
      'fog',
      'drizzle',
      'rain',
      'rain',
      'snow',
      'snow',
      'storm',
      'storm',
    ]);
  });

  it('asks for the current conditions at the place, in its time zone', () => {
    const url = new URL(weatherUrl('https://api.open-meteo.com/', 59.33, 18.07, 'Europe/Stockholm'));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '59.33',
      longitude: '18.07',
      current: 'temperature_2m,weather_code,is_day',
      timezone: 'Europe/Stockholm',
    });
  });

  it('shows the weather in the windows only when asked to', () => {
    const rain: Weather = { tempC: 4, code: 63, isDay: true, at: 'x', fetchedAt: 'y' };
    expect(windowLook('activity', AMBIENCE.dim, rain)).toEqual({
      sky: AMBIENCE.dim.sky,
      cloud: 0,
      precip: null,
    });
    expect(windowLook('weather', AMBIENCE.dim, null)).toEqual({
      sky: AMBIENCE.dim.sky,
      cloud: 0,
      precip: null,
    });
    expect(windowLook('weather', AMBIENCE.dim, rain)).toMatchObject({ precip: 'rain' });
    expect(windowLook('weather', AMBIENCE.day, { ...rain, code: 71, isDay: false })).toMatchObject({
      precip: 'snow',
      sky: 0.12,
    });
    expect(windowLook('weather', AMBIENCE.night, { ...rain, code: 0 })).toEqual({
      sky: 1,
      cloud: 0,
      precip: null,
    });
  });
});
