/**
 * /oauth/authorize: the FORGE connector's consent page (contract §1, §3, §9).
 * An agent's OAuth client opens it in the visitor's browser. In order:
 *
 * 1. Signed out: /signin first, back here with the whole query afterwards.
 *    The middleware does that; the check below is belt and braces.
 * 2. A practice session: a plain refusal. Nothing reaches the API.
 * 3. No OAuth parameters at all: nothing to approve. Someone opened the page
 *    directly, or a query too long for sign-in's `next` was dropped.
 * 4. The API checks the request, server-side. A refusal it can report to the
 *    client sends the browser back there; one it can't (an unknown client,
 *    a redirect URI that isn't the client's) is shown here and never
 *    redirects anywhere.
 * 5. The consent screen: who is asking, where it sends you back to, what it
 *    can and can't do, and Allow or Cancel, posted to ./decision. Only for
 *    scopes the screen describes (`forge.tasks`); anything else is refused.
 *
 * Never cached and never framed: next.config.mjs sets `Cache-Control:
 * no-store` and `X-Frame-Options: DENY` here, on top of the site-wide
 * `frame-ancestors 'none'`.
 */
import { safeNext } from '@forge/auth';
import type { AuthorizeCheck, AuthorizeParams } from '@forge/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSession } from '../../../lib/session';
import { checkAuthorization } from './consent-api';
import styles from './consent.module.css';
import { CAN, CANNOT, NOTICES } from './copy';
import type { NoticeKind } from './copy';
import {
  authorizeParamsFrom,
  CONSENT_PATH,
  consentPath,
  displayText,
  fromRecord,
  isLoopbackHost,
  oauthFields,
  scopesDescribed,
} from './oauth-request';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect an agent — FORGE',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Display limits for what the app declared about itself. */
const MAX_NAME_CHARS = 60;
const MAX_HOST_CHARS = 120;
const MAX_DETAIL_CHARS = 300;

function NoticePage({ kind, detail }: { kind: NoticeKind; detail?: string }) {
  const notice = NOTICES[kind];
  const shown = detail === undefined ? '' : displayText(detail, MAX_DETAIL_CHARS, '');
  return (
    <main className="page">
      <div className={styles.panel}>
        <h1 className="page-title">{notice.title}</h1>
        <div className="card stack">
          <p className="muted">{notice.message}</p>
          {shown !== '' ? <p className={`faint ${styles.detail}`}>What FORGE said: {shown}</p> : null}
        </div>
        <div className="row">
          <Link href="/connect" className="btn">
            How to connect an agent
          </Link>
          <Link href="/" className="btn btn-ghost">
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}

function ConsentScreen({ check, params, login }: { check: AuthorizeCheck; params: AuthorizeParams; login: string }) {
  const name = displayText(check.clientName, MAX_NAME_CHARS, 'An unnamed app');
  const host = displayText(check.redirectHost, MAX_HOST_CHARS, 'an unnamed address');

  return (
    <main className="page">
      <div className={styles.panel}>
        <div>
          <h1 className={`page-title ${styles.title}`} id="consent-title">
            Connect {name} to FORGE?
          </h1>
          <p className={styles.returnTo}>
            It will send you back to <strong className={styles.host}>{host}</strong>.
          </p>
          {isLoopbackHost(check.redirectHost) ? (
            <p className="muted">That address is this computer, so the app is one running here.</p>
          ) : null}
          <p className="faint" style={{ marginTop: 10 }}>
            “{name}” is the name the app gave itself. FORGE can’t check it, so make sure the address above is
            the one you expect.
          </p>
        </div>

        <section className="card stack" aria-labelledby="consent-can">
          <h2 className="section-title" id="consent-can">
            It will be able to
          </h2>
          <ul className={`${styles.list} ${styles.can}`}>
            {CAN.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h2 className="section-title" id="consent-cannot">
            It can’t
          </h2>
          <ul className={`${styles.list} ${styles.cannot}`}>
            {CANNOT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <form method="post" action={`${CONSENT_PATH}/decision`} className="stack" aria-labelledby="consent-title">
          {oauthFields(params).map(([field, value]) => (
            <input key={field} type="hidden" name={field} value={value} />
          ))}
          <p>
            Signed in as <strong>@{login}</strong>.
          </p>
          <div className={styles.actions}>
            <button type="submit" name="decision" value="allow" className="btn btn-primary btn-lg">
              Allow
            </button>
            <button type="submit" name="decision" value="deny" className="btn btn-lg">
              Cancel
            </button>
          </div>
          <p className="faint">
            Changed your mind later? You can disconnect it from{' '}
            <Link href="/me" className={styles.link}>
              your account
            </Link>
            .
          </p>
        </form>
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const mapped = authorizeParamsFrom(fromRecord(await searchParams));

  const session = await getSession();
  if (session === null) {
    const next = mapped.ok ? safeNext(consentPath(mapped.params), CONSENT_PATH) : CONSENT_PATH;
    redirect(`/signin?${new URLSearchParams({ next }).toString()}`);
  }
  // The practice account is nobody on GitHub, so there is nobody to connect.
  if (session.demo) return <NoticePage kind="practice" />;

  if (!mapped.ok) return <NoticePage kind={mapped.reason === 'empty' ? 'empty' : 'invalid'} />;

  const outcome = await checkAuthorization(mapped.params);
  switch (outcome.kind) {
    case 'consent':
      // The lists describe `forge.tasks` only: never ask consent for a scope they leave out.
      if (!scopesDescribed(outcome.check.scopes)) return <NoticePage kind="unavailable" />;
      return <ConsentScreen check={outcome.check} params={mapped.params} login={session.login} />;
    case 'redirect':
      // The API validated the client and its redirect URI, and `clientRedirect` checked the result again.
      return redirect(outcome.to);
    case 'invalid':
      return <NoticePage kind="invalid" detail={outcome.description} />;
    case 'off':
      return <NoticePage kind="off" />;
    case 'unavailable':
      return <NoticePage kind="unavailable" />;
  }
}
