/** Lowercase ASCII slug: `[a-z0-9-]`, no leading/trailing dashes. Safe on AoE's shell launch line. */
export function slugify(input: string, maxLength = 48): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export function isSlug(input: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input);
}

/** "northwind-web" → "NW"; "apollo" → "AP". */
export function derivePrefix(project: string): string {
  const parts = project.split('-').filter(Boolean);
  const raw = parts.length > 1 ? parts.map((p) => p[0]).join('') : project.slice(0, 2);
  return raw.toUpperCase().slice(0, 4) || 'T';
}

export function formatTaskId(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

/** Compact relative time ("now", "4m", "2h", "3d"), no dashes or dots. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "just now" | "4m ago" | "2h ago": relativeTime as a phrase. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  const r = relativeTime(iso, now);
  if (r === 'now') return 'just now';
  if (r === 'never' || r === 'unknown') return r;
  return `${r} ago`;
}
