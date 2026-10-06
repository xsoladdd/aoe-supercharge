import type { Outfit } from '@aoe-supercharge/core/shared';
import { cn } from '@/lib/utils';

const INK = '#2a2421';

/** Hair drawn behind the head (long hair, ponytails, buns). */
function HairBack({ o }: { o: Outfit }) {
  const c = o.hair.color;
  switch (o.hair.style) {
    case 'long':
      return <path d="M10 17c0-7 4-11 10-11s10 4 10 11v12h-4v-8H14v8h-4z" fill={c} />;
    case 'bob':
      return <path d="M11 17c0-6 4-10 9-10s9 4 9 10v6h-3v-4H14v4h-3z" fill={c} />;
    case 'bun':
      return <circle cx="20" cy="5.5" r="3.6" fill={c} />;
    case 'ponytail':
      return <path d="M27 10c4 1 5 6 4 12-1-3-3-5-5-6z" fill={c} />;
    default:
      return null;
  }
}

/** Hair on top of the head. */
function HairTop({ o }: { o: Outfit }) {
  const c = o.hair.color;
  switch (o.hair.style) {
    case 'bald':
      return null;
    case 'buzz':
      return (
        <path
          d="M13 14.5c0-4.5 3-7.2 7-7.2s7 2.7 7 7.2c-2-1.8-4.4-2.6-7-2.6s-5 .8-7 2.6z"
          fill={c}
          opacity=".75"
        />
      );
    case 'curly':
      return (
        <g fill={c}>
          {[
            [14, 11],
            [17, 8.5],
            [20.5, 7.8],
            [24, 8.8],
            [26.4, 11.5],
            [13, 14.5],
            [27, 14.5],
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="3" />
          ))}
        </g>
      );
    default:
      return (
        <path
          d="M12.6 15.5c0-5.2 3.3-8.6 7.4-8.6s7.4 3.4 7.4 8.6c-1.5-2.6-4-3.9-7.4-4.4-1.9 1.6-4.4 3.3-7.4 4.4z"
          fill={c}
        />
      );
  }
}

function Top({ o }: { o: Outfit }) {
  const { kind, color, trim } = o.top;
  const body = <path d="M5 40c0-7.5 5-11.5 11-12.5h8c6 1 11 5 11 12.5z" fill={color} />;
  switch (kind) {
    case 'suit':
      return (
        <g>
          {body}
          <path d="M16.5 27.5 20 34l3.5-6.5z" fill="#eef0f2" />
          {o.accessory === 'tie' && <path d="M19 29.5h2l.8 7.5-1.8 2-1.8-2z" fill={trim} />}
        </g>
      );
    case 'blazer':
      return (
        <g>
          {body}
          <path d="M16.5 27.5 20 35l3.5-7.5z" fill={trim} />
        </g>
      );
    case 'hoodie':
      return (
        <g>
          {body}
          <path
            d="M14 28c1.5 2.5 3.5 3.5 6 3.5s4.5-1 6-3.5"
            stroke={INK}
            strokeOpacity=".25"
            strokeWidth="1.2"
            fill="none"
          />
          <path d="M18 31v5M22 31v5" stroke={trim} strokeWidth="1.1" strokeLinecap="round" />
        </g>
      );
    case 'sweater':
      return (
        <g>
          {body}
          <path
            d="M15.5 27.6c1.2 2 2.7 2.8 4.5 2.8s3.3-.8 4.5-2.8"
            stroke={trim}
            strokeWidth="1.6"
            fill="none"
          />
          <path d="M9 36h22" stroke={trim} strokeWidth="1" strokeDasharray="1.4 1.4" opacity=".7" />
        </g>
      );
    case 'aloha':
      return (
        <g>
          {body}
          <path d="M17 27.5 20 31l3-3.5" stroke={INK} strokeOpacity=".3" strokeWidth="1" fill="none" />
          {[
            [11, 34],
            [15, 37.5],
            [26, 33.5],
            [29.5, 37],
            [21.5, 37.8],
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill={trim} />
          ))}
        </g>
      );
    case 'track_jacket':
      return (
        <g>
          {body}
          <path d="M20 29v11" stroke={INK} strokeOpacity=".3" strokeWidth="1" />
          <path d="M8.5 33.5 7 40M31.5 33.5 33 40" stroke={trim} strokeWidth="1.6" />
        </g>
      );
    case 'tunic':
      return (
        <g>
          <path d="M4 40c0-8 4.5-12 10-13l6 3 6-3c5.5 1 10 5 10 13z" fill={trim} />
          {body}
          <path d="M16 27.6 20 31l4-3.4" stroke={trim} strokeWidth="1.4" fill="none" />
        </g>
      );
  }
}

/** Things worn on the head and face, drawn last. */
function Accessory({ o }: { o: Outfit }) {
  switch (o.accessory) {
    case 'glasses':
      return (
        <g stroke={INK} strokeWidth=".9" fill="none">
          <circle cx="17.3" cy="17.6" r="2.1" />
          <circle cx="22.7" cy="17.6" r="2.1" />
          <path d="M19.4 17.6h1.2" />
        </g>
      );
    case 'sunglasses':
      return (
        <path
          d="M14.8 16.4h4.4v2.4c0 .9-.8 1.5-2.2 1.5s-2.2-.6-2.2-1.5zM20.8 16.4h4.4v2.4c0 .9-.8 1.5-2.2 1.5s-2.2-.6-2.2-1.5zM19.2 17h1.6"
          fill={INK}
          stroke={INK}
          strokeWidth=".6"
        />
      );
    case 'headphones':
      return (
        <g>
          <path d="M12 18c0-6 3.6-9.6 8-9.6s8 3.6 8 9.6" stroke={INK} strokeWidth="1.6" fill="none" />
          <rect
            x="10.4"
            y="16.4"
            width="3.2"
            height="5"
            rx="1.4"
            fill={o.top.color}
            stroke={INK}
            strokeWidth=".6"
          />
          <rect
            x="26.4"
            y="16.4"
            width="3.2"
            height="5"
            rx="1.4"
            fill={o.top.color}
            stroke={INK}
            strokeWidth=".6"
          />
        </g>
      );
    case 'beanie':
      return (
        <g>
          <path d="M12.4 14.5c0-5 3.3-8.4 7.6-8.4s7.6 3.4 7.6 8.4z" fill={o.top.color} />
          <rect x="12" y="13" width="16" height="2.6" rx="1.2" fill={o.top.trim} />
        </g>
      );
    case 'cap':
      return (
        <g fill={o.top.color}>
          <path d="M12.8 13.6c0-4.6 3.2-7.4 7.2-7.4s7.2 2.8 7.2 7.4z" />
          <path d="M20 12.6h10.5c0 1.2-.8 2-2 2H20z" />
        </g>
      );
    case 'scarf':
      return (
        <path
          d="M14.5 26.2c2 1.6 3.6 2.2 5.5 2.2s3.5-.6 5.5-2.2l.8 2.4c-2 1.6-4 2.4-6.3 2.4s-4.3-.8-6.3-2.4zM22.5 29.5l1.5 6 2.2-.6-1-5.8z"
          fill={o.top.trim}
        />
      );
    case 'lei':
      return (
        <g>
          {[13.5, 16, 18.6, 21.4, 24, 26.5].map((x, i) => (
            <circle
              key={x}
              cx={x}
              cy={27.8 + (i === 0 || i === 5 ? -0.8 : i === 1 || i === 4 ? 0.6 : 1.3)}
              r="1.5"
              fill={i % 2 ? '#ef476f' : '#ffd166'}
            />
          ))}
        </g>
      );
    case 'sweatband':
      return <rect x="12.6" y="12.2" width="14.8" height="2.4" rx="1.1" fill={o.top.trim} />;
    case 'circlet':
      return (
        <g>
          <path
            d="M12.8 13.4c2.2-.9 4.6-1.3 7.2-1.3s5 .4 7.2 1.3"
            stroke="#c9a227"
            strokeWidth="1.3"
            fill="none"
          />
          <circle cx="20" cy="12" r="1.1" fill="#3c6fb4" stroke="#c9a227" strokeWidth=".5" />
        </g>
      );
    case 'hood':
      return (
        <path
          d="M10.8 22c-1-9 3-15.5 9.2-15.5S30.2 13 29.2 22c-.5-5-2-8.6-4-10.6-1.4-.9-3.2-1.4-5.2-1.4s-3.8.5-5.2 1.4c-2 2-3.5 5.6-4 10.6z"
          fill={o.top.trim}
        />
      );
    default:
      return null;
  }
}

/** A worker's portrait from its outfit. Decorative: the name and status sit next to it as text. */
export function Avatar({ outfit, className }: { outfit: Outfit; className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn('shrink-0 rounded-full bg-raised', className)}
      aria-hidden
      focusable="false"
    >
      <HairBack o={outfit} />
      <rect x="17.4" y="22" width="5.2" height="6.5" rx="1.6" fill={outfit.skin} />
      <Top o={outfit} />
      <circle cx="20" cy="16.5" r="7.2" fill={outfit.skin} />
      <HairTop o={outfit} />
      <circle cx="17.3" cy="17.7" r=".95" fill={INK} />
      <circle cx="22.7" cy="17.7" r=".95" fill={INK} />
      <path d="M18.4 20.9c1 .8 2.2.8 3.2 0" stroke={INK} strokeWidth=".8" strokeLinecap="round" fill="none" />
      <Accessory o={outfit} />
    </svg>
  );
}
