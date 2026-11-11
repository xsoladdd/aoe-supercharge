import type { Config } from '@aoe-supercharge/core/node';
import {
  needsYouPath,
  type BrowserNotice,
  type NeedsYouItem,
  type NeedsYouKind,
} from '@aoe-supercharge/core/shared';
import { run, which } from './util/exec.ts';

export interface NotifyOptions {
  /** A page a click opens: only with terminal-notifier installed (macOS); osascript can't. */
  open?: string;
  /** A newer notification in the same group replaces the one on screen (terminal-notifier). */
  group?: string;
  platform?: NodeJS.Platform;
}

/**
 * Desktop notification via osascript (macOS) or notify-send (Linux). Text is passed as argv, never
 * interpolated. On macOS, terminal-notifier is used instead when it happens to be installed and there
 * is a page to open; it is never required.
 */
export async function notify(title: string, body: string, opts: NotifyOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const tn = opts.open ? await which('terminal-notifier') : null;
    if (tn) {
      const args = ['-title', title, '-message', body, '-open', opts.open!];
      if (opts.group) args.push('-group', opts.group);
      const r = await run(tn, args, { timeoutMs: 10_000 });
      if (r.code === 0) return true;
    }
    const r = await run(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        body,
      ],
      { timeoutMs: 10_000 },
    );
    return r.code === 0;
  }
  if (platform === 'linux') {
    const r = await run('notify-send', ['-a', 'Supercharge', title, body], { timeoutMs: 10_000 });
    return r.code === 0;
  }
  return false;
}

/** One notification, with the dashboard page a click on it opens (path only). */
export interface Notice {
  id: string;
  title: string;
  body: string;
  href: string;
}

/**
 * Where a notice goes: to the dashboard tabs that show notifications themselves (a click there opens
 * the item), or, with none open, the daemon's own desktop notification.
 */
export function deliverNotice(
  tabs: { notifyClients: number; notify(n: Omit<BrowserNotice, 'at'>): void },
  origin: () => string,
  send: typeof notify = notify,
) {
  return async (n: Notice & { test?: boolean }): Promise<boolean> => {
    if (tabs.notifyClients > 0) {
      tabs.notify(n);
      return true;
    }
    return send(n.title, n.body, {
      open: new URL(n.href, origin()).toString(),
      group: `supercharge:${n.id}`,
    });
  };
}

/** The setting that turns a kind's notification on; null: never notified on its own. */
const TOGGLE: Record<NeedsYouKind, keyof Config['notifications'] | null> = {
  question: 'blocked',
  approval: 'aoeWaiting',
  plan_approval: 'aoeWaiting',
  permission: 'aoeWaiting',
  control_waiting: 'controlWaiting',
  control_replied: 'controlWaiting',
  control_blocker: 'blocked',
  // The rest of a NEEDS YOU list arrives with the reply, which "Control chat replied" announces.
  control_needs: null,
  // About a worker who waits on you for it: its own item has told you already.
  control_relayed: null,
  session_error: 'error',
  session_missing: 'error',
  mr_ready: 'readyForReview',
  mr_closed: 'readyForReview',
  schedule_failed: 'error',
};

const TITLE: Record<NeedsYouKind, string> = {
  question: 'Question from a worker',
  approval: 'Approval waiting in AoE',
  plan_approval: 'Plan ready for approval',
  permission: 'Permission needed',
  control_waiting: 'Control chat waiting',
  control_replied: 'Control chat replied',
  control_blocker: 'Blocked on you',
  control_needs: 'Control chat needs you',
  control_relayed: 'Passed on by the control chat',
  session_error: 'Session error',
  session_missing: 'Session missing',
  mr_ready: 'Ready for review',
  mr_closed: 'MR closed',
  schedule_failed: 'Scheduled prompt failed',
};

/**
 * Notifies once per new Needs-you item. Items present when the daemon first loads are treated as
 * already seen, so a restart doesn't replay every notification.
 */
export class Notifier {
  private seen = new Set<string>();
  private armed = false;

  constructor(
    private config: () => Config,
    private send: (notice: Notice) => Promise<boolean> = (n) => notify(n.title, n.body),
  ) {}

  arm(current: NeedsYouItem[]) {
    for (const i of current) this.seen.add(i.id);
    this.armed = true;
  }

  get isArmed() {
    return this.armed;
  }

  async onNeedsYou(items: NeedsYouItem[]): Promise<NeedsYouItem[]> {
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...this.seen]) if (!ids.has(id)) this.seen.delete(id);
    if (!this.armed) return [];
    const n = this.config().notifications;
    const fresh = items.filter((i) => !this.seen.has(i.id));
    for (const i of fresh) this.seen.add(i.id);
    if (!n.enabled) return [];
    const toSend = fresh.filter((i) => {
      const toggle = TOGGLE[i.kind];
      return toggle !== null && n[toggle];
    });
    for (const i of toSend)
      await this.send({
        id: i.id,
        title: TITLE[i.kind],
        body: `${i.title}: ${i.detail}`,
        href: needsYouPath(i),
      });
    return toSend;
  }
}
