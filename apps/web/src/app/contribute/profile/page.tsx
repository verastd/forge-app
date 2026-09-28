'use client';

/**
 * Settle (PRD I.2, last row): the same Foreman ledger, in friendlier clothes.
 *
 * The record itself now lives in components/ContributionRecord, shared with
 * /me. This page keeps only the heading. Phase 2 deletes it and redirects
 * here to /me.
 */

import { ContributionRecord } from '../../../components/ContributionRecord';

export default function ProfilePage() {
  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Your contributions</h1>
        <p className="lede">
          Everything you have helped ship, and what is still waiting to unlock.
        </p>
      </div>
      <ContributionRecord />
    </main>
  );
}
