export interface RemoteRef {
  host: string;
  path: string;
}

/** git@host:group/repo.git | https://host/group/repo(.git) | ssh://git@host:22/group/repo.git → {host, path} */
export function parseRemote(url: string | null): RemoteRef | null {
  if (!url) return null;
  const scp = url.match(/^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
    return path ? { host: u.hostname.toLowerCase(), path } : null;
  } catch {
    return null;
  }
}

/**
 * The URL an MR number is appended to for a project: taken from an MR URL the ledger already has, else
 * built from the git remote (GitHub `/pull/`, anything else GitLab `/-/merge_requests/`). Null when the
 * repository is unknown, so nothing gets linked.
 */
export function mrLinkBase(remoteUrl: string | null, mrUrls: string[]): string | null {
  for (const url of mrUrls) {
    const m = url.match(/^(https?:\/\/[^/]+\/.+?\/(?:pull|-\/merge_requests)\/)\d+/);
    if (m) return m[1]!;
  }
  const remote = parseRemote(remoteUrl);
  if (!remote) return null;
  return `https://${remote.host}/${remote.path}/${remote.host.includes('github') ? 'pull' : '-/merge_requests'}/`;
}

export interface MrRefPiece {
  text: string;
  /** Set on the pieces that are a merge request reference. */
  href?: string;
}

// "PR #18", "pull request #22", "MR !12", "merge request !3", or a "(#19)" as in a commit title.
const MR_REF = /\b(?:PRs?|pull requests?|MRs?|merge requests?)\s*[#!](\d+)|\(#(\d+)\)/gi;

/** Split plain text so each merge request reference in it carries its URL; `base` from `mrLinkBase`. */
export function mrRefs(text: string, base: string | null): MrRefPiece[] {
  if (!base) return [{ text }];
  const out: MrRefPiece[] = [];
  let at = 0;
  for (const m of text.matchAll(MR_REF)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], href: `${base}${m[1] ?? m[2]}` });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
