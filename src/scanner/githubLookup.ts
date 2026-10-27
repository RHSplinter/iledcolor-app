const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';

export interface GithubHandles {
  /** Static handle printed on the paper badge as a bare "@handle" line. */
  printed?: string;
  /** Handle the attendee configured on the badge screen's contacts panel ("GitHub: handle" or github.com/handle). */
  configured?: string;
}

export function findGithubHandles(text: string): GithubHandles {
  const result: GithubHandles = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const printed = new RegExp(`^@(${LOGIN})$`).exec(trimmed)?.[1];
    if (printed) { result.printed ??= printed; continue; }
    const configured = new RegExp(`^git\\s?hub\\s*[:\\-–|]?\\s*@?(${LOGIN})$`, 'i').exec(trimmed)?.[1]
      ?? new RegExp(`github\\.com/(${LOGIN})(?![\\w-])`, 'i').exec(trimmed)?.[1];
    if (configured) result.configured ??= configured;
  }
  return result;
}

/** The handle to look up first: the printed one, else the configured one. */
export function findGithubHandle(text: string): string | undefined {
  const { printed, configured } = findGithubHandles(text);
  return printed ?? configured;
}

/** Both handles when the badge shows two that differ (case-insensitively). */
export function differingGithubHandles(text: string): { printed: string; configured: string } | undefined {
  const { printed, configured } = findGithubHandles(text);
  return printed && configured && printed.toLowerCase() !== configured.toLowerCase() ? { printed, configured } : undefined;
}

export function findLinkedinHandle(text: string): string | undefined {
  const url = /linkedin\.com\/(?:in|pub)\/([\w%-]{3,100})/i.exec(text);
  if (url) return url[1];
  for (const line of text.split(/\r?\n/)) {
    const match = /^linked\s?in\s*[:\-–|]?\s*(?:\/?in\/)?@?([\w%-]{3,100})\/?$/i.exec(line.trim())
      ?? /^\/?in\/([\w%-]{3,100})\/?$/i.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

export interface GithubPublicProfile { login: string; email: string | null }

/** Sends only the handle to api.github.com. `email` is null unless the user made it public. */
export async function fetchPublicProfile(handle: string, signal?: AbortSignal): Promise<GithubPublicProfile | null> {
  if (!new RegExp(`^${LOGIN}$`).test(handle)) throw new Error('Invalid GitHub handle.');
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(handle)}`, {
    headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub rate limit reached. Try again later.' : `GitHub returned ${response.status}.`);
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) throw new Error('Unexpected GitHub response.');
  const { login, email } = data as Record<string, unknown>;
  return {
    login: typeof login === 'string' ? login : handle,
    email: typeof email === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(email) ? email : null,
  };
}
