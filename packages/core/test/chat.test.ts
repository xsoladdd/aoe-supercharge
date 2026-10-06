import { describe, expect, it } from 'vitest';
import { MODELS_55_SINCE, modelMatches, runnableCommand, versionAtLeast } from '../src/shared/chat.ts';

describe('runnableCommand: which code blocks get a Run button', () => {
  it('runs shell-tagged blocks as they are, several lines and comments included', () => {
    const code = 'aoe remove swippy-505-vat-pricing      # merged, 12G\naoe remove hotfix-dev-typecheck';
    expect(runnableCommand('bash', code)).toBe(code);
    expect(runnableCommand('sh', 'ls')).toBe('ls');
    expect(runnableCommand('ZSH', 'ls')).toBe('ls');
  });

  it('leaves out every other block, and empty ones', () => {
    expect(runnableCommand('text', 'aoe remove x')).toBeNull();
    expect(runnableCommand(null, 'aoe remove x')).toBeNull();
    expect(runnableCommand('ts', 'const a = 1')).toBeNull();
    expect(runnableCommand('bash', '  \n')).toBeNull();
  });

  it('keeps only the commands of a console transcript', () => {
    expect(runnableCommand('console', '$ npm test\n> 12 passed\n$ git status\nclean')).toBe(
      'npm test\ngit status',
    );
  });
});

describe('versionAtLeast and modelMatches: is a chat on the model and Claude Code it should be', () => {
  it('compares Claude Code versions, from a bare version or a --version line', () => {
    expect(versionAtLeast('2.1.285', MODELS_55_SINCE)).toBe(true);
    expect(versionAtLeast('2.1.284 (Claude Code)', MODELS_55_SINCE)).toBe(true);
    expect(versionAtLeast('2.1.236', MODELS_55_SINCE)).toBe(false);
    expect(versionAtLeast('2.2.0', MODELS_55_SINCE)).toBe(true);
    expect(versionAtLeast(null, MODELS_55_SINCE)).toBeNull();
  });

  it('matches a model id against an alias or a full id, and stays out of it for opusplan and default', () => {
    expect(modelMatches('claude-sonnet-5', 'opus')).toBe(false);
    expect(modelMatches('claude-opus-5-5', 'opus')).toBe(true);
    expect(modelMatches('claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
    expect(modelMatches('claude-opus-5', 'claude-opus-5-5')).toBe(false);
    expect(modelMatches('claude-sonnet-5', 'opusplan')).toBeNull();
    expect(modelMatches('claude-sonnet-5', 'default')).toBeNull();
    expect(modelMatches(null, 'opus')).toBeNull();
  });
});
