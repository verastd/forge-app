/**
 * The /connect page's pure parts: where the connector is, the one-click
 * install links for VS Code and Cursor, and which of forge-app's own agent
 * config files already point at it. No I/O and no runtime imports, so
 * tests/e2e/connect.spec.ts runs these directly.
 *
 * Client formats, read live on 2026-10-01:
 * - VS Code: `vscode:mcp/install?` + encodeURIComponent(JSON of the server
 *   config plus its `name`), https://code.visualstudio.com/api/extension-guides/ai/mcp
 *   (and the handler, parseMcpInstallUriPayload in VS Code's
 *   src/vs/workbench/contrib/mcp/browser/mcpWorkbenchService.ts).
 * - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=`
 *   base64 of the server's own config, without a name wrapper,
 *   https://cursor.com/docs/context/mcp/install-links ; a remote server's
 *   config is `{ "url": … }`, https://cursor.com/docs/context/mcp
 * - Antigravity: remote servers take `serverUrl`, https://antigravity.google/docs/mcp
 */

/** The name every client knows the connector by; the repo's config files use it too. */
export const SERVER_NAME = 'forge';

/**
 * The repo-root `.mcp.json`, which Claude Code and VS Code 1.140+ read when
 * the fork is open. Not committed yet: it waits on the operator. Set this to
 * '.mcp.json' once it lands, and /connect says so for both clients.
 */
const ROOT_MCP_JSON: string | null = null;

/**
 * Where a fork of forge-app already sets the connector up, per client, or
 * null where it doesn't (yet). The one list to change when the repo's agent
 * config changes.
 */
export const IN_REPO_CONFIG: Readonly<Record<'claudeCode' | 'vscode' | 'codex' | 'cursor' | 'antigravity', string | null>> = {
  claudeCode: ROOT_MCP_JSON,
  vscode: ROOT_MCP_JSON,
  codex: '.codex/config.toml',
  cursor: '.cursor/mcp.json',
  antigravity: '.agents/mcp_config.json',
};

export interface ConnectorUrlInput {
  /** FORGE_PUBLIC_ORIGIN as `publicOrigin()` reads it: canonical, or null. */
  publicOrigin: string | null;
  /** Whether this is `next dev`, the only place the request's own origin may stand in. */
  development: boolean;
  /** The request's Host header. */
  host: string | null;
  /** The request's X-Forwarded-Proto header. */
  forwardedProto: string | null;
}

/** A host name or IPv4 address, or a bracketed IPv6 one, with an optional port. */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The connector URL people give their agent: `<FORGE_PUBLIC_ORIGIN>/mcp`, so
 * it survives an API move. Under `next dev` with no public origin set, the
 * request's own origin stands in; anywhere else that is null, and the page
 * says the connector is off rather than guess from a Host header.
 */
export function connectorUrl({ publicOrigin, development, host, forwardedProto }: ConnectorUrlInput): string | null {
  if (publicOrigin !== null) return `${publicOrigin}/mcp`;
  if (!development || host === null || !HOST.test(host)) return null;
  const scheme = forwardedProto === 'https' ? 'https' : 'http';
  return `${scheme}://${host}/mcp`;
}

/** VS Code's one-click install link for the connector at `url`. */
export function vscodeInstallLink(url: string): string {
  const server = { name: SERVER_NAME, type: 'http', url };
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(server))}`;
}

/** `text` as base64 of its UTF-8 bytes; `btoa` alone takes Latin-1 only. */
function base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Cursor's one-click install link for the connector at `url`. The base64 is
 * percent-encoded like any query value, so a `+` in it can never be read as
 * a space.
 */
export function cursorInstallLink(url: string): string {
  const query = new URLSearchParams({ name: SERVER_NAME, config: base64(JSON.stringify({ url })) });
  return `cursor://anysphere.cursor-deeplink/mcp/install?${query.toString()}`;
}

/** The entry to add under `mcpServers` in Antigravity's raw MCP config. */
export function antigravityEntry(url: string): string {
  return `${JSON.stringify(SERVER_NAME)}: { "serverUrl": ${JSON.stringify(url)} }`;
}
