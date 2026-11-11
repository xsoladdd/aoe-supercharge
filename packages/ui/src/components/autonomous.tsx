import { RobotIcon } from '@phosphor-icons/react';
import type { Autonomous } from '@aoe-supercharge/core/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { sendJson } from '@/lib/api';
import { useNow } from '@/lib/theme';

const OFF: Autonomous = { on: false, since: null, until: null };

/** On right now, by the clock: the daemon ends it within seconds of `until`. */
const isOn = (a: Autonomous, now: Date) => !!a.since && !!a.until && Date.parse(a.until) > now.getTime();

function when(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString()
    ? hm
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

/** A `datetime-local` value: the next 08:00, in this browser's time zone. */
function nextMorning(): string {
  const d = new Date();
  if (d.getHours() >= 8) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Off writes `until = now`: the daemon then asks the control chat for its summary and clears it. */
function save(project: string, on: boolean, until?: string) {
  const at = new Date().toISOString();
  const patch = on ? { autonomousSince: at, autonomousUntil: until } : { autonomousUntil: at };
  return sendJson('PUT', '/api/config', { patch: { projects: { [project]: patch } } })
    .then(() =>
      toast.success(
        on
          ? `Autonomous until ${when(until!)}`
          : 'Autonomous mode is off. The control chat writes you a summary in its chat.',
      ),
    )
    .catch((e: Error) => toast.error('Could not switch autonomous mode', { description: e.message }));
}

/** Project settings: switch autonomous mode on until a set time, or off. */
export function AutonomousMode({ name, state = OFF }: { name: string; state?: Autonomous }) {
  const id = useId();
  const now = useNow(5_000);
  const [until, setUntil] = useState(nextMorning);
  const [busy, setBusy] = useState(false);
  const on = isOn(state, now);
  const untilIso = until ? new Date(until).toISOString() : '';
  const valid = !!until && Date.parse(untilIso) > now.getTime();
  const flip = (v: boolean) => {
    setBusy(true);
    void save(name, v, untilIso).finally(() => setBusy(false));
  };
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={`${id}-title`} className="text-[0.9375rem] font-medium">
            Autonomous mode
          </h2>
          <p className="text-sm text-muted-foreground">
            {on
              ? `On since ${when(state.since!)}, until ${when(state.until!)}`
              : state.until
                ? `Off. Last ran until ${when(state.until)}.`
                : 'Off'}
          </p>
        </div>
        <Switch
          aria-labelledby={`${id}-title`}
          checked={on}
          disabled={busy || (!on && !valid)}
          onCheckedChange={flip}
        />
      </div>
      {!on && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-until`} className="text-sm text-muted-foreground">
            Until
          </label>
          <Input
            id={`${id}-until`}
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            aria-invalid={!valid}
            className="w-auto"
          />
        </div>
      )}
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        For when you are away. New workers start in auto mode, with no plan menu. The control chat answers
        them, approves their plans, starts the next item from a queue you gave it and gets red pipelines and
        review threads fixed, and logs each decision. It never merges into dev or main, touches production,
        writes to dev unless you said so, or removes workers; owner decisions (copy, money, GDPR, values) wait
        for you. When it ends, the control chat writes you a summary in its chat. Put the control chat in auto
        mode too (Shift+Tab in its terminal), or its own permission prompts wait for you.
      </p>
    </section>
  );
}

/** On the project page while it is on. */
export function AutonomousBanner({ name, state = OFF }: { name: string; state?: Autonomous }) {
  const now = useNow(5_000);
  const [busy, setBusy] = useState(false);
  if (!isOn(state, now)) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-st-yellow/40 bg-st-yellow/8 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3 text-[0.9375rem]">
        <RobotIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-st-yellow" aria-hidden />
        <div>
          <div className="font-medium">Autonomous until {when(state.until!)}</div>
          <div className="text-muted-foreground">
            The control chat acts on its own, within its limits.{' '}
            <Link href={`/p/${name}/settings`} className="underline underline-offset-3">
              Settings
            </Link>
          </div>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void save(name, false).finally(() => setBusy(false));
        }}
      >
        Turn off
      </Button>
    </div>
  );
}
