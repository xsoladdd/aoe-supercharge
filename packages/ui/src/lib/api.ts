export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

let csrf: string | null = null;

async function csrfToken(): Promise<string> {
  if (csrf) return csrf;
  const res = await fetch('/api/csrf', { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('Could not get a CSRF token', res.status, null);
  csrf = ((await res.json()) as { token: string }).token;
  return csrf;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await parse(res);
  if (!res.ok)
    throw new ApiError((body as { message?: string })?.message ?? res.statusText, res.status, body);
  return body as T;
}

/** Cookie-authenticated writes carry the CSRF token; the browser adds Origin itself. */
export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await parse(res);
  if (res.status === 403) csrf = null;
  if (!res.ok)
    throw new ApiError((parsed as { message?: string })?.message ?? res.statusText, res.status, parsed);
  return parsed as T;
}

/** Upload one file as raw bytes (the name goes in a header); same CSRF rules as other writes. */
export async function uploadFile(
  sessionId: string,
  blob: Blob,
  name: string,
): Promise<{ path: string; url: string; file: string }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
      'x-csrf-token': await csrfToken(),
    },
    body: blob,
  });
  const parsed = await parse(res);
  if (res.status === 403) csrf = null;
  if (!res.ok)
    throw new ApiError((parsed as { message?: string })?.message ?? res.statusText, res.status, parsed);
  return parsed as { path: string; url: string; file: string };
}
