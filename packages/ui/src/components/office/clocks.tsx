import {
  CloudFogIcon,
  CloudIcon,
  CloudLightningIcon,
  CloudMoonIcon,
  CloudRainIcon,
  CloudSnowIcon,
  CloudSunIcon,
  MoonIcon,
  SunIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  clockFace,
  timeDifference,
  weatherKind,
  type Weather,
  type WeatherKind,
} from '@aoe-supercharge/core/shared';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

const ICON: Record<WeatherKind, [day: Icon, night: Icon]> = {
  clear: [SunIcon, MoonIcon],
  partly: [CloudSunIcon, CloudMoonIcon],
  cloudy: [CloudIcon, CloudIcon],
  fog: [CloudFogIcon, CloudFogIcon],
  drizzle: [CloudRainIcon, CloudRainIcon],
  rain: [CloudRainIcon, CloudRainIcon],
  snow: [CloudSnowIcon, CloudSnowIcon],
  storm: [CloudLightningIcon, CloudLightningIcon],
};

export const DEFAULT_CLOCKS = { home: 'Europe/Stockholm', away: 'Asia/Manila' };

/**
 * The office's clocks (SPEC §14.5): home and away, with the time between them worked out from their
 * time zones (so daylight saving is right), and the weather at home when it is on and the last fetch
 * worked. Without weather it is just the clocks.
 */
export function OfficeClocks({
  clocks = DEFAULT_CLOCKS,
  weather,
  className,
}: {
  clocks?: { home: string; away: string };
  weather?: Weather | null;
  className?: string;
}) {
  const now = useNow(10_000);
  const home = clockFace(clocks.home, now);
  const away = clockFace(clocks.away, now);
  const diff = timeDifference(clocks.home, clocks.away, now);
  const kind = weather ? weatherKind(weather.code) : null;
  const WeatherIcon = kind && weather ? ICON[kind.kind][weather.isDay ? 0 : 1] : null;
  return (
    <div
      role="group"
      aria-label="Clocks"
      data-office-clocks
      data-difference={diff.minutes}
      className={cn('tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-sm', className)}
    >
      <span className="inline-flex items-baseline gap-1.5" data-clock="home">
        <span className="text-muted-foreground">{home.city}</span>
        <time dateTime={home.iso} className="font-semibold">
          {home.time}
        </time>
        <span className="text-[0.8125rem] text-muted-foreground">{home.date}</span>
        {weather && kind && WeatherIcon && (
          <span
            className="inline-flex items-center gap-1 self-center"
            data-weather={kind.kind}
            title={`${kind.label}, ${weather.tempC.toFixed(1)}°C in ${home.city} (Open-Meteo)`}
          >
            <WeatherIcon weight="bold" className="size-4" aria-hidden />
            <span className="sr-only">{kind.label},</span>
            {Math.round(weather.tempC)}°C
          </span>
        )}
      </span>
      <span className="inline-flex items-baseline gap-1.5" data-clock="away">
        <span className="text-muted-foreground">{away.city}</span>
        <time dateTime={away.iso} className="font-semibold">
          {away.time}
        </time>
        <span className="text-[0.8125rem] text-muted-foreground">{away.date}</span>
      </span>
      <span className="text-[0.8125rem] text-muted-foreground" data-time-difference>
        {diff.label}
      </span>
    </div>
  );
}
