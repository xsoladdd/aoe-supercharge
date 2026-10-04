import type { Config } from '@aoe-supercharge/core/node';
import type { NeedsYouItem, NeedsYouKind } from '@aoe-supercharge/core/shared';
import { run } from './util/exec.ts';

/** Desktop notification via osascript (macOS) or notify-send (Linux). Text is passed as argv, never interpolated. */
export async function notify(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === 'darwin') {
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

const TOGGLE: Record<NeedsYouKind, keyof Config['notifications']> = {
  question: 'blocked',
  approval: 'aoeWaiting',
  control_waiting: 'controlWaiting',
  control_replied: 'controlWaiting',
  session_error: 'error',
  session_missing: 'error',
  mr_ready: 'readyForReview',
  mr_closed: 'readyForReview',
};

const TITLE: Record<NeedsYouKind, string> = {
  question: 'Question from a worker',
  approval: 'Approval waiting in AoE',
  control_waiting: 'Control chat waiting',
  control_replied: 'Control chat replied',
  session_error: 'Session error',
  session_missing: 'Session missing',
  mr_ready: 'Ready for review',
  mr_closed: 'MR closed',
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
    private send: (title: string, body: string) => Promise<boolean> = notify,
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
    const toSend = fresh.filter((i) => n[TOGGLE[i.kind]]);
    for (const i of toSend) await this.send(TITLE[i.kind], `${i.title}: ${i.detail}`);
    return toSend;
  }
}
