import { describe, expect, it } from 'vitest';
import { destructiveReasons } from '../src/shared/destructive.ts';

const whats = (command: string) => destructiveReasons(command).map((r) => r.what);

describe('destructiveReasons: commands a Run warns about', () => {
  it('flags removing an AoE session with its worktree, its branch, or for good', () => {
    expect(whats('aoe rm --purge --delete-worktree --delete-branch nw-0003')).toEqual([
      'aoe rm --purge',
      '--delete-worktree',
      '--delete-branch',
    ]);
    expect(whats('aoe remove nw-0003 --delete-worktree')).toEqual(['--delete-worktree']);
    expect(whats('aoe -p work rm --force nw-0003')).toEqual(['aoe rm --force']);
    expect(whats('aoe session empty-trash')).toEqual(['aoe session empty-trash']);
    expect(whats('aoe killall')).toEqual(['aoe killall']);
  });

  it('flags rm with both recursive and force, however they are written', () => {
    for (const c of [
      'rm -rf build',
      'rm -fr build',
      'rm -Rf build',
      'rm -r -f build',
      'rm --recursive --force x',
    ])
      expect(whats(c), c).toEqual(['rm -rf']);
    expect(whats('/bin/rm -rf x')).toEqual(['rm -rf']);
  });

  it('flags git commands that lose commits, branches or files', () => {
    expect(whats('git reset --hard origin/main')).toEqual(['git reset --hard']);
    expect(whats('git -C ../wt reset --hard')).toEqual(['git reset --hard']);
    expect(whats('git push --force')).toEqual(['git push --force']);
    expect(whats('git push -f origin main')).toEqual(['git push --force']);
    expect(whats('git push -fu origin main')).toEqual(['git push --force']);
    expect(whats('git push origin +main')).toEqual(['git push --force']);
    expect(whats('git push --force-with-lease')).toEqual(['git push --force-with-lease']);
    expect(whats('git push origin --delete old')).toEqual(['git push --delete']);
    expect(whats('git push origin :old')).toEqual(['git push --delete']);
    expect(whats('git branch -D sc/nw-0003')).toEqual(['git branch -D']);
    expect(whats('git branch --delete --force sc/nw-0003')).toEqual(['git branch -D']);
    expect(whats('git branch -df sc/nw-0003')).toEqual(['git branch -D']);
    expect(whats('git clean -f')).toEqual(['git clean -f']);
    expect(whats('git clean -fdx')).toEqual(['git clean -f']);
    expect(whats('git worktree remove --force ../wt')).toEqual(['git worktree remove --force']);
  });

  it('leaves look-alikes alone', () => {
    for (const c of [
      'aoe rm nw-0003',
      'aoe session list-trash',
      'git push',
      'git push -u origin sc/nw-0003',
      'git branch -d sc/nw-0003',
      'git reset HEAD~1',
      'git clean -n -f',
      'git clean -fd --dry-run',
      'git worktree remove ../wt',
      'rm -r build',
      'rm -f file.txt',
      'echo "rm -rf /"',
      "printf '%s' 'git push --force'",
      '# rm -rf build',
      'supercharge task cleanup NW-0003',
      'ls -la',
    ])
      expect(whats(c), c).toEqual([]);
  });

  it('looks into chains, wrappers, subshells and shell -c', () => {
    expect(whats('cd ../wt && git status; rm -rf node_modules')).toEqual(['rm -rf']);
    expect(whats('git fetch || git reset --hard')).toEqual(['git reset --hard']);
    expect(whats('FORCE=1 sudo -u me rm -rf /tmp/x')).toEqual(['rm -rf']);
    expect(whats('ls | xargs -0 rm -rf')).toEqual(['rm -rf']);
    expect(whats('(cd ../wt && git clean -fd)')).toEqual(['git clean -f']);
    expect(whats('echo $(git reset --hard)')).toEqual(['git reset --hard']);
    expect(whats('bash -c "git push --force"')).toEqual(['git push --force']);
    expect(whats("zsh -lc 'aoe session empty-trash'")).toEqual(['aoe session empty-trash']);
    expect(whats('find . -name "*.log" -exec rm -rf {} \\;')).toEqual(['rm -rf']);
    expect(whats('find . -name "*.log" -delete')).toEqual(['find -delete']);
    expect(whats('aoe rm nw-0003 \\\n  --purge')).toEqual(['aoe rm --purge']);
  });

  it('lists each reason once, with what it does', () => {
    const r = destructiveReasons('rm -rf a && rm -rf b');
    expect(r).toHaveLength(1);
    expect(r[0]!.why).toMatch(/for good/);
  });
});
