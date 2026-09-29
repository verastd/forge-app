import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import apiTasks from '../../apps/api/src/forge_api/fixtures/tasks.json';
import { TASK_FIXTURES } from '../../apps/web/src/lib/fixtures';
import golden from '../fixtures/handoff-golden.json';

/**
 * The real parity lock (v0.2 PRD addendum): task #1's compiled prompt and
 * both rails' instruction lines must be byte-identical between the web
 * (`lib/offline.ts`) and the API (`bridge.py` `_handoff_instructions`).
 * `apps/api/tests/test_bridge.py` checks the API side against the same
 * `tests/fixtures/handoff-golden.json`; this checks the rendered web side
 * against it, offline (the demo build's own claim/dispatch simulation, not
 * a mock) so there is no page.route payload standing in for what the web
 * actually composed. Forced offline (as `contribute.spec.ts` does), so the
 * fallback path is deterministic rather than depending on nothing
 * listening on the flags/bridge APIs' default port.
 */
async function goOffline(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/**
 * The modal's instruction lines exactly as rendered. Compared with `toEqual`
 * rather than `toHaveText`, which normalises whitespace: a line that drifted
 * by one doubled or trailing space would still pass that.
 */
async function instructionLines(modal: Locator): Promise<string[]> {
  const items = modal.getByRole('listitem');
  await expect(items).not.toHaveCount(0);
  return items.allTextContents();
}

test.describe('the handoff golden fixture, on the demo build', () => {
  test.beforeEach(async ({ page }) => {
    await goOffline(page);
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();
    await expect(page.getByRole('heading', { name: 'Let my agent work on it' })).toBeVisible();
  });

  test('the Claude Code instructions and prefilled prompt match byte for byte, with no repositories hint', async ({
    page,
  }) => {
    await page.getByRole('button').filter({ hasText: 'Claude Code' }).click();

    const modal = page.getByRole('dialog', { name: 'Hand this to Claude Code' });
    await expect(modal).toBeVisible();
    expect(await instructionLines(modal)).toEqual(golden.instructions['claude-code']);

    const link = modal.getByRole('link', { name: 'Open Claude Code' });
    const href = await link.getAttribute('href');
    const url = new URL(href ?? '', 'https://example.test');
    expect(url.searchParams.get('prompt')).toBe(golden.prompt);
    // A practice session has no real GitHub login to point a fork at.
    expect(url.searchParams.has('repositories')).toBe(false);
  });

  test('the Codex instructions match the golden too', async ({ page }) => {
    await page.getByRole('button').filter({ hasText: 'OpenAI Codex' }).click();

    const modal = page.getByRole('dialog', { name: 'Hand this to OpenAI Codex' });
    await expect(modal).toBeVisible();
    expect(await instructionLines(modal)).toEqual(golden.instructions.codex);
  });
});

test.describe('the offline task fixtures', () => {
  // No browser: `lib/fixtures.ts` against the API's `tasks.json`, every field.
  // The golden above already pins task #1's prompt; this pins the rest of the
  // eight too. Compared as the API serves a task: it adds `status` from its
  // lease store and leaves an unpaid task's null `rewardUsd` out.
  test('match the API fixtures field for field', () => {
    const served = apiTasks.map(({ rewardUsd, ...task }) => ({
      ...task,
      ...(rewardUsd === null ? {} : { rewardUsd }),
      status: 'open',
    }));
    expect(TASK_FIXTURES.map((task) => task.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TASK_FIXTURES).toStrictEqual(served);
  });
});
