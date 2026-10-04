/** A conversation as the dashboard renders it, parsed from Claude Code's transcript. */
export type ChatBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** One line: the command, file, pattern or URL the tool acted on. */
      summary: string;
      input: string;
      /** null while the tool is still running. */
      result: string | null;
      isError: boolean;
    };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  blocks: ChatBlock[];
}

export interface ChatResponse {
  /** ok: transcript found · empty: no conversation yet · unavailable: Claude's transcript can't be read. */
  state: 'ok' | 'empty' | 'unavailable';
  version: string;
  title: string | null;
  messages: ChatMessage[];
  /** Messages dropped from the start to keep the payload small. */
  truncated: number;
  note: string | null;
}

const MAX_TEXT = 4000;

export function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** One-line description of what a tool call acted on. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => i[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const value =
    pick('command') ??
    pick('file_path', 'notebook_path', 'path') ??
    pick('pattern', 'query') ??
    pick('url') ??
    pick('description', 'prompt', 'subject') ??
    Object.values(i).find((v) => typeof v === 'string');
  return (typeof value === 'string' ? value : name).replace(/\s+/g, ' ').trim().slice(0, 200);
}
