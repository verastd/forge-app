/**
 * Which API base the server may send things to (FORGE_API_URL, or its
 * fallbacks): pasted agent keys, the Copilot token and the API assertions all
 * go there, so it must be https. Plain http is allowed only to this computer.
 *
 * Pure and dependency-free (the Edge middleware imports `./config`, which
 * imports this), so tests/e2e/hardening.spec.ts runs it directly.
 */

/** The only hosts plain `http:` may reach. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `raw` as a base to append API paths to (no trailing slash), or null unless
 * it is an absolute https URL, or http to localhost, 127.0.0.1 or ::1, with no
 * credentials, query or fragment.
 */
export function usableApiBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
