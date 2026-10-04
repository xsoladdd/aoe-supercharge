import { useSearch } from 'wouter';

/** Every session's chat lives at `/chat/<id>`; `?view=terminal` shows its raw terminal. */
export function chatHref(id: string, view?: 'terminal'): string {
  return `/chat/${encodeURIComponent(id)}${view ? `?view=${view}` : ''}`;
}

/** Kept as a hook so call sites read the same as before the chat page existed. */
export function useSessionHref(): (id: string) => string {
  return chatHref;
}

export function useSearchParam(name: string): string | null {
  return new URLSearchParams(useSearch()).get(name);
}
