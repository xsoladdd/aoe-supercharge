import { mrLinkBase } from '@aoe-supercharge/core/shared';
import type { Snapshot } from '@aoe-supercharge/core/shared';
import { createContext } from 'react';

/** Where "PR #N" in a project's chat text links to; null (no project, unknown repository) links nothing. */
export const MrLinkBase = createContext<string | null>(null);

export function projectMrBase(snap: Snapshot, project: string | null): string | null {
  const p = project ? snap.projects.find((x) => x.name === project) : null;
  if (!p) return null;
  const urls = snap.tasks.filter((t) => t.project === p.name && t.mr).map((t) => t.mr!.url);
  return mrLinkBase(p.remoteUrl, urls);
}
