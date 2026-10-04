import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { demoSignIn } from './helpers/session';

/**
 * The Propose floor on the practice app (project `chromium-demo`, API down):
 * the floor's sections, the rules under "How proposals work", read-only
 * signed out, the practice walk-through (second, consent, passed), an
 * objection with its reason, the new-proposal form's checks, 390 px, the
 * keyboard, and the `proposals` flag switched off.
 *
 * Everything here is the practice floor (lib/proposals-offline.ts): nothing
 * leaves the tab. The live screens, the BFF and every error sentence are in
 * live-propose.spec.ts and proposals-bff.spec.ts.
 */

const PRACTICE = 'Practice: nothing is saved.';
const WALKTHROUGH = 'Add a dark and light theme switch';
const IN_DEBATE = 'Let me follow a task and hear when it ships';
const PASSED = 'Show my Upland properties on a map in the Data app';

/** The rules people rely on: asserted on short, distinctive phrases, so a copy edit keeping the rule passes. */
const RULES = [
  'Motion → Second → Debate → Vote → Build',
  /edit it until someone seconds it/,
  /nobody seconds within 7 days lapses/,
  /passes without the voting days/,
  /is seconded, every eligible member can Consent or Object/,
  /passes right away, without waiting out the rest of debate/,
  /counts as consenting automatically/,
  /has to consent like anyone else/,
  /A single objection ends the fast path/,
  /finishes its debate and then goes to a vote/,
  // review-pages M1: both answers are final, and the rules say so.
  /Consenting is final, and so is objecting/,
  // Rules M3: who counts is who has been active lately.
  /members active on FORGE in the last 30 days, plus the person who moved it and/,
  /the members active in the last 30 days when it was seconded/,
  // Rules M1: the pause.
  /every running deadline moves later by the time it was paused/,
  /debate runs for 3 days, then voting runs for 2 days/,
  /Quorum is a majority of eligible members/,
  /majority of the votes cast carries/,
  /your name shows next to your vote after the close/,
  /panel in the lobby is still added by hand/,
];

/** Nothing reaches an API from these tests, even if one happens to be listening. */
async function goOffline(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

function section(page: Page, name: string) {
  return page.getByRole('region', { name });
}

/** The line at the top of "Your part" that says how a write went (and takes focus after it). */
function partOutcome(page: Page) {
  return page.locator('#part-outcome');
}

async function practiceSignIn(page: Page, next: string): Promise<void> {
  await goOffline(page);
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await demoSignIn(page);
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

test.describe('the floor', () => {
  test.beforeEach(async ({ page }) => {
    await goOffline(page);
    await page.goto('/propose');
  });

  test('shows the four sections, each sample in its own, with its countdown', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Propose', level: 1 })).toBeVisible();
    await expect(page.getByText(PRACTICE)).toBeVisible();

    await expect(section(page, 'Needs a second').getByRole('link', { name: new RegExp(WALKTHROUGH) })).toBeVisible();
    await expect(section(page, 'Needs a second').getByText(/Needs a second within 6d/)).toBeVisible();
    await expect(section(page, 'In debate').getByRole('link', { name: new RegExp(IN_DEBATE) })).toBeVisible();
    await expect(section(page, 'In debate').getByText(/Debate ends in 2d/)).toBeVisible();
    await expect(section(page, 'Voting').getByText('Nothing is being voted on right now.')).toBeVisible();
    const decided = section(page, 'Decided').getByRole('listitem').filter({ hasText: PASSED });
    await expect(decided.getByRole('link', { name: PASSED })).toHaveAttribute('href', '/propose/1');
    await expect(decided.getByText('Passed', { exact: true })).toBeVisible();
    await expect(decided.getByText(/Moved by maya-builds/)).toBeVisible();
  });

  test('keeps the rules collapsed under "How proposals work"', async ({ page }) => {
    const rules = page.locator('details', { has: page.getByText('How proposals work') });
    await expect(rules).not.toHaveAttribute('open');
    await expect(page.getByText(RULES[0] as string)).toBeHidden();

    await rules.getByText('How proposals work').click();
    for (const rule of RULES) {
      await expect(rules.getByText(rule).first(), String(rule)).toBeVisible();
    }
  });

  test('signed out, bringing a proposal is "Sign in to bring a proposal"', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Sign in to bring a proposal' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fpropose%2Fnew',
    );
  });

});

test.describe('read-only signed out', () => {
  test('a proposal’s page shows the whole record and no buttons to act with', async ({ page }) => {
    await goOffline(page);
    await page.goto('/propose/2');

    await expect(page.getByRole('heading', { name: IN_DEBATE, level: 1 })).toBeVisible();
    await expect(page.getByText('In debate', { exact: true })).toBeVisible();
    await expect(page.getByText(/Seconded by/)).toContainText('jo-plays');
    await expect(page.getByText(/When I find a task on the Contribute board/)).toBeVisible();
    await expect(page.getByText('2 of 4 have consented.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Timeline' }).getByText('sam-k brought this proposal.')).toBeVisible();

    for (const name of ['Second this proposal', 'Consent', 'Object', 'Post comment', 'Edit', 'Withdraw']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('link', { name: 'Sign in to practise' })).toHaveAttribute('href', '/signin?next=%2Fpropose%2F2');
  });

  test('/propose/new sends a signed-out visitor to sign in first, and back afterwards', async ({ page }) => {
    await goOffline(page);
    await page.goto('/propose/new');
    await expect(page).toHaveURL(/\/signin\?next=%2Fpropose%2Fnew$/);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/propose\/new$/);
    await expect(page.getByRole('heading', { name: 'Bring a proposal', level: 1 })).toBeVisible();
  });

  test('a proposal that isn’t there says so, and so does a malformed id', async ({ page }) => {
    await goOffline(page);
    for (const path of ['/propose/99', '/propose/0', '/propose/abc']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: "That proposal isn't here", level: 1 })).toBeVisible();
    }
  });
});

test.describe('the practice walk-through', () => {
  test('second it, then consent: everyone has consented, so it passes at once', async ({ page }) => {
    await practiceSignIn(page, '/propose/3');
    await expect(page.getByRole('heading', { name: WALKTHROUGH, level: 1 })).toBeVisible();
    await expect(page.getByText(PRACTICE).first()).toBeVisible();
    await expect(page.getByText('Debate opens once someone seconds it.')).toBeVisible();

    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(partOutcome(page).getByRole('status')).toHaveText('You seconded it. Debate is open. Practice: nothing is saved.');
    await expect(page.getByText('In debate', { exact: true })).toBeVisible();
    await expect(page.getByText(/Seconded by Practice account/)).toBeVisible();
    await expect(page.getByText(/^Debate ends in 2d 23h/)).toBeVisible();
    await expect(page.getByText('3 of 4 have consented.')).toBeVisible();
    const timeline = page.getByRole('region', { name: 'Timeline' });
    await expect(timeline.getByText('Practice account seconded it. Debate is open for 3 days.')).toBeVisible();
    await expect(timeline.getByText('maya-builds consented.')).toBeVisible();

    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await expect(partOutcome(page).getByRole('status')).toContainText('You consented, and with that everyone has: it passed.');
    await expect(page.getByText('Passed', { exact: true })).toBeVisible();
    await expect(page.getByText(/It passed without a vote: nobody objected/)).toBeVisible();
    await expect(page.getByText('You consented during debate.')).toBeVisible();
    await expect(timeline.getByText('Everyone counted at the second consented, so it passed without a vote.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toHaveCount(0);
    // A state change is announced, not just drawn.
    await expect(page.locator('main [aria-live="polite"]', { hasText: 'This proposal is now: Passed.' })).toHaveCount(1);

    // Back on the floor (same tab, so the practice floor remembers), it is decided.
    await page.getByRole('link', { name: '← All proposals' }).click();
    await expect(section(page, 'Decided').getByRole('link', { name: new RegExp(WALKTHROUGH) })).toBeVisible();
    await expect(section(page, 'Needs a second').getByText('Nothing is waiting for a second right now.')).toBeVisible();
  });

  test('objecting asks for a one-line reason, posts it in the debate, and sends it to a vote', async ({ page }) => {
    await practiceSignIn(page, '/propose/2');
    await page.getByRole('button', { name: 'Object', exact: true }).click();
    await expect(page.getByText(/Objecting is final/)).toBeVisible();

    // No reason, no objection.
    await page.getByRole('button', { name: 'Send my objection' }).click();
    await expect(page.getByText('Say why in one line: it is posted in the debate.')).toBeVisible();
    await expect(page.getByLabel('Why do you object? One line, posted in the debate.')).toBeFocused();

    await page.getByLabel('Why do you object? One line, posted in the debate.').fill('It should cover proposals too.');
    await page.getByRole('button', { name: 'Send my objection' }).click();
    await expect(partOutcome(page).getByRole('status')).toHaveText('You objected. It goes to a vote after debate. Practice: nothing is saved.');
    await expect(page.getByText('Objected: this goes to a vote after debate.')).toBeVisible();
    await expect(page.getByText('You objected, so it goes to a vote after debate.')).toBeVisible();
    const comments = page.getByRole('list', { name: 'Comments' });
    await expect(comments.getByRole('listitem').last()).toContainText('Practice account');
    await expect(comments.getByRole('listitem').last()).toContainText('It should cover proposals too.');
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toHaveCount(0);
  });

  test('review-pages M1 (P6 turned around): consenting says it is final before you do it, and the rules agree', async ({ page }) => {
    await practiceSignIn(page, '/propose/2');
    const part = section(page, 'Your part');
    await expect(part).toContainText('Consenting is final, and so is objecting.');
    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    const step = page.getByRole('group', { name: /Consent to this proposal\?/ });
    await expect(step).toContainText("Consenting is final: you can't object afterwards.");
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await expect(part.getByText('You consented.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Object', exact: true })).toHaveCount(0);

    await page.goto('/propose');
    await page.getByText('How proposals work').click();
    await expect(page.locator('details.disclosure')).toContainText('Consenting is final, and so is objecting: once you have answered, you can');
  });

  test('a comment goes into the thread, and an empty one is caught first', async ({ page }) => {
    await practiceSignIn(page, '/propose/2');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText('Write something first.')).toBeVisible();
    await page.getByLabel('Add to the debate').fill('Line one.\nLine two.');
    await expect(page.getByText('19 / 2000')).toBeVisible();
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.locator('#debate-outcome').getByRole('status')).toHaveText('Your comment is posted. Practice: nothing is saved.');
    await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByLabel('Add to the debate')).toHaveValue('');
  });
});

test.describe('the new-proposal form', () => {
  test.beforeEach(async ({ page }) => {
    await practiceSignIn(page, '/propose/new');
  });

  test('counts characters, checks before sending, and refuses the practice account', async ({ page }) => {
    await expect(page.getByText(/Practice: try the form/)).toBeVisible();
    await expect(page.getByText(/Say what FORGE should build and why it matters, in plain English/).first()).toBeVisible();
    await expect(page.getByText('0 / 100')).toBeVisible();
    await expect(page.getByText('0 / 4000')).toBeVisible();

    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.getByText('Give it a title.')).toBeVisible();
    await expect(page.getByText('Say what FORGE should build and why it matters.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Title')).toBeFocused();
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');

    // Counted the way the API counts: one emoji is one character.
    await page.getByLabel('Title').fill('🏛'.repeat(101));
    await expect(page.getByText('101 / 100')).toBeVisible();
    await page.getByLabel('Your pitch').fill('A map of my properties.');
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.getByText('Keep the title to 100 characters (it has 101).')).toBeVisible();

    await page.getByLabel('Title').fill('A map of my properties');
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText("Practice accounts can't do that. Sign in with GitHub to take part.");
    await expect(page).toHaveURL(/\/propose\/new$/);
  });
});

test.describe('at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const path of ['/propose', '/propose/2', '/propose/1']) {
    test(`${path} fits the screen`, async ({ page }) => {
      await goOffline(page);
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.getByText(PRACTICE).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
  }

  test('signed in, a proposal’s page and the form fit too', async ({ page }) => {
    await practiceSignIn(page, '/propose/3');
    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.goto('/propose/new');
    await expect(page.getByLabel('Your pitch')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe('with the keyboard', () => {
  test('a card opens with Enter', async ({ page }) => {
    await practiceSignIn(page, '/propose');
    const card = section(page, 'Needs a second').getByRole('link', { name: new RegExp(WALKTHROUGH) });
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: WALKTHROUGH, level: 1 })).toBeVisible();
  });

  test('review-pages M4: Second, then Consent, from the keyboard alone, focus following each step', async ({ page }) => {
    await practiceSignIn(page, '/propose/3');
    // One starting point; from here on, only keys. Focus has to be where the next step is.
    await page.getByRole('button', { name: 'Second this proposal' }).focus();
    await page.keyboard.press('Enter');
    await expect(partOutcome(page)).toBeFocused();
    await expect(partOutcome(page)).toHaveText('You seconded it. Debate is open. Practice: nothing is saved.');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Yes, consent' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Passed', { exact: true })).toBeVisible();
    await expect(partOutcome(page)).toBeFocused();
    await expect(partOutcome(page)).toContainText('You consented, and with that everyone has: it passed.');
  });

  test('review-pages M4 (P3 turned around): Object takes focus to its reason, and Cancel brings it back', async ({ page }) => {
    await practiceSignIn(page, '/propose/2');
    await page.getByRole('button', { name: 'Object', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Why do you object? One line, posted in the debate.')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Send my objection' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Object', exact: true })).toBeFocused();
    // And the consent step the same way: in on its first button, back out to Consent.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Yes, consent' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeFocused();
  });

  test('"How proposals work" opens from the keyboard', async ({ page }) => {
    await goOffline(page);
    await page.goto('/propose');
    const summary = page.getByText('How proposals work');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/A single objection ends the fast path/)).toBeVisible();
  });
});

test.describe('with the proposals flag off', () => {
  test('the floor, a proposal and the form all say proposals are switched off', async ({ page }) => {
    await goOffline(page);
    await page.route('**/api/flags', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ contribute_bridge: true, proposals: false }),
      }),
    );
    for (const path of ['/propose', '/propose/2']) {
      await page.goto(path);
      await expect(page.locator('main').getByRole('alert')).toContainText('Proposals are switched off right now.');
      await expect(page.getByText(IN_DEBATE)).toHaveCount(0);
    }
    await page.goto('/signin?next=%2Fpropose%2Fnew');
    await demoSignIn(page);
    await expect(page.locator('main').getByRole('alert')).toContainText('Proposals are switched off right now.');
    await expect(page.getByLabel('Your pitch')).toHaveCount(0);
  });
});
