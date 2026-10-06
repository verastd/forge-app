/**
 * /connect: "Connect your agent to FORGE". The connector URL with the page's
 * one Copy button, then one short section per client with the exact action
 * its own docs give (read live 2026-10-01; sources in connector.ts and the W2
 * report). The guide is server-rendered and handed to `ConnectorGate`, which
 * shows it only while the `mcp_connector` flag is on.
 *
 * Section ids (`#claude`, `#claude-code`, `#codex`, `#vscode`, `#cursor`,
 * `#antigravity`, `#chatgpt`) are stable, so the docs and the Contribute
 * flow can link straight to one client.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { publicOrigin } from '../../lib/auth/config';
import { isDemoMode } from '../../lib/mode';
import styles from './connect.module.css';
import { ConnectorGate } from './ConnectorGate';
import {
  antigravityEntry,
  connectorUrl,
  cursorInstallLink,
  IN_REPO_CONFIG,
  SERVER_NAME,
  vscodeInstallLink,
} from './connector';
import { CopyUrl } from './CopyUrl';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect your agent — FORGE',
  description:
    'Set up the FORGE connector once, and your coding agent can see tasks, claim one, report progress and read check results by itself.',
};

/** Opens another site's page without telling it where the visitor came from. */
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={styles.link}>
      {children}
    </a>
  );
}

function Client({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <article id={id} className={`card stack ${styles.client}`} aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`}>{title}</h3>
        {subtitle !== undefined ? <p className="faint">{subtitle}</p> : null}
      </div>
      {children}
    </article>
  );
}

/** A command to type, shown whole: it wraps rather than scrolling the page sideways. */
function Command({ children }: { children: string }) {
  return (
    <pre className={styles.command}>
      <code>{children}</code>
    </pre>
  );
}

function InRepo({ file, children }: { file: string | null; children: (file: ReactNode) => ReactNode }) {
  if (file === null) return null;
  return <p className="faint">{children(<code>{file}</code>)}</p>;
}

function Guide({ url }: { url: string }) {
  return (
    <>
      <section className="card stack" aria-labelledby="connect-url-title">
        <h2 className="section-title" id="connect-url-title">
          Your connector URL
        </h2>
        <CopyUrl url={url} />
        <p className="muted">
          You add it to your agent once. The first time the agent uses it, FORGE asks you to sign in and shows
          what the agent can and can’t do before you choose Allow.
        </p>
        {isDemoMode() ? (
          <p className="faint">
            This is the practice app, so no agent can connect here: connecting needs a GitHub account.
          </p>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="connect-clients-title">
        <h2 className="section-title" id="connect-clients-title">
          Then add it to your agent
        </h2>
        <div className={styles.clients}>
          <Client id="claude" title="Claude" subtitle="claude.ai, the Claude desktop app and Claude Code on the web">
            <ol className="steps">
              <li>
                <span>
                  Open <External href="https://claude.ai/customize/connectors">Customize → Connectors</External>.
                </span>
              </li>
              <li>
                <span>
                  Press <strong>+</strong>, then <strong>Add custom connector</strong>.
                </span>
              </li>
              <li>
                <span>
                  Paste the connector URL and press <strong>Add</strong>.
                </span>
              </li>
              <li>
                <span>
                  Press <strong>Connect</strong>, then <strong>Allow</strong> on FORGE’s page.
                </span>
              </li>
            </ol>
            <p className="faint">On a Team or Enterprise plan, an owner adds it in Organization settings → Connectors.</p>
          </Client>

          <Client id="claude-code" title="Claude Code on your computer">
            <Command>{`claude mcp add --transport http ${SERVER_NAME} ${url}`}</Command>
            <p className="muted">
              Then type <code>/mcp</code> in Claude Code and follow the steps in your browser to sign in.
            </p>
            <InRepo file={IN_REPO_CONFIG.claudeCode}>
              {(file) => (
                <>
                  In your copy of FORGE’s code it’s already in {file}: approve it when Claude Code asks, then type{' '}
                  <code>/mcp</code>.
                </>
              )}
            </InRepo>
            <p className="faint">
              Added FORGE in Claude already? Claude Code picks it up when you’re signed in with the same Claude
              account.
            </p>
          </Client>

          <Client id="codex" title="Codex" subtitle="The Codex CLI, its IDE extension and the ChatGPT desktop app">
            <Command>{`codex mcp add ${SERVER_NAME} --url ${url}`}</Command>
            <Command>{`codex mcp login ${SERVER_NAME}`}</Command>
            <p className="muted">The first adds FORGE; the second signs you in, in your browser.</p>
            <InRepo file={IN_REPO_CONFIG.codex}>
              {(file) => (
                <>
                  In your copy of FORGE’s code it’s already in {file}, which Codex reads once you trust the project,
                  so only the second is needed there.
                </>
              )}
            </InRepo>
          </Client>

          <Client id="vscode" title="VS Code">
            <p>
              <a className="btn" href={vscodeInstallLink(url)}>
                Add FORGE to VS Code
              </a>
            </p>
            <p className="muted">Confirm the install in VS Code, then sign in to FORGE when it asks.</p>
            <InRepo file={IN_REPO_CONFIG.vscode}>
              {() => 'Already set up when you open your copy of FORGE’s code in VS Code 1.140 or newer; use this button for other folders.'}
            </InRepo>
          </Client>

          <Client id="cursor" title="Cursor">
            <p>
              <a className="btn" href={cursorInstallLink(url)}>
                Add FORGE to Cursor
              </a>
            </p>
            <p className="muted">Confirm the install in Cursor, then sign in to FORGE when it asks.</p>
            <InRepo file={IN_REPO_CONFIG.cursor}>{(file) => <>In your copy of FORGE’s code it’s already in {file}.</>}</InRepo>
          </Client>

          <Client id="antigravity" title="Google Antigravity">
            <InRepo file={IN_REPO_CONFIG.antigravity}>
              {(file) => <>In your copy of FORGE’s code it’s already in {file}.</>}
            </InRepo>
            <p className="muted">
              Anywhere else, open <strong>…</strong> → MCP Servers → Manage MCP Servers → View raw config in the
              Antigravity editor, and add this under <code>mcpServers</code>:
            </p>
            <Command>{antigravityEntry(url)}</Command>
            <p className="muted">
              To sign in, open Settings → Customizations and press <strong>Authenticate</strong> next to{' '}
              {SERVER_NAME}. When your browser shows a code at the end, copy it back into Customizations and press{' '}
              <strong>Submit</strong>.
            </p>
          </Client>

          <Client id="chatgpt" title="ChatGPT" subtitle="Developer mode">
            <ol className="steps">
              <li>
                <span>
                  Open Settings → Security and login and turn on <strong>Developer mode</strong>.
                </span>
              </li>
              <li>
                <span>
                  Go to <External href="https://chatgpt.com/plugins">chatgpt.com/plugins</External> and press{' '}
                  <strong>+</strong>.
                </span>
              </li>
              <li>
                <span>Name it FORGE, paste the connector URL under Connection, and create it.</span>
              </li>
              <li>
                <span>Sign in to FORGE when ChatGPT asks.</span>
              </li>
            </ol>
            <p className="faint">Whether you have developer mode depends on your plan, and at work on your workspace.</p>
          </Client>
        </div>
      </section>

      <p className="muted">
        Jules, GitHub Copilot and the other agents FORGE starts for you with <strong>Start it for me</strong> don’t
        need the connector: FORGE hands them the task itself.
      </p>
    </>
  );
}

export default async function ConnectPage() {
  const request = await headers();
  const url = connectorUrl({
    publicOrigin: publicOrigin(),
    development: process.env.NODE_ENV === 'development',
    host: request.get('host'),
    forwardedProto: request.get('x-forwarded-proto'),
  });

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Connect your agent to FORGE</h1>
        <p className="lede">
          The FORGE connector lets your coding agent see tasks, claim one, report its progress and read its check
          results by itself, so you never paste anything.
        </p>
      </div>
      <ConnectorGate available={url !== null}>{url !== null ? <Guide url={url} /> : null}</ConnectorGate>
    </main>
  );
}
