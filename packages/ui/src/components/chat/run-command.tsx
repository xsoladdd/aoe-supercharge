import {
  ChatTeardropTextIcon,
  CircleNotchIcon,
  TerminalIcon,
  TerminalWindowIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { destructiveReasons, type SessionView } from '@aoe-supercharge/core/shared';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiError, sendJson } from '@/lib/api';
import { openRunTerminal } from '@/lib/run-terminals';
import { requestShellRun } from '@/lib/shell-runs';

type Choice = 'chat' | 'shell' | 'terminal';
const CHOICE_KEY = 'supercharge.runChoice';

function lastChoice(): Choice {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    return v === 'shell' || v === 'terminal' ? v : 'chat';
  } catch {
    return 'chat';
  }
}

function remember(c: Choice) {
  try {
    localStorage.setItem(CHOICE_KEY, c);
  } catch {
    // A private window: Enter picks Run in chat next time.
  }
}

/**
 * Run a command from Claude's reply, once you confirm it, in one of three ways:
 *
 * - **In the chat:** Supercharge types `!` and the command into the session, so Claude Code runs it as
 *   you, in the session's folder (shell mode), and Claude reads the output.
 * - **In the control shell** (control chats): the session's own shell in the side panel's Shell tab.
 * - **In a new terminal:** a terminal of its own, right under the command, which stays until you close it.
 *
 * Enter runs the highlighted way, the one you used last (Run in chat at first), and Escape cancels. A
 * command that can lose work for good gets a red warning and no highlighted way, so Enter cancels it.
 */
export function RunCommand({
  session,
  command,
  anchor,
  open,
  onOpenChange,
  onRan,
  controlShell = false,
}: {
  session: SessionView;
  command: string;
  /** Where the command sits in the chat; a new terminal shows there. */
  anchor?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ran in the chat (shell mode), which shows it as yours. */
  onRan: (command: string) => void;
  /** Offer Run in control shell: the session has a Shell tab in its side panel. */
  controlShell?: boolean;
}) {
  const [busy, setBusy] = useState<Choice | null>(null);
  const working = session.status === 'working';
  const reasons = useMemo(() => destructiveReasons(command), [command]);
  const buttons = {
    chat: useRef<HTMLButtonElement>(null),
    shell: useRef<HTMLButtonElement>(null),
    terminal: useRef<HTMLButtonElement>(null),
  };
  const usable = (c: Choice) => (c === 'chat' ? !working : c === 'shell' ? controlShell : true);
  // Read when the dialog opens, so it follows your last choice.
  const last = useMemo(() => (open ? lastChoice() : 'chat'), [open]);
  const primary: Choice | null = reasons.length ? null : usable(last) ? last : 'terminal';

  const done = (c: Choice) => {
    remember(c);
    onOpenChange(false);
  };
  const inChat = async () => {
    setBusy('chat');
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(session.id)}/run`, { command });
      onRan(command);
      done('chat');
    } catch (e) {
      toast.error('Command not run', { description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  };
  const inTerminal = async () => {
    setBusy('terminal');
    try {
      await openRunTerminal(session.id, command, anchor ?? '');
      done('terminal');
    } catch (e) {
      toast.error('Could not open a terminal', {
        description: e instanceof ApiError ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };
  // A command that loses work has no highlighted way: the red warning above says why.
  const variant = (c: Choice) => (c === primary ? 'default' : 'outline');

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto data-[size=default]:sm:max-w-2xl"
        onOpenAutoFocus={(e) => {
          // Enter runs the highlighted way; with nothing highlighted, Cancel keeps the focus.
          const el = primary && buttons[primary].current;
          if (!el) return;
          e.preventDefault();
          el.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Run this command?</AlertDialogTitle>
          <AlertDialogDescription>
            It runs as you in{' '}
            {session.projectPath ? (
              <span translate="no" className="font-mono text-[0.8125rem] break-all">
                {session.projectPath}
              </span>
            ) : (
              "the session's folder"
            )}
            . Recorded in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre
          translate="no"
          className="max-h-72 min-w-0 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap"
        >
          {command}
        </pre>
        {reasons.length > 0 && (
          <div role="alert" className="rounded-lg border border-st-red/40 bg-st-red/8 px-3.5 py-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-st-red">
              <WarningIcon weight="fill" className="size-4 shrink-0" aria-hidden />
              This can't be undone
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              {reasons.map((r) => (
                <li key={r.what}>
                  <code translate="no" className="font-mono text-[0.8125rem]">
                    {r.what}
                  </code>{' '}
                  {r.why}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">Make sure it is what you want before you run it.</p>
          </div>
        )}
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Run in chat:</span> through Claude Code's shell
            mode, like typing <span className="font-mono">!</span> and the command in its terminal. Claude
            reads the output and replies.
          </li>
          {controlShell && (
            <li>
              <span className="font-medium text-foreground">Run in control shell:</span> in this chat's shell,
              in the Shell tab of the side panel. You see the output there and can answer its prompts; Claude
              doesn't see it.
            </li>
          )}
          <li>
            <span className="font-medium text-foreground">Run in a new terminal:</span> in a terminal of its
            own, right under the command in this chat. You see the output and can answer its prompts, and it
            stays until you close it; Claude doesn't see it.
          </li>
        </ul>
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            ref={buttons.chat}
            variant={variant('chat')}
            disabled={busy !== null || working}
            onClick={() => void inChat()}
            title={working ? 'Wait until Claude is done' : undefined}
          >
            {busy === 'chat' ? <CircleNotchIcon className="animate-spin" /> : <ChatTeardropTextIcon />}
            Run in chat
          </Button>
          {controlShell && (
            <Button
              ref={buttons.shell}
              variant={variant('shell')}
              disabled={busy !== null}
              onClick={() => {
                requestShellRun(session.id, command);
                done('shell');
              }}
            >
              <TerminalIcon />
              Run in control shell
            </Button>
          )}
          <Button
            ref={buttons.terminal}
            variant={variant('terminal')}
            disabled={busy !== null}
            onClick={() => void inTerminal()}
          >
            {busy === 'terminal' ? <CircleNotchIcon className="animate-spin" /> : <TerminalWindowIcon />}
            Run in a new terminal
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
