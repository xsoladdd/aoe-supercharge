/** Something in a command that can lose work for good: the part that does it, and what it does. */
export interface DestructiveReason {
  /** The command and flag as you would type them: "rm -rf", "git push --force". */
  what: string;
  why: string;
}

type Token = { word: string } | { op: string };

/**
 * Words and operators, roughly as a POSIX shell reads them: quotes, backslashes, comments, line
 * continuations. Quoted text stays one word, so `echo "rm -rf x"` is an echo.
 */
function lex(src: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let inWord = false;
  const end = () => {
    if (inWord) out.push({ word });
    word = '';
    inWord = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i++;
        continue;
      }
      word += src[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      word += src.slice(i + 1, close < 0 ? src.length : close);
      inWord = true;
      i = close < 0 ? src.length : close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        word += src[j];
      }
      inWord = true;
      i = j;
    } else if (c === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if ('\n;&|()`'.includes(c)) {
      end();
      out.push({ op: c });
    } else if (c === '$' && src[i + 1] === '(') {
      end();
      out.push({ op: '$(' });
      i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  return out;
}

/** The simple commands in a script: what runs between `;`, `&&`, `||`, `|`, `&`, newlines and subshells. */
function commands(src: string): string[][] {
  const out: string[][] = [[]];
  for (const t of lex(src)) {
    if ('op' in t) {
      if (out.at(-1)!.length) out.push([]);
    } else out.at(-1)!.push(t.word);
  }
  return out.filter((c) => c.length);
}

interface Parsed {
  long: Set<string>;
  short: Set<string>;
  args: string[];
}

/** Long options (without their `=value`), the letters of short ones, and the rest, in order. */
function options(words: string[]): Parsed {
  const p: Parsed = { long: new Set(), short: new Set(), args: [] };
  for (const [i, w] of words.entries()) {
    if (w === '--') {
      p.args.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith('--')) p.long.add(w.slice(2).split('=')[0]!);
    else if (/^-[A-Za-z]+$/.test(w)) for (const ch of w.slice(1)) p.short.add(ch);
    else p.args.push(w);
  }
  return p;
}

/** Drop a program's own options from the front; `withValue` ones take the next word too. */
function skipOptions(words: string[], withValue: string[]): string[] {
  let i = 0;
  while (i < words.length && words[i]!.startsWith('-') && words[i] !== '-') {
    const w = words[i]!;
    if (w === '--') return words.slice(i + 1);
    i += withValue.includes(w) ? 2 : 1;
  }
  return words.slice(i);
}

const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U'],
  env: ['-u', '-C', '-S'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  nice: ['-n'],
  xargs: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'],
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function check(words: string[], found: DestructiveReason[], depth: number) {
  if (depth > 4) return;
  const add = (what: string, why: string) => {
    if (!found.some((r) => r.what === what)) found.push({ what, why });
  };
  let w = words;
  // Assignments and wrappers before the real program: `FOO=1 sudo -u me rm -rf x`.
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w = w.slice(1);
    const name = w[0]?.split('/').at(-1);
    if (!name || !(name in WRAPPERS)) break;
    w = skipOptions(w.slice(1), WRAPPERS[name]!);
  }
  const program = w[0]?.split('/').at(-1);
  const rest = w.slice(1);
  if (!program) return;

  if (SHELLS.has(program)) {
    const i = rest.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
    if (i >= 0 && rest[i + 1] !== undefined) scan(rest[i + 1]!, found, depth + 1);
    return;
  }
  if (program === 'eval') return scan(rest.join(' '), found, depth + 1);

  if (program === 'rm') {
    const o = options(rest);
    const recursive = o.short.has('r') || o.short.has('R') || o.long.has('recursive');
    const force = o.short.has('f') || o.long.has('force');
    if (recursive && force) add('rm -rf', 'deletes the files and folders for good, without asking.');
    return;
  }

  if (program === 'find') {
    const i = rest.findIndex((x) => x === '-exec' || x === '-execdir');
    if (i >= 0) {
      const end = rest.findIndex((x, j) => j > i && (x === ';' || x === '+'));
      check(rest.slice(i + 1, end < 0 ? undefined : end), found, depth + 1);
    }
    if (rest.includes('-delete')) add('find -delete', 'deletes every file it finds, for good.');
    return;
  }

  if (program === 'git') {
    const args = skipOptions(rest, ['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
    const sub = args[0];
    const o = options(args.slice(1));
    if (sub === 'reset' && o.long.has('hard'))
      add('git reset --hard', 'throws away uncommitted changes, which cannot be got back.');
    if (sub === 'push') {
      if (o.long.has('force') || o.short.has('f') || o.args.some((a) => a.startsWith('+')))
        add('git push --force', 'overwrites the branch on the remote, dropping commits that are only there.');
      else if (o.long.has('force-with-lease'))
        add('git push --force-with-lease', 'overwrites the branch on the remote.');
      if (o.long.has('delete') || o.short.has('d') || o.args.some((a) => /^:./.test(a)))
        add('git push --delete', 'deletes a branch on the remote.');
    }
    if (sub === 'branch') {
      const del = o.short.has('d') || o.long.has('delete');
      const force = o.short.has('f') || o.long.has('force');
      if (o.short.has('D') || (del && force))
        add('git branch -D', "deletes a branch even when it isn't merged.");
    }
    if (
      sub === 'clean' &&
      (o.short.has('f') || o.long.has('force')) &&
      !o.short.has('n') &&
      !o.long.has('dry-run')
    )
      add('git clean -f', 'deletes untracked files for good.');
    if (sub === 'worktree' && o.args[0] === 'remove' && (o.short.has('f') || o.long.has('force')))
      add('git worktree remove --force', 'deletes the worktree folder even with uncommitted changes in it.');
    return;
  }

  if (program === 'aoe') {
    const args = skipOptions(rest, ['-p', '--profile', '--daemon-url']);
    const sub = args[0];
    const o = options(args.slice(1));
    if (sub === 'rm' || sub === 'remove') {
      if (o.long.has('purge'))
        add('aoe rm --purge', 'deletes the session for good instead of moving it to the trash.');
      if (o.long.has('delete-worktree'))
        add('--delete-worktree', 'deletes the worktree folder, with any work in it that is not pushed.');
      if (o.long.has('delete-branch')) add('--delete-branch', "deletes the session's git branch.");
      if (o.long.has('force')) add('aoe rm --force', 'removes the worktree even with uncommitted changes.');
    }
    if (sub === 'session' && o.args[0] === 'empty-trash')
      add('aoe session empty-trash', 'deletes every trashed session for good.');
    if (sub === 'killall') add('aoe killall', 'force-stops every session and AoE itself, without asking.');
  }
}

function scan(src: string, found: DestructiveReason[], depth: number) {
  for (const c of commands(src)) check(c, found, depth);
}

/**
 * What in a shell command can lose work for good, such as deleting a worktree, a branch or files, or
 * overwriting a remote branch. Empty when nothing stands out. A Run asks you to look twice at these: a
 * cleanup command once deleted a worker's work that was not pushed yet.
 */
export function destructiveReasons(command: string): DestructiveReason[] {
  const found: DestructiveReason[] = [];
  scan(command, found, 0);
  return found;
}
