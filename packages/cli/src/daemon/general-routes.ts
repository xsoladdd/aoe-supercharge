import type { Context, Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { newGeneralSession, startGeneralControl } from '../general.ts';
import { CliError, EXIT } from '../util/errors.ts';
import { MAX_COMMAND } from '../workflow.ts';
import type { HeldMessages } from './held.ts';
import type { Store } from './store.ts';

/**
 * General chats and the General control chat (SPEC §14.7): started from the dashboard (cookie, CSRF
 * checked by the /api guard) or by `supercharge general new` (bearer). One start at a time, so two
 * clicks never make two control chats and two sessions never get the same name.
 */
export function generalRoutes(
  app: Hono,
  deps: { ctx: Ctx; store: Store; held?: HeldMessages; poll: () => void },
) {
  const { ctx, store } = deps;
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const via = (c: Context) =>
    (c.get('auth' as never) as { via?: string } | undefined)?.via === 'cookie' ? 'ui' : 'cli';
  const refresh = async () => {
    store.setGeneral(await ctx.ledger.getGeneral());
    deps.poll();
  };
  const failed = (c: Context, err: unknown) =>
    err instanceof CliError
      ? c.json(
          {
            error: err.exitCode === EXIT.limited ? 'limited' : 'bad_request',
            message: err.message,
            hint: err.hint,
          },
          err.exitCode === EXIT.limited ? 409 : 400,
        )
      : c.json({ error: 'aoe_failed', message: (err as Error).message }, 502);

  app.post('/api/general/control', async (c) => {
    try {
      const r = await oneAtATime(() => startGeneralControl(ctx, via(c)));
      await refresh();
      return c.json(r, r.created ? 201 : 200);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post('/api/general/sessions', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) =>
      typeof body?.[k] === 'string' && (body[k] as string).trim() ? (body[k] as string) : undefined;
    const message = str('message')?.trim();
    if (!body || (message && message.length > MAX_COMMAND))
      return c.json(
        { error: 'bad_request', message: 'Expected { title?, model?, effort?, message?, worker?, force? }.' },
        400,
      );
    if (message && !deps.held)
      return c.json(
        { error: 'unavailable', message: 'The daemon cannot hold a first message right now.' },
        503,
      );
    try {
      const worker = body.worker === true;
      const s = await oneAtATime(() =>
        newGeneralSession(ctx, {
          title: str('title'),
          model: str('model'),
          effort: str('effort'),
          worker,
          force: body.force === true,
          actor: worker ? 'control' : via(c),
        }),
      );
      // Typed in once the session is at its prompt (after any startup menu), like a held chat message.
      const held = message ? await deps.held!.hold(s.sessionId, message) : null;
      await refresh();
      return c.json({ ...s, held: !!held }, 201);
    } catch (err) {
      return failed(c, err);
    }
  });
}
