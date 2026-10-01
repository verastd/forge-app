/**
 * The Allow/Cancel handler's error pages: one small, self-contained HTML
 * document, so a failure always lands the visitor on words and a way on, and
 * never on a redirect to an address the request supplied (contract §9).
 * Pure (string in, string out), so tests/e2e/connect.spec.ts checks the
 * escaping directly.
 */
import type { Notice } from '../copy';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `text` safe inside HTML text and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export interface PageLink {
  href: string;
  label: string;
}

/**
 * The page for `notice`, offering `primary` first when given, then how to
 * connect an agent and the way home. The colours are the site's own tokens,
 * written out, because this page loads nothing.
 */
export function errorPageHtml(notice: Notice, primary?: PageLink): string {
  const links: PageLink[] = [
    ...(primary === undefined ? [] : [primary]),
    { href: '/connect', label: 'How to connect an agent' },
    { href: '/', label: 'Go home' },
  ];
  const linkHtml = links
    .map(
      (link, index) =>
        `<a class="${index === 0 ? 'btn btn-primary' : 'btn'}" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
    )
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(notice.title)} — FORGE</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: #060a12; color: #eef2f9; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
      main { max-width: 560px; margin: 0 auto; padding: 40px 16px 64px; }
      .brand { margin: 0 0 24px; font-weight: 800; letter-spacing: 0.12em; color: #ffc23d; }
      h1 { margin: 0 0 12px; font-size: 1.5rem; line-height: 1.25; }
      p { margin: 0 0 24px; color: #a3b0c8; }
      .links { display: flex; flex-wrap: wrap; gap: 12px; }
      .btn { display: inline-block; padding: 10px 16px; border: 1px solid #2b3a5a; border-radius: 9px; background: #121b2e; color: #eef2f9; text-decoration: none; font-weight: 650; }
      .btn-primary { background: #ffc23d; border-color: #ffc23d; color: #1c1402; }
      a:focus-visible { outline: 2px solid #38d7ff; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <p class="brand">FORGE</p>
      <h1>${escapeHtml(notice.title)}</h1>
      <p>${escapeHtml(notice.message)}</p>
      <nav class="links" aria-label="Where to go next">
      ${linkHtml}
      </nav>
    </main>
  </body>
</html>
`;
}
