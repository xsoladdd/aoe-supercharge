import { z } from 'zod';

/**
 * Shapes Supercharge relies on, from AoE 1.17.2 (src/daemon/wire.rs, cli/list.rs).
 * Loose objects on purpose: AoE adds fields between releases, and only `id` is guaranteed.
 * The same schemas back the offline contract tests (fixtures/aoe/<version>/).
 */
export const AoeSessionSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullish(),
  status: z.string().nullish(),
  branch: z.string().nullish(),
  project_path: z.string().nullish(),
  main_repo_path: z.string().nullish(),
  group_path: z.string().nullish(),
  tool: z.string().nullish(),
  unread: z.boolean().nullish(),
  last_error: z.string().nullish(),
  created_at: z.string().nullish(),
  last_accessed_at: z.string().nullish(),
  idle_entered_at: z.string().nullish(),
});
export type AoeSession = z.infer<typeof AoeSessionSchema>;

export const AoeSessionsResponseSchema = z.looseObject({
  sessions: z.array(AoeSessionSchema),
  workspace_ordering: z.array(z.string()).optional(),
});

export const AoeAboutSchema = z.looseObject({
  version: z.string().min(1),
  auth_mode: z.string().optional(),
  read_only: z.boolean().optional(),
  profile: z.string().optional(),
});

export const AoeCliListEntrySchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullish(),
  path: z.string().nullish(),
  group: z.string().nullish(),
  tool: z.string().nullish(),
  profile: z.string().nullish(),
  state: z.string().nullish(),
  parent_session_id: z.string().nullish(),
  worktree: z
    .looseObject({
      branch: z.string().nullish(),
      main_repo_path: z.string().nullish(),
      managed_by_aoe: z.boolean().nullish(),
      base_branch: z.string().nullish(),
    })
    .nullish(),
});
export type AoeCliListEntry = z.infer<typeof AoeCliListEntrySchema>;
export const AoeCliListSchema = z.array(AoeCliListEntrySchema);

export const AoeStatusCountsSchema = z.looseObject({
  waiting: z.number(),
  running: z.number(),
  idle: z.number(),
  stopped: z.number(),
  error: z.number(),
  total: z.number(),
});

export const AoeSendResponseSchema = z.looseObject({ sent: z.boolean() });

export const AoeDeleteResponseSchema = z.looseObject({
  status: z.string(),
  messages: z.array(z.string()).optional(),
});
