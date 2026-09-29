import { expect, test } from '@playwright/test';

/**
 * /propose is static and honest (PRD v0.2): no data, no flag, just the rules
 * the pilot will actually run under. The fast-path and timing facts are
 * things people will rely on, not decorative copy, so each is asserted on a
 * short, distinctive phrase rather than the whole paragraph — a copy edit
 * that keeps the same rule should not break this test. See
 * notes-phase2.md's "Orchestrator review edits" for the silent path, the
 * 7-day lapse and the edit-until-seconded rule, which the review pass added
 * after the original unit spec was written.
 */

test.describe('/propose', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/propose');
  });

  test('says plainly that proposals are not open yet', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Propose', level: 1 })).toBeVisible();
    await expect(page.getByText("Proposals aren't open yet.")).toBeVisible();
  });

  test('shows the five-stage flow line', async ({ page }) => {
    await expect(page.getByText('Motion → Second → Debate → Vote → Build queue')).toBeVisible();
  });

  test('states the unanimous-consent fast path', async ({ page }) => {
    await expect(page.getByText(/is seconded, every eligible member can Consent or Object/)).toBeVisible();
    await expect(page.getByText(/passes right away, without waiting out the rest of debate/)).toBeVisible();
    await expect(page.getByText(/counts as consenting automatically/)).toBeVisible();
    await expect(page.getByText(/has to consent like anyone else/)).toBeVisible();
    await expect(page.getByText(/A single objection ends the fast path/)).toBeVisible();
    await expect(page.getByText(/finishes its debate and then goes to a vote/)).toBeVisible();
  });

  test('states the pilot timing and quorum rules', async ({ page }) => {
    await expect(page.getByText(/debate runs for 3 days, then voting runs for 2 days/)).toBeVisible();
    await expect(page.getByText(/quorum is a majority of eligible members/i)).toBeVisible();
    await expect(page.getByText(/majority of the votes cast carries/)).toBeVisible();
  });

  test('states the silent path, the 7-day lapse, and the edit-until-seconded rule', async ({
    page,
  }) => {
    await expect(page.getByText(/passes without the voting days/)).toBeVisible();
    await expect(page.getByText(/nobody seconds within 7 days lapses/)).toBeVisible();
    await expect(page.getByText(/edit it until someone seconds it/)).toBeVisible();
  });
});
