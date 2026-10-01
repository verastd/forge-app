import { expect, test } from '@playwright/test';

import { OPEN_RAILS, RAIL_REGISTRY, railMeta } from '../../packages/shared/dist/index.js';
import {
  CONNECT_PATH,
  FORK_URL,
  canRelayNotes,
  credentialFields,
  describeClaimError,
  describeStartError,
  describeTaskError,
  githubAppInstallUrl,
  githubAppSlug,
  keyName,
  plainText,
  readStartOutcome,
  safeHttpsUrl,
  setupStepLink,
  setupSteps,
  startedSentence,
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
    expect(launch.steps).toEqual([
      'Open your fork in Antigravity.',
      'The FORGE connector is already set up in the repo.',
      'Ask it: Start FORGE task #7',
    ]);
    expect(startTaskAsk(7)).toBe('Start FORGE task #7');
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
      [{ code: 'rail_setup_needed', detail: 'Connect your fork in Jules first.' }, 'Connect your fork in Jules first.'],
      [
        { code: 'rail_setup_needed' },
        "Google Jules isn't connected to your fork yet. Finish the setup steps above, then try again.",
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
    const plain = 'Install the Jules GitHub app on your fork, then try again.';
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
    expect(describeTaskError('not_your_pr')).toBe("That pull request comes from someone else's fork.");
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
    expect(setupStepLink(jules, 'Fork forge-app on GitHub.', null)).toEqual({ href: FORK_URL, external: true });
    expect(FORK_URL).toBe('https://github.com/verastd/forge-app/fork');
    expect(setupStepLink(copilot, "Install FORGE's GitHub app on your fork.", 'forge-foreman')).toEqual({
      href: 'https://github.com/apps/forge-foreman/installations/new',
      external: true,
    });
    // No slug configured: the step stays words, never a link that leads nowhere.
    expect(setupStepLink(copilot, "Install FORGE's GitHub app on your fork.", null)).toBeNull();
    expect(setupStepLink(railMeta('claude-code'), 'Connect your agent to FORGE once so it can report progress.', null)).toEqual({
      href: CONNECT_PATH,
      external: false,
    });
    expect(setupStepLink(jules, 'Create an API key in Jules settings.', null)).toEqual({
      href: 'https://jules.google.com/settings',
      external: true,
    });
    expect(setupStepLink(jules, 'Sign in at jules.google.com and connect your fork.', null)).toBeNull();
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
