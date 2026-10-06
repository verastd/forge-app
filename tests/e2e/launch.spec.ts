import { expect, test } from '@playwright/test';

import { COPY_STEP, OPEN_RAILS, RAIL_REGISTRY, railMeta } from '../../packages/shared/dist/index.js';
import {
  CONNECT_PATH,
  COPY_STEP_ANCHOR,
  SESSION_HOSTS,
  canRelayNotes,
  credentialFields,
  describeClaimError,
  describeRelayError,
  describeStartError,
  describeTaskError,
  githubAppInstallUrl,
  githubAppSlug,
  keyName,
  lastStartRail,
  notRelayedSentence,
  plainText,
  readStartOutcome,
  relayedSince,
  safeHttpsUrl,
  sessionLink,
  setupStepLink,
  setupSteps,
  showsCompareLink,
  startedSentence,
  startedSince,
} from '../../apps/web/src/lib/handoff';
import {
  CLAUDE_CLI_PROMPT_CAP,
  CLAUDE_CODE_URL_CAP,
  CURSOR_URL_CAP,
  launchFor,
  launchLinks,
  startTaskAsk,
} from '../../apps/web/src/lib/launch';
import type { LaunchInput } from '../../apps/web/src/lib/launch';
import golden from '../fixtures/brief-golden.json';

/**
 * Unit tests, no browser: the "Open my agent" links (`lib/launch.ts`) and the
 * hand-off's plain-language helpers (`lib/handoff.ts`). The web app has no
 * unit-test runner of its own, so these run in the Playwright suite like the
 * fixture-parity check in contribute.spec.ts. The briefs come from
 * tests/fixtures/brief-golden.json, the same text both the API and
 * `compileBrief` are held to.
 */

const API = 'https://api.forge.test';

function goldenCase(name: string): { brief: string; login: string | null } {
  const found = golden.cases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`brief-golden.json has no case named ${name}`);
  }
  return { brief: found.brief, login: found.login };
}

const WITH_LOGIN = goldenCase('with login');
const WITHOUT_LOGIN = goldenCase('without login');
const LOGIN = 'octo-contributor';

const input = (overrides: Partial<LaunchInput> = {}): LaunchInput => ({
  taskId: 1,
  brief: WITH_LOGIN.brief,
  login: LOGIN,
  apiBase: API,
  ...overrides,
});

/** The decoded query of a launch link, whatever its scheme. */
function query(href: string | null): URLSearchParams {
  if (href === null) {
    throw new Error('expected a link');
  }
  return new URL(href).searchParams;
}

/** A brief of `length` plain letters: one character each in a URL. */
const letters = (length: number): string => 'a'.repeat(length);

test.describe('the "Open my agent" links (lib/launch.ts)', () => {
  test('one launch per open rail, in display order', () => {
    expect(launchLinks(input()).map((launch) => launch.rail)).toEqual([...OPEN_RAILS]);
  });

  test('Claude Code on the web: the whole brief as prompt, and the fork preselected', () => {
    const launch = launchFor('claude-code', input());
    expect(launch.href).toBe(
      `https://claude.ai/code?prompt=${encodeURIComponent(WITH_LOGIN.brief)}&repositories=${LOGIN}/forge-app`,
    );
    expect(query(launch.href).get('prompt')).toBe(WITH_LOGIN.brief);
    expect(query(launch.href).get('repositories')).toBe(`${LOGIN}/forge-app`);
    expect(launch).toMatchObject({ kind: 'web', shortened: false });
    expect(launch.note).toBeUndefined();
  });

  test('Claude Code on your computer: repo, then q', () => {
    const launch = launchFor('claude-cli', input());
    expect(launch.href).toBe(`claude-cli://open?repo=${LOGIN}/forge-app&q=${encodeURIComponent(WITH_LOGIN.brief)}`);
    expect(query(launch.href).get('q')).toBe(WITH_LOGIN.brief);
    expect(launch).toMatchObject({ kind: 'app', shortened: false });
  });

  test('Codex app: the prompt and the fork as the git remote to match', () => {
    const launch = launchFor('codex', input());
    expect(launch.href?.startsWith('codex://new?prompt=')).toBe(true);
    expect(query(launch.href).get('prompt')).toBe(WITH_LOGIN.brief);
    expect(query(launch.href).get('originUrl')).toBe(`https://github.com/${LOGIN}/forge-app.git`);
    expect(launch.kind).toBe('app');
  });

  test('VS Code agents and the Cursor app: the prompt only', () => {
    const vscode = launchFor('vscode', input());
    expect(vscode.href).toBe(`vscode://agents/new?prompt=${encodeURIComponent(WITH_LOGIN.brief)}`);
    expect(query(vscode.href).get('prompt')).toBe(WITH_LOGIN.brief);

    const cursor = launchFor('cursor-app', input());
    expect(cursor.href).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(WITH_LOGIN.brief)}`);
    expect(query(cursor.href).get('text')).toBe(WITH_LOGIN.brief);
    expect([vscode.kind, cursor.kind]).toEqual(['app', 'app']);
  });

  test('Google Antigravity has no link, only steps that end with the ask', () => {
    const launch = launchFor('antigravity', input({ taskId: 7 }));
    expect(launch.href).toBeNull();
    expect(launch.kind).toBe('steps');
    // An older copy lacks the connector settings, and the connector wants a sign-in first (WEB-M6).
    expect(launch.steps).toEqual([
      "If your copy is older than October 2026, bring it up to date on GitHub first so it has FORGE's connector settings.",
      'Open your copy in Antigravity. The FORGE connector is already set up in it.',
      'The first time, sign in to FORGE: in Settings → Customizations, press Authenticate next to forge, then paste the code your browser shows and press Submit.',
      'Ask it: Start FORGE task #7',
    ]);
    expect(startTaskAsk(7)).toBe('Start FORGE task #7');
    // Where the task page sets up and refreshes the copy, the steps point there, and name the copy once known.
    expect(launchFor('antigravity', input({ taskId: 7, copyStep: 'get-started' })).steps?.slice(0, 2)).toEqual([
      "Press Get started on this page first, so your copy has FORGE's connector settings.",
      'Open your copy in Antigravity. The FORGE connector is already set up in it.',
    ]);
    expect(
      launchFor('antigravity', input({ taskId: 7, copyStep: 'refresh', copy: 'octo-contributor/forge-app-1' })).steps?.slice(0, 2),
    ).toEqual([
      "If your copy is older than October 2026, press Refresh your copy on this page first so it has FORGE's connector settings.",
      'Open your copy, octo-contributor/forge-app-1, in Antigravity. The FORGE connector is already set up in it.',
    ]);
    for (const copyStep of ['none', 'get-started', 'refresh'] as const) {
      expect(launchFor('antigravity', input({ copyStep, copy: 'octo-contributor/forge-app' })).steps?.join(' '), copyStep).not.toMatch(
        /fork/i,
      );
    }
  });

  test('every link round-trips a brief full of URL-special characters', () => {
    const brief = 'FORGE task #9: a & b = c? 100% "quoted" + plus\nline two\ttab, café, 🚀, <tag>, #hash, /slash';
    for (const launch of launchLinks(input({ brief }))) {
      if (launch.href === null) {
        continue;
      }
      expect(launch.href).not.toMatch(/[\s"<>]/);
      const params = query(launch.href);
      const text = params.get('prompt') ?? params.get('q') ?? params.get('text');
      expect(text, launch.rail).toBe(brief);
    }
  });

  test('a lone surrogate cannot break a link: it becomes U+FFFD', () => {
    const brief = `broken \uD800 text`;
    const launch = launchFor('vscode', input({ brief }));
    expect(query(launch.href).get('prompt')).toBe('broken \uFFFD text');
  });

  test('no login: no fork anywhere, and prompt_url names no login', () => {
    const plain = input({ brief: WITHOUT_LOGIN.brief, login: null });
    expect(query(launchFor('claude-code', plain).href).has('repositories')).toBe(false);
    expect(query(launchFor('claude-code', plain).href).get('prompt')).toBe(WITHOUT_LOGIN.brief);
    expect(launchFor('claude-cli', plain).href).toBe(`claude-cli://open?q=${encodeURIComponent(WITHOUT_LOGIN.brief)}`);
    expect(query(launchFor('codex', plain).href).has('originUrl')).toBe(false);

    const long = launchFor('claude-code', { ...plain, brief: letters(CLAUDE_CODE_URL_CAP) });
    expect(query(long.href).get('prompt_url')).toBe(`${API}/api/bridge/tasks/1/brief`);
  });

  for (const bad of ['octo\n', '-octo', 'a'.repeat(40), 'octo/../evil', 'oc to', '', 'octo?x=1']) {
    test(`an invalid login (${JSON.stringify(bad)}) is no login at all`, () => {
      expect(launchLinks(input({ login: bad }))).toEqual(launchLinks(input({ login: null })));
    });
  }

  test('Claude Code: up to 7,000 characters the brief rides in the URL, past that prompt_url', () => {
    const fixed = `https://claude.ai/code?prompt=&repositories=${LOGIN}/forge-app`.length;
    const fits = launchFor('claude-code', input({ brief: letters(CLAUDE_CODE_URL_CAP - fixed) }));
    expect(fits.href?.length).toBe(CLAUDE_CODE_URL_CAP);
    expect(query(fits.href).has('prompt')).toBe(true);
    expect(fits.shortened).toBe(false);

    const over = launchFor('claude-code', input({ brief: letters(CLAUDE_CODE_URL_CAP - fixed + 1) }));
    expect(query(over.href).has('prompt')).toBe(false);
    expect(query(over.href).get('prompt_url')).toBe(`${API}/api/bridge/tasks/1/brief?login=${LOGIN}`);
    expect(query(over.href).get('repositories')).toBe(`${LOGIN}/forge-app`);
    expect(over.shortened).toBe(true);
  });

  test('Claude Code: prompt_url drops a trailing slash on the API origin', () => {
    const over = launchFor('claude-code', input({ brief: letters(CLAUDE_CODE_URL_CAP), apiBase: `${API}//` }));
    expect(query(over.href).get('prompt_url')).toBe(`${API}/api/bridge/tasks/1/brief?login=${LOGIN}`);
  });

  test('Claude Code: with no public API to fetch from, a long brief becomes the short ask', () => {
    for (const apiBase of ['', '/api', 'ftp://api.forge.test']) {
      const over = launchFor('claude-code', input({ brief: letters(CLAUDE_CODE_URL_CAP), apiBase }));
      expect(query(over.href).get('prompt')).toBe('Start FORGE task #1');
      expect(query(over.href).has('prompt_url')).toBe(false);
      expect(over.note).toContain('FORGE connector');
    }
  });

  test('Claude Code on your computer: q holds up to 5,000 characters, past that it is left out', () => {
    const fits = launchFor('claude-cli', input({ brief: letters(CLAUDE_CLI_PROMPT_CAP) }));
    expect(query(fits.href).get('q')).toHaveLength(CLAUDE_CLI_PROMPT_CAP);
    expect(fits.note).toBeUndefined();

    const over = launchFor('claude-cli', input({ taskId: 12, brief: letters(CLAUDE_CLI_PROMPT_CAP + 1) }));
    expect(over.href).toBe(`claude-cli://open?repo=${LOGIN}/forge-app`);
    expect(over.shortened).toBe(true);
    expect(over.note).toBe('This task is too long for a link. Once Claude Code opens, ask it: Start FORGE task #12');

    const bare = launchFor('claude-cli', input({ login: null, brief: letters(CLAUDE_CLI_PROMPT_CAP + 1) }));
    expect(bare.href).toBe('claude-cli://open');
  });

  test('Cursor: the whole link holds up to 10,000 characters, past that the short ask', () => {
    const fixed = 'cursor://anysphere.cursor-deeplink/prompt?text='.length;
    const fits = launchFor('cursor-app', input({ brief: letters(CURSOR_URL_CAP - fixed) }));
    expect(fits.href?.length).toBe(CURSOR_URL_CAP);
    expect(fits.shortened).toBe(false);

    const over = launchFor('cursor-app', input({ brief: letters(CURSOR_URL_CAP - fixed + 1) }));
    expect(query(over.href).get('text')).toBe('Start FORGE task #1');
    expect(over.shortened).toBe(true);
    expect(over.note).toContain('FORGE connector');
  });
});

test.describe('the hand-off helpers (lib/handoff.ts)', () => {
  const jules = railMeta('jules');
  const devin = railMeta('devin');
  const routine = railMeta('claude-routine');
  const copilot = railMeta('copilot');

  test('every start error has its own plain sentence', () => {
    const cases: Array<[Parameters<typeof describeStartError>[0], string]> = [
      [{ code: 'credential_rejected' }, "Google didn't accept that key. Check it and try again."],
      [
        { code: 'credential_rejected', usedSavedKey: true },
        "Google didn't accept your saved key, so FORGE removed it. Add it again and try once more.",
      ],
      [{ code: 'credential_required' }, 'Google Jules needs your Jules API key. Add it and try again.'],
      [
        { code: 'credential_invalid' },
        "That doesn't look like your Jules API key. Check you copied all of it and try again.",
      ],
      [
        { code: 'credential_invalid', fields: ['key'] },
        "That doesn't look like your Jules API key. Check you copied all of it and try again.",
      ],
      [
        { code: 'invalid_request', fields: ['credential.key'] },
        "That doesn't look like your Jules API key. Check you copied all of it and try again.",
      ],
      [
        { code: 'invalid_request', fields: ['taskId'] },
        "FORGE couldn't read that request, so nothing was started. Reload the page and try again.",
      ],
      [{ code: 'body_too_large' }, "That's too long to send. Check what you pasted."],
      [{ code: 'github_unavailable' }, "GitHub isn't answering FORGE just now, so nothing changed. Try again in a minute."],
      [{ code: 'rail_setup_needed', detail: 'Connect your copy in Jules first.' }, 'Connect your copy in Jules first.'],
      [
        { code: 'rail_setup_needed' },
        "Google Jules isn't connected to your copy yet. Finish the setup steps above, then try again.",
      ],
      [{ code: 'rail_failed', upstreamStatus: 503 }, "Google didn't answer properly (error 503). Try again in a minute."],
      [{ code: 'rail_failed' }, "Google didn't answer properly. Try again in a minute."],
      [{ code: 'rail_disabled' }, 'FORGE can\'t start Google Jules right now. Use "Open my agent" below instead.'],
      [{ code: 'dispatch_limit' }, "You've started agents too many times in the last hour. Wait a little, then try again."],
      [
        { code: 'dispatch_limit', limit: 10, retryAfterSeconds: 600 },
        "You've started agents 10 times in the last hour, the most FORGE allows. Try again in about 10 minutes.",
      ],
      [
        { code: 'dispatch_limit', limit: 10, retryAfterSeconds: 30 },
        "You've started agents 10 times in the last hour, the most FORGE allows. Try again in about 1 minute.",
      ],
      [
        { code: 'dispatch_limit', limit: 10 },
        "You've started agents 10 times in the last hour, the most FORGE allows. Wait a little, then try again.",
      ],
      [{ code: 'not_holder' }, "This task isn't yours any more, so nothing changed. Claim it again first."],
      [{ code: 'not_claimed' }, "This task isn't yours any more, so nothing changed. Claim it again first."],
      [
        { code: 'already_shipped' },
        'This task is already shipped: its pull request was merged, so there is nothing left to do on it.',
      ],
      [{ code: 'unauthenticated' }, 'Your sign-in has ended. Sign in again, then try once more.'],
      [{ code: 'practice_session' }, "Practice accounts can't do that. Sign in with GitHub to do it for real."],
      [{ code: 'service_unreachable' }, "FORGE couldn't reach its service just now, so nothing changed. Try again in a minute."],
      [{ code: 'something_new' }, "That didn't work, and nothing was started. Please try again."],
    ];
    for (const [failure, sentence] of cases) {
      expect(describeStartError(failure, jules), failure.code).toBe(sentence);
    }
  });

  test('the credential sentences name what each rail needs, and the field the API found wrong', () => {
    expect(describeStartError({ code: 'credential_required' }, devin)).toBe(
      'Devin needs your Devin API key and organization ID. Add it and try again.',
    );
    expect(describeStartError({ code: 'credential_invalid' }, routine)).toContain("your routine's URL and token");
    expect(describeStartError({ code: 'credential_invalid', fields: ['orgId'] }, devin)).toBe(
      "That doesn't look like your Devin organization ID. Check you copied all of it and try again.",
    );
    expect(describeStartError({ code: 'credential_invalid', fields: ['credential.key'] }, routine)).toContain(
      "your routine's token",
    );
    expect(describeStartError({ code: 'credential_invalid', fields: ['routineUrl'] }, routine)).toContain(
      "your routine's URL.",
    );
    // Copilot has no key: a refusal is about GitHub's one-time approval.
    expect(describeStartError({ code: 'credential_rejected' }, copilot)).toBe(
      "GitHub didn't accept FORGE's one-time approval for GitHub Copilot. Start it again to approve it afresh.",
    );
  });

  test('keys are named after the product people know them by', () => {
    expect(keyName(jules)).toBe('Jules');
    expect(keyName(railMeta('cursor'))).toBe('Cursor');
    expect(keyName(devin)).toBe('Devin');
    expect(keyName(railMeta('openhands'))).toBe('OpenHands');
    expect(keyName(copilot)).toBe('GitHub');
  });

  test('the notes go only to agents whose vendors take follow-ups', () => {
    expect(['jules', 'cursor', 'devin'].every(canRelayNotes)).toBe(true);
    expect(['copilot', 'openhands', 'claude-routine', 'claude-code', 'antigravity'].some(canRelayNotes)).toBe(false);
  });

  test('the Copilot callback codes read as sentences too', () => {
    expect(describeStartError({ code: 'github_denied' }, copilot)).toBe(
      "You didn't approve GitHub Copilot on GitHub, so nothing was started.",
    );
    for (const code of ['github_failed', 'github_not_configured', 'wrong_account', 'signed_out']) {
      const sentence = describeStartError({ code }, copilot);
      expect(sentence).not.toBe("That didn't work, and nothing was started. Please try again.");
      expect(sentence).toMatch(/\.$/);
    }
  });

  test("the API's own setup sentence is shown as plain, short text", () => {
    const plain = 'Install the Jules GitHub app on your copy, then try again.';
    expect(describeStartError({ code: 'rail_setup_needed', detail: plain }, jules)).toBe(plain);
    const sentence = describeStartError({ code: 'rail_setup_needed', detail: `Install\u202Ethe app\u0007 ${'x'.repeat(700)}` }, jules);
    expect(sentence).not.toMatch(/[\u0000-\u001F\u202E]/);
    expect(sentence.length).toBeLessThanOrEqual(600);
    expect(sentence.endsWith('…')).toBe(true);
  });

  test('claim and task errors', () => {
    expect(describeClaimError('already_claimed')).toBe('Someone claimed this one first. Have a look at the others.');
    expect(describeClaimError('claim_limit')).toContain('Finish or release one');
    expect(describeClaimError('internal_error')).toContain('nothing was changed');
    expect(describeTaskError('invalid_pr_url')).toBe("That isn't a link to a pull request on verastd/forge-app.");
    expect(describeTaskError('pr_not_found')).toBe('GitHub has no pull request at that link.');
    expect(describeTaskError('not_your_pr')).toBe("That pull request comes from someone else's copy, not yours.");
    expect(describeTaskError('internal_error')).toBe("That didn't work, so nothing changed. Please try again.");
    expect(startedSentence('Google Jules')).toBe('Google Jules is working on it.');
  });

  test('the outcome in the query string is read, never shown', () => {
    expect(readStartOutcome({ started: 'copilot' })).toEqual({ kind: 'started', rail: 'copilot' });
    // Only Copilot comes back through a redirect.
    expect(readStartOutcome({ started: 'jules' })).toBeNull();
    expect(readStartOutcome({ startError: 'credential_rejected' })).toEqual({
      kind: 'error',
      rail: 'copilot',
      failure: { code: 'credential_rejected' },
    });
    expect(readStartOutcome({ startError: 'rail_failed', status: '502' })).toMatchObject({
      failure: { code: 'rail_failed', upstreamStatus: 502 },
    });
    expect(readStartOutcome({ startError: 'rail_failed', status: '5022' })).toMatchObject({
      failure: { code: 'rail_failed' },
    });
    expect(readStartOutcome({ startError: 'credential_rejected', status: '502' })).toEqual({
      kind: 'error',
      rail: 'copilot',
      failure: { code: 'credential_rejected' },
    });
    expect(readStartOutcome({ startError: '<script>alert(1)</script>' })).toMatchObject({ failure: { code: 'unknown' } });
    expect(readStartOutcome({ startError: 'github_not_configured' })).toMatchObject({
      failure: { code: 'github_not_configured' },
    });
    expect(readStartOutcome({})).toBeNull();
    expect(readStartOutcome({ startError: '' })).toBeNull();
  });

  test('plainText strips control and bidirectional characters, collapses space and caps length', () => {
    expect(plainText('  done\n\npushed\u0000 the\u202E fix\u2028now  ')).toBe('done pushed the fix now');
    expect(plainText('abcdefghij', 5)).toBe('abcd…');
    expect(plainText('abcde', 5)).toBe('abcde');
  });

  test('safeHttpsUrl lets through https links only, optionally on given hosts', () => {
    expect(safeHttpsUrl('https://jules.google.com/session/1')).toBe('https://jules.google.com/session/1');
    expect(safeHttpsUrl('http://jules.google.com/session/1')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('https://user:pass@github.com/x')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl('https://github.com/verastd/forge-app/pull/3', ['github.com'])).toBe(
      'https://github.com/verastd/forge-app/pull/3',
    );
    expect(safeHttpsUrl('https://github.com.evil.example/x', ['github.com'])).toBeNull();
  });

  test('setup steps link where there is somewhere to go', () => {
    // The copy step points at step 1 on the same page, where Get started is; GitHub's own page never comes into it.
    expect(setupStepLink(jules, COPY_STEP, null)).toEqual({ href: COPY_STEP_ANCHOR, external: false });
    expect(COPY_STEP_ANCHOR).toBe('#copy-title');
    expect(setupStepLink(jules, 'Fork forge-app on GitHub.', null)).toBeNull();
    for (const meta of RAIL_REGISTRY) {
      expect(meta.setup[0], meta.id).toBe(COPY_STEP);
    }
    expect(setupStepLink(copilot, "Install FORGE's GitHub app on your copy.", 'forge-foreman')).toEqual({
      href: 'https://github.com/apps/forge-foreman/installations/new',
      external: true,
    });
    // No slug configured: the step stays words, never a link that leads nowhere.
    expect(setupStepLink(copilot, "Install FORGE's GitHub app on your copy.", null)).toBeNull();
    expect(setupStepLink(railMeta('claude-code'), 'Connect your agent to FORGE once so it can report progress.', null)).toEqual({
      href: CONNECT_PATH,
      external: false,
    });
    expect(setupStepLink(jules, 'Create an API key in Jules settings.', null)).toEqual({
      href: 'https://jules.google.com/settings',
      external: true,
    });
    expect(setupStepLink(jules, 'Sign in at jules.google.com and connect your copy.', null)).toBeNull();
    // Every start rail's key step finds its key page.
    for (const meta of RAIL_REGISTRY.filter((rail) => rail.keyUrl !== undefined)) {
      expect(meta.setup.some((step) => setupStepLink(meta, step, null)?.href === meta.keyUrl), meta.id).toBe(true);
    }
  });

  test('the routine step only promises to keep the URL and token while FORGE can save keys', () => {
    expect(setupSteps(routine, true)).toEqual(routine.setup);
    expect(setupSteps(routine, false)).toContain('Paste its URL and token here each time you start it.');
    expect(setupSteps(routine, false)).not.toContain('Paste its URL and token here once.');
    expect(setupSteps(jules, false)).toEqual(jules.setup);
  });

  test('GITHUB_APP_SLUG is used only when it looks like a slug', () => {
    expect(githubAppSlug('forge-foreman')).toBe('forge-foreman');
    for (const bad of ['Forge', 'a/b', '-x', 'x-', '', 'a b', undefined, null, 7]) {
      expect(githubAppSlug(bad), String(bad)).toBeNull();
    }
    expect(githubAppInstallUrl(null)).toBeNull();
  });

  test('each credential kind asks for what its vendor needs', () => {
    expect(credentialFields('api_key', 'Jules')).toEqual([{ name: 'key', label: 'Your Jules API key', maxLength: 4096 }]);
    expect(credentialFields('devin', 'Cognition').map((field) => field.name)).toEqual(['key', 'orgId']);
    expect(credentialFields('routine', 'Anthropic').map((field) => field.name)).toEqual(['routineUrl', 'key']);
    expect(credentialFields('github', 'GitHub')).toEqual([]);
    expect(credentialFields(undefined, 'GitHub')).toEqual([]);
  });
});

/**
 * The Phase 4 review's fixes in `lib/handoff.ts` (unit F3c). Each test names
 * the finding it holds closed.
 */
test.describe('the hand-off helpers after the Phase 4 review', () => {
  const jules = railMeta('jules');
  const cursor = railMeta('cursor');
  const devin = railMeta('devin');

  /** What the API sent back from a vendor in review-creds CR-2 (a backslash past httpx's host check). */
  const BACKSLASHED = [
    'https://evil.example\\@jules.google.com/session/1',
    'https://evil.example\\.cursor.com/agents/bc-1',
    'https://evil.example\\@github.com/o/forge-app/agents/1',
  ];

  test('safeHttpsUrl refuses backslashes, whitespace and controls, and checks the host the browser would visit (CR-2)', () => {
    for (const value of [
      ...BACKSLASHED,
      'https://jules.google.com/session 1',
      'https://jules.google.com/\tsession/1',
      'https://jules.google.com/session/1\n',
      'https://jules.google.com/session/\u00001',
      'https://jules.google.com/ x',
    ]) {
      expect(safeHttpsUrl(value), JSON.stringify(value)).toBeNull();
      expect(safeHttpsUrl(value, ['jules.google.com', 'cursor.com', 'github.com']), JSON.stringify(value)).toBeNull();
    }
    // The allowlist takes a host or any host under it, as the API's `https_url` does.
    expect(safeHttpsUrl('https://app.devin.ai/sessions/1', ['devin.ai'])).toBe('https://app.devin.ai/sessions/1');
    expect(safeHttpsUrl('https://devin.ai/sessions/1', ['devin.ai'])).toBe('https://devin.ai/sessions/1');
    expect(safeHttpsUrl('https://notdevin.ai/sessions/1', ['devin.ai'])).toBeNull();
    expect(safeHttpsUrl('https://devin.ai.evil.example/x', ['devin.ai'])).toBeNull();
    // A percent-escaped backslash never makes a host the browser accepts.
    expect(safeHttpsUrl('https://evil.example%5c.jules.google.com/x', ['jules.google.com'])).toBeNull();
  });

  test('"Watch it work" only ever opens the vendor of the rail that started (CR-2)', () => {
    expect(sessionLink('https://jules.google.com/session/42', 'jules')).toBe('https://jules.google.com/session/42');
    expect(sessionLink('https://cursor.com/agents/bc-1', 'cursor')).toBe('https://cursor.com/agents/bc-1');
    expect(sessionLink('https://app.devin.ai/sessions/7', 'devin')).toBe('https://app.devin.ai/sessions/7');
    expect(sessionLink('https://github.com/o/forge-app/agents/1', 'copilot')).toBe('https://github.com/o/forge-app/agents/1');
    // Another vendor's host is not this rail's session.
    expect(sessionLink('https://cursor.com/agents/bc-1', 'jules')).toBeNull();
    expect(sessionLink('https://evil.example/session/42', 'jules')).toBeNull();
    for (const value of BACKSLASHED) {
      for (const rail of ['jules', 'cursor', 'copilot'] as const) {
        expect(sessionLink(value, rail), `${rail} ${value}`).toBeNull();
      }
      expect(sessionLink(value, null)).toBeNull();
    }
    // With no start rail to go by, any start rail's vendor will do, and nothing else.
    expect(sessionLink('https://jules.google.com/session/42', 'claude-code')).toBe('https://jules.google.com/session/42');
    expect(sessionLink('https://evil.example/x', undefined)).toBeNull();
    expect(Object.keys(SESSION_HOSTS).sort()).toEqual(
      RAIL_REGISTRY.filter((rail) => rail.mode === 'start').map((rail) => rail.id).sort(),
    );
  });

  test("a key step links only to the vendor's own key page, whatever the API says (WEB-L6)", () => {
    const step = 'Create an API key in Jules settings.';
    expect(setupStepLink({ id: 'jules', keyUrl: 'https://jules.google.com/settings' }, step, null)).toEqual({
      href: 'https://jules.google.com/settings',
      external: true,
    });
    for (const keyUrl of [
      'javascript:alert(document.domain)',
      'data:text/html,<b>key</b>',
      'http://jules.google.com/settings',
      'https://jules.google.com.evil.example/settings',
      'https://evil.example/jules.google.com/settings',
      'https://evil.example\\@jules.google.com/settings',
      'https://user@jules.google.com/settings',
      // Another rail's key page is not this rail's.
      'https://cursor.com/dashboard',
    ]) {
      expect(setupStepLink({ id: 'jules', keyUrl }, step, null), keyUrl).toBeNull();
    }
    // A rail this build doesn't know has no key page to check against.
    expect(setupStepLink({ id: 'claude-code', keyUrl: 'https://claude.ai/x' }, step, null)).toBeNull();
  });

  test('with the connector off, the open rails drop "Connect your agent to FORGE once" (WEB-M6)', () => {
    const claudeCode = railMeta('claude-code');
    const connect = claudeCode.setup.filter((step) => step.startsWith('Connect your agent to FORGE once'));
    expect(connect).toHaveLength(1);
    expect(setupSteps(claudeCode, false, true)).toEqual(claudeCode.setup);
    expect(setupSteps(claudeCode, false, false)).toEqual(claudeCode.setup.filter((step) => !connect.includes(step)));
  });

  test('the new refusals read as plain sentences (contract additions)', () => {
    expect(describeClaimError({ code: 'tier_too_low' })).toBe(
      'This task needs a contributor tier above T0; it opens up as you ship work.',
    );
    expect(describeClaimError({ code: 'claim_cooldown', retryAfterSeconds: 23 * 3600 + 5 })).toBe(
      "This task was yours less than a day ago, so you can't claim it again just yet; someone else can take it meanwhile. Try again in about 24 hours.",
    );
    expect(describeClaimError({ code: 'claim_rate_limit', retryAfterSeconds: 600 })).toBe(
      "You've claimed as many tasks as FORGE allows in a day. Try again in about 10 minutes.",
    );
    expect(describeClaimError({ code: 'claim_rate_limit' })).toBe(
      "You've claimed as many tasks as FORGE allows in a day. Wait a little, then try again.",
    );
    expect(describeStartError({ code: 'already_started' }, jules)).toBe(
      "Google Jules already started on this task a moment ago, so FORGE didn't start it twice.",
    );
    expect(describeTaskError({ code: 'submit_limit', retryAfterSeconds: 45 })).toBe(
      "You've handed in links too often just now. Try again in about 1 minute.",
    );
    expect(describeTaskError({ code: 'pr_not_for_task' }, 3)).toBe(
      "That pull request isn't for this task. FORGE takes one from your copy, opened after you claimed the task, on the task's branch or with “[#3]” in its title or “Closes #3” in its description.",
    );
    expect(describeTaskError('pr_not_for_task')).toContain("isn't for this task");
    // Every new code is its own sentence, never the catch-all.
    for (const code of ['tier_too_low', 'claim_cooldown', 'claim_rate_limit']) {
      expect(describeClaimError(code), code).not.toBe("That didn't save, so nothing was changed. Please try again.");
    }
    for (const code of ['submit_limit', 'pr_not_for_task', 'invalid_pr_url', 'pr_not_found', 'not_your_pr']) {
      expect(describeTaskError(code), code).not.toBe("That didn't work, so nothing changed. Please try again.");
    }
  });

  test('no answer is never "nothing changed" (CR-3, WEB-L7)', () => {
    expect(describeStartError({ code: 'upstream_timeout' }, jules)).toBe(
      "FORGE didn't hear back in time, so Google Jules may have started. Check “Where it is” below before you start it again.",
    );
    expect(describeClaimError('upstream_timeout')).not.toContain('nothing');
    expect(describeTaskError('upstream_timeout')).not.toContain('nothing');
    // The Copilot callback may bounce these back in the query string.
    expect(readStartOutcome({ startError: 'upstream_timeout' })).toMatchObject({ failure: { code: 'upstream_timeout' } });
    expect(readStartOutcome({ startError: 'already_started' })).toMatchObject({ failure: { code: 'already_started' } });
  });

  test('a Copilot setup failure points at steps shown below it (WEB-L2)', () => {
    expect(describeStartError({ code: 'rail_setup_needed' }, railMeta('copilot'), { steps: 'below' })).toBe(
      "GitHub Copilot isn't connected to your copy yet. Finish the setup steps below, then try again.",
    );
  });

  test('relay failures say what happened, and "a key you saved" only when that is it (WEB-M8)', () => {
    const sentences = [
      notRelayedSentence(jules.label),
      describeRelayError({ code: 'dispatch_limit', limit: 10, retryAfterSeconds: 1200 }, cursor),
      describeRelayError({ code: 'dispatch_limit' }, cursor),
      describeRelayError({ code: 'rail_failed', upstreamStatus: 503 }, devin),
      describeRelayError({ code: 'rail_failed' }, devin),
      describeRelayError({ code: 'not_holder' }, jules),
      describeRelayError({ code: 'something_new' }, jules),
    ];
    expect(sentences).toEqual([
      "Nothing was sent: Google Jules didn't take the notes just now. Try again in a few minutes. If your agent has the FORGE connector, it can read these itself.",
      "FORGE has called agents for you 10 times in the last hour, the most it allows, so nothing was sent. Try again in about 20 minutes.",
      "FORGE has called agents for you as often as it allows in an hour, so nothing was sent. Wait a little, then try again.",
      "Cognition didn't take the notes (error 503), so nothing was sent. Try again in a minute.",
      "Cognition didn't take the notes, so nothing was sent. Try again in a minute.",
      "This task isn't yours any more, so nothing changed. Claim it again first.",
      "That didn't work, so nothing was sent. Please try again.",
    ]);
    for (const sentence of sentences) {
      expect(sentence).not.toContain('only with a key you saved');
    }
    // A refused key is the one case that is about the saved key.
    expect(describeRelayError({ code: 'credential_rejected' }, jules)).toBe(
      "Google didn't accept your saved key, so nothing was sent. Start Google Jules again with your key to send notes later.",
    );
  });

  const NOW = Date.parse('2026-10-04T12:00:00Z');
  const event = (minutesAgo: number, kind: string, extra: Record<string, unknown> = {}) => ({
    at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    kind,
    source: 'forge',
    message: kind,
    ...extra,
  });
  type Events = Parameters<typeof startedSince>[0]['events'];

  test('reading the status: a recent start, a recent relay, the rail that started (WEB-L2, CR-3, WEB-M8)', () => {
    const events = [
      event(30, 'claimed'),
      event(20, 'dispatched', { rail: 'jules' }),
      event(12, 'dispatched', { rail: 'copilot' }),
      event(5, 'opened', { rail: 'claude-code' }),
      event(3, 'relayed', { rail: 'jules' }),
    ] as unknown as Events;
    expect(startedSince({ events }, 'copilot', NOW - 15 * 60_000)).toBe(true);
    // `?started=copilot` is believed for ten minutes, not twelve.
    expect(startedSince({ events }, 'copilot', NOW - 10 * 60_000)).toBe(false);
    expect(startedSince({ events }, 'jules', NOW - 10 * 60_000)).toBe(false);
    expect(startedSince({ events: [] }, 'copilot', 0)).toBe(false);
    expect(relayedSince({ events }, 'jules', NOW - 4 * 60_000)).toBe(true);
    expect(relayedSince({ events }, 'jules', NOW - 2 * 60_000)).toBe(false);
    expect(relayedSince({ events }, 'cursor', 0)).toBe(false);
    // The last start, whatever was opened since; the status's own rail when no start is listed.
    expect(lastStartRail({ events, rail: 'claude-code' })).toBe('copilot');
    expect(lastStartRail({ events: [] as unknown as Events, rail: 'devin' })).toBe('devin');
    expect(lastStartRail({ events: [] as unknown as Events, rail: 'claude-code' })).toBeNull();
    expect(lastStartRail({ events: [] as unknown as Events })).toBeNull();
  });

  test('the compare link waits until the task went to an agent or an agent pushed (WEB-L3)', () => {
    expect(showsCompareLink({ events: [event(5, 'claimed')] as unknown as Events })).toBe(false);
    expect(
      showsCompareLink({
        events: [event(5, 'claimed'), event(1, 'progress', { source: 'agent', stage: 'working' })] as unknown as Events,
      }),
    ).toBe(false);
    for (const events of [
      [event(5, 'dispatched', { rail: 'jules' })],
      [event(5, 'opened', { rail: 'claude-code' })],
      [event(1, 'progress', { source: 'agent', stage: 'pushed' })],
    ]) {
      expect(showsCompareLink({ events: events as unknown as Events })).toBe(true);
    }
    // Only the agent's own word that it pushed counts, not FORGE's.
    expect(showsCompareLink({ events: [event(1, 'progress', { stage: 'pushed' })] as unknown as Events })).toBe(false);
  });
});
