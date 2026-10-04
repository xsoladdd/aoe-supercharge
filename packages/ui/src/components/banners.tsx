import { ArrowsClockwiseIcon, PlugsIcon, WarningIcon } from '@phosphor-icons/react';
import type { Health } from '@aoe-supercharge/core/shared';
import { Link } from 'wouter';
import type { Connection } from '@/lib/live';
import { cn } from '@/lib/utils';

function Banner({
  tone,
  icon: I,
  title,
  children,
}: {
  tone: 'warn' | 'error';
  icon: typeof WarningIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'mx-5 mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 lg:mx-7',
        tone === 'error' ? 'border-st-red/40 bg-st-red/8' : 'border-st-yellow/40 bg-st-yellow/8',
      )}
    >
      <I
        weight="fill"
        className={cn('mt-0.5 size-5 shrink-0', tone === 'error' ? 'text-st-red' : 'text-st-yellow')}
        aria-hidden
      />
      <div className="min-w-0 text-[0.9375rem]">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground">
    {children}
  </code>
);

/** Problems that make the dashboard partial. Each names the fix (SPEC §14.0 rule 10). */
export function HealthBanners({ health, connection }: { health: Health; connection: Connection }) {
  const { aoe, config } = health;
  return (
    <>
      {connection === 'reconnecting' && (
        <Banner tone="warn" icon={ArrowsClockwiseIcon} title="Reconnecting to the Supercharge daemon">
          Live updates are paused. If this persists, check <Code>supercharge status</Code>.
        </Banner>
      )}
      {aoe.state === 'incompatible' && (
        <Banner tone="error" icon={WarningIcon} title={aoe.message ?? 'AoE version not supported'}>
          {aoe.fix}
        </Banner>
      )}
      {aoe.state === 'missing' && (
        <Banner tone="error" icon={WarningIcon} title="Agent of Empires is not installed">
          {aoe.fix}
        </Banner>
      )}
      {aoe.state === 'unreachable' && (
        <Banner tone="error" icon={PlugsIcon} title={aoe.message ?? 'aoe serve is not reachable'}>
          {aoe.fix}
        </Banner>
      )}
      {!config.ok && (
        <Banner
          tone="error"
          icon={WarningIcon}
          title="config.toml is invalid, so the last good configuration is in use"
        >
          {config.errors.join('; ')}. Fix it in{' '}
          <Link href="/settings" className="underline">
            Settings
          </Link>{' '}
          or with <Code>supercharge config edit</Code>.
        </Banner>
      )}
    </>
  );
}
