import { describe, expect, it } from 'vitest';
import { mrLinkBase, mrRefs } from '../src/shared/index.ts';

const GH = 'https://github.com/acme/app/pull/';
const GL = 'https://git.example.com/group/app/-/merge_requests/';
const links = (text: string, base: string | null) =>
  mrRefs(text, base)
    .filter((p) => p.href)
    .map((p) => [p.text, p.href]);

describe('mrLinkBase', () => {
  it('builds GitHub and GitLab bases from the remote', () => {
    expect(mrLinkBase('git@github.com:acme/app.git', [])).toBe(GH);
    expect(mrLinkBase('https://git.example.com/group/app.git', [])).toBe(GL);
  });
  it('prefers an MR url the ledger already has', () => {
    expect(mrLinkBase(null, [`${GL}7`])).toBe(GL);
    expect(mrLinkBase('git@github.com:other/repo.git', [`${GH}3`])).toBe(GH);
  });
  it('is null when the repository is unknown', () => expect(mrLinkBase(null, [])).toBeNull());
});

describe('mrRefs', () => {
  it('links PR / MR references on GitHub', () => {
    expect(links('Raised PR #18, see pull request #22 and (#19).', GH)).toEqual([
      ['PR #18', `${GH}18`],
      ['pull request #22', `${GH}22`],
      ['(#19)', `${GH}19`],
    ]);
  });
  it('links MR references on GitLab', () => {
    expect(links('MR !12 and merge request !3', GL)).toEqual([
      ['MR !12', `${GL}12`],
      ['merge request !3', `${GL}3`],
    ]);
  });
  it('keeps the surrounding text and leaves a bare #N alone', () => {
    const out = mrRefs('Fix #5 in PR #6 now', GH);
    expect(out.map((p) => p.text).join('')).toBe('Fix #5 in PR #6 now');
    expect(links('Fix #5 in PR #6 now', GH)).toEqual([['PR #6', `${GH}6`]]);
  });
  it('leaves the text as is when the repository is unknown', () =>
    expect(mrRefs('PR #18', null)).toEqual([{ text: 'PR #18' }]));
});
