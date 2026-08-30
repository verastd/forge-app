'use client';

/**
 * Settle (PRD I.2, last row): the same Foreman ledger, in friendlier clothes.
 *
 * Rewards pay on *merge plus survival*, never on submission — so the pending
 * list is a countdown, not a balance (PRD §7.3).
 */

import { useCallback, useEffect, useState } from 'react';
import { TIERS } from '@forge/shared';
import type { ContributorProfile } from '@forge/shared';

import { Chip } from '../../../components/Chip';
import { DataTable } from '../../../components/DataTable';
import type { Column } from '../../../components/DataTable';
import { fetchProfile } from '../../../lib/api';
import {
  TIER_HOW,
  TIER_NAME,
  formatDate,
  formatDaysLeft,
  formatPercent,
  formatPoints,
  ledgerKindLabel,
} from '../../../lib/format';

type LedgerRow = ContributorProfile['ledger'][number];

const LEDGER_COLUMNS: ReadonlyArray<Column<LedgerRow>> = [
  { key: 'kind', header: 'What happened', render: (row) => ledgerKindLabel(row.kind) },
  {
    key: 'ref',
    header: 'Task',
    render: (row) =>
      row.refIssue === undefined ? <span className="faint">—</span> : `#${row.refIssue}`,
  },
  { key: 'points', header: 'Credit', className: 'num', render: (row) => formatPoints(row.points) },
  { key: 'at', header: 'When', className: 'num', render: (row) => formatDate(row.at) },
];

export default function ProfilePage() {
  const [profile, setProfile] = useState<ContributorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchProfile()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setProfile(result.data);
        setLoading(false);
      })
      .catch(() => {
        // Live: someone's standing and their pending rewards are the last
        // numbers on this site that may ever be guessed at.
        if (cancelled) {
          return;
        }
        setProfile(null);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  if (failed) {
    return (
      <main className="page stack">
        <h1 className="page-title">Your contributions</h1>
        <div className="card stack" role="alert">
          <p className="muted">
            We could not load your record just now, and we would rather show you nothing than
            show you numbers we are not sure of. Everything you have done is still there.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (loading || profile === null) {
    return (
      <main className="page">
        <div className="card stack">
          <div className="skeleton" style={{ width: '35%' }} />
          <div className="skeleton" style={{ width: '60%' }} />
        </div>
      </main>
    );
  }

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Your contributions</h1>
        <p className="lede">
          Everything you have helped ship, and what is still waiting to unlock.
        </p>
      </div>

      <section className="card stack">
        <div className="row">
          <span className="tier-badge">{profile.tier}</span>
          <div>
            <h2 className="card-title">{profile.login}</h2>
            <p className="faint">{TIER_NAME[profile.tier]}</p>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat">
            <p className="stat-value">{profile.merged}</p>
            <p className="stat-label">contributions shipped</p>
          </div>
          <div className="stat">
            <p className="stat-value">{formatPercent(profile.survivalRate)}</p>
            <p className="stat-label">still standing</p>
          </div>
          <div className="stat">
            <p className="stat-value">{profile.pendingRewards.length}</p>
            <p className="stat-label">rewards on the clock</p>
          </div>
        </div>

        <ol className="ladder" aria-label="The ladder">
          {TIERS.map((tier) => (
            <li
              key={tier}
              className={`ladder-rung ${tier === profile.tier ? 'ladder-rung-current' : ''}`}
            >
              <span className="ladder-code">{tier}</span>
              <span className="ladder-name">{TIER_NAME[tier]}</span>
              <span className="ladder-how">{TIER_HOW[tier]}</span>
            </li>
          ))}
        </ol>

        <details className="disclosure">
          <summary>How the ladder works</summary>
          <div className="disclosure-body stack">
            <p className="muted">
              Everyone starts at <strong>T0</strong> and can take starter tasks straight away. Two
              contributions that ship and stay shipped move you to <strong>T1</strong>, which is
              where tasks with rewards open up. Eight, with most of them still standing after a few
              months, gets you to <strong>T2</strong> and the bigger work. <strong>T3</strong> is by
              invitation: stewards help decide what gets built and can wave contributions through.
            </p>
            <p className="muted">
              Standing is earned by work that lasted, and nothing else. It cannot be bought, and
              holding more of the token does not move you up a rung. If you step away for a few
              months you drift down gently, and never below T1 once you have reached it.
            </p>
          </div>
        </details>
      </section>

      <section className="stack">
        <h2 className="section-title">Waiting to unlock</h2>
        {profile.pendingRewards.length === 0 ? (
          <div className="card">
            <p className="muted">
              Nothing pending. Rewards land here once a contribution ships, and unlock after it has
              survived a couple of weeks in the live app.
            </p>
          </div>
        ) : (
          <ul className="stack" style={{ listStyle: 'none' }}>
            {profile.pendingRewards.map((reward) => (
              <li key={`${reward.pr}-${reward.survivalEndsAt}`} className="card row">
                <div>
                  <p className="card-title">${reward.usdEquivalent}-equiv</p>
                  <p className="faint">
                    for your contribution to task #{reward.pr} · {reward.rewardClass}
                  </p>
                </div>
                <span className="spacer" />
                <Chip tone="warn">unlocks in {formatDaysLeft(reward.survivalEndsAt)}</Chip>
              </li>
            ))}
          </ul>
        )}
        <p className="faint">
          Rewards unlock only after your work has held up in the live app. That is what makes them
          worth something.
        </p>
      </section>

      <section className="stack">
        <h2 className="section-title">Everything that has happened</h2>
        <DataTable
          columns={LEDGER_COLUMNS}
          rows={profile.ledger}
          rowKey={(row, index) => `${row.kind}-${row.at}-${index}`}
          empty="Nothing yet. Your first claimed task shows up here."
        />
      </section>
    </main>
  );
}
