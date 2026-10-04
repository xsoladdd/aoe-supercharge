import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where fake sessions keep Claude Code transcripts and AoE's hook state (mirrors the real layout). */
export interface TranscriptDirs {
  claudeDir: string;
  hooksDir: string;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> };

/**
 * Writes transcript records shaped like Claude Code 2.1.x (~/.claude/projects/<cwd>/<id>.jsonl) and
 * the AoE hook file that maps an AoE session to it. Used by the demo and E2E world only.
 */
export class FakeTranscript {
  readonly file: string;
  private toolSeq = 0;
  /** What replies record as their model and effort; /model and /effort change them. */
  model = 'claude-opus-5-5';
  effort = 'high';
  /** Tool calls without a result yet, oldest first. */
  readonly pending: string[] = [];

  constructor(
    dirs: TranscriptDirs,
    aoeId: string,
    private cwd: string,
    readonly claudeId: string = randomUUID(),
  ) {
    this.file = join(dirs.claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${claudeId}.jsonl`);
    mkdirSync(dirname(this.file), { recursive: true });
    const hook = join(dirs.hooksDir, aoeId, 'session_id');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `${claudeId}\n`);
  }

  private write(type: string, extra: Record<string, unknown>) {
    const rec = {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.claudeId,
      version: '2.1.0',
      type,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      ...extra,
    };
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
  }

  title(text: string) {
    appendFileSync(
      this.file,
      `${JSON.stringify({ type: 'ai-title', aiTitle: text, sessionId: this.claudeId })}\n`,
    );
  }

  /** A slash command's echo, as Claude Code records it (shown nowhere in the chat). */
  command(name: string, args: string, stdout: string) {
    this.write('user', {
      message: {
        role: 'user',
        content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
      },
    });
    this.write('user', {
      message: { role: 'user', content: `<local-command-stdout>${stdout}</local-command-stdout>` },
    });
  }

  user(text: string) {
    this.write('user', { message: { role: 'user', content: text }, origin: { kind: 'human' } });
  }

  /** One API message; like Claude Code, each content block is its own record. Returns tool ids in order. */
  assistant(...blocks: Block[]): string[] {
    const id = `msg_${randomBytes(12).toString('hex')}`;
    const tools: string[] = [];
    for (const b of blocks) {
      const content =
        b.type === 'tool_use'
          ? {
              ...b,
              id:
                b.id ??
                `toolu_fake${String(++this.toolSeq).padStart(4, '0')}${randomBytes(4).toString('hex')}`,
            }
          : b;
      if (content.type === 'tool_use') {
        tools.push(content.id!);
        this.pending.push(content.id!);
      }
      this.write('assistant', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [content],
          usage: { input_tokens: 1200, cache_read_input_tokens: 40_000, output_tokens: 300 },
        },
        effort: this.effort,
      });
    }
    return tools;
  }

  result(toolUseId: string, content: string, isError = false) {
    const i = this.pending.indexOf(toolUseId);
    if (i >= 0) this.pending.splice(i, 1);
    this.write('user', {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
      },
    });
  }

  /** Escape on a menu: Claude Code rejects the call it was asking about and stops. */
  rejectPending() {
    const id = this.pending.at(-1);
    if (!id) return;
    this.result(
      id,
      "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed.",
      true,
    );
    this.write('user', {
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    });
  }

  /** A tool call and its result in one go. */
  tool(name: string, input: Record<string, unknown>, output: string, isError = false) {
    const [id] = this.assistant({ type: 'tool_use', name, input });
    this.result(id!, output, isError);
  }
}

const text = (t: string): Block => ({ type: 'text', text: t });

/** A control chat that planned a launch and started workers: tables, code, folded tool calls. */
export function seedControlChat(t: FakeTranscript, repo: string) {
  t.title('Northwind launch plan');
  t.user('Plan the launch work for the Northwind site and start a worker for each piece.');
  t.assistant(text('I’ll look at the repo first so the plan matches what is there.'));
  t.tool(
    'Bash',
    { command: 'git log --oneline -5 && ls', description: 'Recent commits and files' },
    'a1b2c3d init\nREADME.md',
  );
  t.tool('Read', { file_path: `${repo}/README.md` }, '     1\t# northwind-web\n');
  t.assistant(
    text(
      [
        '## Launch plan',
        '',
        'The repo is a fresh scaffold, so I split the work into six tasks. Most can run in parallel:',
        '',
        '| Task | Depends on | Notes |',
        '|---|---|---|',
        '| Page templates | none | Match the approved Figma frames |',
        '| Content entry | templates | Copy from the client deck |',
        '| Accessibility audit | templates | WCAG 2.2 AA |',
        '| Hosting and CI | none | Staging first |',
        '| QA and browser testing | templates, content | Includes mobile Safari |',
        '| DNS cutover runbook | hosting | 06:00 to 08:00 GMT window |',
        '',
        'Each task gets its own worker and worktree. For example:',
        '',
        '```bash',
        'supercharge task new "Build page templates" \\',
        '  --brief "Header, listing and detail templates. Match the Figma frames."',
        '```',
        '',
        'Workers plan first and wait for your approval before they write code.',
      ].join('\n'),
    ),
  );
  for (const [title, id] of [
    ['Build page templates', 'NW-0001'],
    ['Content entry for launch pages', 'NW-0002'],
    ['Accessibility audit (WCAG 2.2 AA)', 'NW-0003'],
    ['Set up hosting and repository', 'NW-0004'],
    ['QA and browser testing', 'NW-0005'],
    ['DNS cutover runbook', 'NW-0006'],
  ])
    t.tool(
      'Bash',
      { command: `supercharge task new "${title}"` },
      `Created ${id} ${title}\nWorker started in its own worktree.`,
    );
  t.assistant(
    text(
      'All six workers are running. **NW-0002** asked whether the copy deck from Friday is final; it is waiting for you in *Needs you*.',
    ),
  );
  t.user('What is the status of the templates task?');
  t.tool(
    'Bash',
    { command: 'supercharge status --json', description: 'Current stage of every task' },
    '{\n  "NW-0001": { "stage": "mr_raised", "mr": 41, "pipeline": "running", "unresolved": 2 }\n}',
  );
  t.assistant(
    text(
      [
        '**NW-0001, Build page templates** is at *MR raised*:',
        '',
        '- MR !41 is open and its pipeline is still running',
        '- 2 review threads are unresolved',
        '- Storybook and the visual tests passed locally',
        '',
        'Once the pipeline is green I’ll ask the worker to answer the review threads. The stage it moves through next:',
        '',
        '```ts',
        "const next: Stage[] = ['watching_mr', 'ready_for_review'];",
        '```',
      ].join('\n'),
    ),
  );
}

/** A worker mid-task: edits, a failed command, and a call still running. */
export function seedWorkerChat(t: FakeTranscript, worktree: string) {
  t.title('Accessibility audit');
  t.user('Start the accessibility audit. Header and listing first.');
  t.assistant(text('Starting with the header. I’ll check the colour tokens first.'));
  t.tool(
    'Grep',
    { pattern: '--color-muted', path: 'src/styles' },
    'src/styles/tokens.css:14:  --color-muted: #8a8f98;',
  );
  t.tool(
    'Read',
    { file_path: `${worktree}/src/components/Header.tsx` },
    '  12\t<button onClick={toggle}>\n  13\t  <MenuIcon />\n  14\t</button>',
  );
  t.assistant(
    text(
      [
        'Two problems in the header:',
        '',
        '1. Muted text on the surface colour is **3.9:1**, below the 4.5:1 minimum.',
        '2. The menu button has no accessible name.',
        '',
        'Fixing both:',
        '',
        '```tsx',
        '<button onClick={toggle} aria-label="Open menu">',
        '  <MenuIcon aria-hidden />',
        '</button>',
        '```',
      ].join('\n'),
    ),
  );
  t.tool(
    'Edit',
    {
      file_path: `${worktree}/src/components/Header.tsx`,
      old_string: '<button onClick={toggle}>',
      new_string: '<button onClick={toggle} aria-label="Open menu">',
    },
    `The file ${worktree}/src/components/Header.tsx has been updated.`,
  );
  t.tool(
    'Bash',
    { command: 'npm run lint' },
    'error  src/styles/tokens.css  Unknown property "colour"',
    true,
  );
  t.assistant(text('Lint caught a typo in my token edit. Fixed it, now running the header checks.'));
  t.assistant({
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'npm run test:a11y -- header', description: 'Axe checks for the header' },
  });
}

/** A worker in plan mode whose plan waits for approval (ExitPlanMode with no result yet). */
export function seedPlanApproval(t: FakeTranscript, worktree: string) {
  t.title('Upgrade to Node 24');
  t.user('Plan the Node 24 upgrade. Keep it to the runtime; no dependency bumps beyond what it needs.');
  t.tool('Read', { file_path: `${worktree}/package.json` }, '  4\t"engines": { "node": ">=20" },');
  t.tool(
    'Grep',
    { pattern: 'node:20', path: '.' },
    'Dockerfile:1:FROM node:20-alpine\n.gitlab-ci.yml:3:image: node:20',
  );
  t.assistant(
    text(
      'Three places pin Node 20: `package.json` engines, the Dockerfile and the CI image. Here is the plan.',
    ),
    {
      type: 'tool_use',
      name: 'ExitPlanMode',
      input: {
        plan: [
          '# Upgrade to Node 24',
          '',
          '## Changes',
          '',
          '1. `package.json`: set `engines.node` to `>=24`',
          '2. `.nvmrc`: `24`',
          '3. `Dockerfile`: `FROM node:24-alpine`',
          '4. `.gitlab-ci.yml`: `image: node:24`',
          '',
          '```dockerfile',
          'FROM node:24-alpine',
          'WORKDIR /app',
          '```',
          '',
          '## Verification',
          '',
          '- `npm ci && npm test` on Node 24',
          '- CI pipeline green on the MR',
          '',
          '**Out of scope:** dependency upgrades not required by Node 24.',
        ].join('\n'),
        planFilePath: '~/.claude/plans/node-24-upgrade.md',
      },
    },
  );
}

/** A worker about to run a command that needs permission (the call has no result yet). */
export function seedPermissionWait(t: FakeTranscript) {
  t.title('Rate limit the export endpoint');
  t.user('Add the token bucket and load test it.');
  t.assistant(text('The limiter is in. Load testing it at 200 requests a second.'), {
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'npm run load-test -- --rate 200', description: 'Load test the export endpoint' },
  });
}

/** Lazily gives each fake session a transcript, and answers messages sent to it like a quick agent. */
export class FakeTranscripts {
  private byId = new Map<string, FakeTranscript>();
  constructor(readonly dirs: TranscriptDirs) {}

  for(aoeId: string, cwd: string): FakeTranscript {
    let t = this.byId.get(aoeId);
    if (!t) {
      t = new FakeTranscript(this.dirs, aoeId, cwd);
      this.byId.set(aoeId, t);
    }
    return t;
  }

  get(aoeId: string): FakeTranscript | null {
    return this.byId.get(aoeId) ?? null;
  }

  /** The prompt lands at once; the reply follows a moment later. Statuses are left alone on purpose. */
  converse(aoeId: string, cwd: string, message: string, delayMs = 900) {
    const t = this.for(aoeId, cwd);
    // /model and /effort answer at once, like Claude Code's local commands.
    const slash = /^\/(model|effort)\s+(\S+)/.exec(message.trim());
    if (slash) {
      const [, name, arg] = slash;
      if (name === 'model') {
        t.model = arg === 'default' ? 'claude-opus-5-5' : `claude-${arg}-5`;
        t.command('model', arg!, `Set model to \`${t.model}\` and saved as your default for new sessions`);
      } else {
        if (arg !== 'auto') t.effort = arg!;
        t.command('effort', arg!, `Set effort level to ${arg} (saved as your default for new sessions)`);
      }
      return;
    }
    t.user(message);
    setTimeout(() => {
      t.tool(
        'Bash',
        { command: 'supercharge status', description: 'Check the current state' },
        'All tasks on track.',
      );
      t.assistant({
        type: 'text',
        text: `Got it. I’ll take it from here:\n\n> ${message.split('\n')[0]}\n\nI’ll report back in this chat when it is done.`,
      });
    }, delayMs).unref?.();
  }
}
