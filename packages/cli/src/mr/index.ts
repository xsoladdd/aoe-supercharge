import type { Config } from '@aoe-supercharge/core/node';
import type { MrState } from '@aoe-supercharge/core/shared';
import type { RemoteRef } from '../util/git.ts';
import { GitHubProvider } from './github.ts';
import { GitLabProvider } from './gitlab.ts';
import type { MrProvider, MrRef } from './provider.ts';

export type { FoundMr, MrCheck, MrProvider, MrRef } from './provider.ts';
export { pickBranchMr, toMrState } from './provider.ts';

/**
 * Every MR provider Supercharge knows (SPEC §11.1). A project's provider is picked by its remote's
 * host, an MR's by its URL (or the provider it was recorded with).
 */
export class MrProviders {
  constructor(public all: MrProvider[]) {}

  forRemote(remote: RemoteRef | null): MrProvider | null {
    return this.all.find((p) => p.matches(remote)) ?? null;
  }

  forUrl(url: string): { provider: MrProvider; ref: MrRef } | null {
    for (const provider of this.all) {
      const ref = provider.parseUrl(url);
      if (ref) return { provider, ref };
    }
    return null;
  }

  forMr(mr: Pick<MrState, 'provider'>): MrProvider {
    return this.all.find((p) => p.id === mr.provider) ?? this.all[0]!;
  }
}

export function mrProviders(config: Config, env: NodeJS.ProcessEnv): MrProviders {
  return new MrProviders([
    new GitLabProvider(config.mr.gitlab.glabBinary, config.mr.gitlab.hosts, env),
    new GitHubProvider(config.mr.github.ghBinary, config.mr.github.hosts, env),
  ]);
}

/** Whether a draft counts against "ready", for the provider the MR lives on. */
export function readyRequiresNonDraft(config: Config, mr: Pick<MrState, 'provider'>): boolean {
  return mr.provider === 'github'
    ? config.mr.github.readyRequiresNonDraft
    : config.mr.gitlab.readyRequiresNonDraft;
}
