'use client';

/**
 * The admin panel on a proposal's page (Phase 5 contract §1 and §4): "End
 * debate now" and "Close the vote now", each behind a confirm step, and,
 * once it has passed, the draft-task form with "Publish to the board".
 * Shown only when the API's `you.isAdmin` says so; the API checks
 * FORGE_ADMIN_IDS on every one of these requests regardless.
 *
 * The two buttons are test tools: the API takes them only while Test timers
 * are on (409 `test_mode_off` otherwise), so they show only then, and the
 * panel says where the switch is. The draft task's tier floor is T0, the only
 * one open while every contributor is T0; its plain summary starts as the
 * mover's pitch and is what agents read as the task, which the form says.
 */

import Link from 'next/link';
import { useState } from 'react';
import { PROPOSAL_LIMITS, REWARD_CLASSES, SIZES } from '@forge/shared';
import type { DraftTask, DraftTaskRequest, RewardClass, Size } from '@forge/shared';

import { SIZE_FILTER_LABEL, tierFloorLabel } from '../../../lib/format';
import type { DisplayDetail } from '../../../lib/proposals';
import {
  OPEN_TIER_FLOOR,
  checkDraft,
  criteriaLines,
  draftFormOf,
  publishTitleProblem,
} from '../../../lib/proposals-format';
import type { DraftField, DraftForm, ProposalAction } from '../../../lib/proposals-format';
import { CountedField } from '../fields';
import styles from '../propose.module.css';
import { Busy, OutcomeLine, useFocusNext } from './problem';
import type { Outcome } from './problem';

const REWARD_LABEL: Readonly<Record<RewardClass, string>> = {
  none: 'No reward',
  R1: 'R1 (the smallest)',
  R2: 'R2',
  R3: 'R3',
  R4: 'R4 (the largest)',
};

export function AdminPanel({
  detail,
  testTimers,
  busy,
  outcome,
  onEndDebate,
  onCloseVote,
  onSaveDraft,
  onPublish,
}: {
  detail: DisplayDetail;
  /** Whether Test timers are on (`/me`): null until known. */
  testTimers: boolean | null;
  busy: ProposalAction | null;
  outcome: Outcome | null;
  onEndDebate: () => Promise<boolean>;
  onCloseVote: () => Promise<boolean>;
  onSaveDraft: (draft: DraftTaskRequest) => Promise<boolean>;
  onPublish: (draft: DraftTaskRequest) => Promise<boolean>;
}) {
  const { proposal, draft } = detail;
  const focusNext = useFocusNext();
  const [confirming, setConfirming] = useState<'end' | 'close' | null>(null);
  const working = busy !== null;
  const taskId = detail.taskId ?? draft?.taskId;
  const drafting = proposal.state === 'passed' && taskId === undefined;
  const running = proposal.state === 'debate' || proposal.state === 'voting';

  const confirm = (run: () => Promise<boolean>): void => {
    if (working) return;
    void run().then((done) => {
      if (done) setConfirming(null);
    });
  };

  const open = (which: 'end' | 'close') => () => {
    if (working) return;
    setConfirming(which);
    focusNext(which === 'end' ? 'end-debate-yes' : 'close-vote-yes');
  };

  const notYet = (which: 'end' | 'close') => () => {
    if (working) return;
    setConfirming(null);
    focusNext(which === 'end' ? 'end-debate-open' : 'close-vote-open');
  };

  return (
    <section className="card stack" aria-labelledby="admin-title">
      <h2 id="admin-title" className="section-title">
        Admin
      </h2>
      <p className="faint">Only FORGE&apos;s admins see this. Every admin action goes in the timeline with your login.</p>
      <OutcomeLine part="admin" outcome={outcome} />

      {running && testTimers !== true && (
        <p className="muted">
          &ldquo;End debate now&rdquo; and &ldquo;Close the vote now&rdquo; are test tools: they show only while
          Test timers are on. The switch is on <Link href="/propose" className={styles.inlineLink}>the floor</Link>.
        </p>
      )}

      {proposal.state === 'debate' &&
        testTimers === true &&
        (confirming === 'end' ? (
          <div className={styles.confirm} role="group" aria-labelledby="end-question">
            <p id="end-question">
              End debate now? It ends as if its time were up: with no objection it passes, and with one it goes
              to a vote.
            </p>
            <div className="row">
              <button
                id="end-debate-yes"
                type="button"
                className="btn"
                aria-disabled={working || undefined}
                aria-busy={busy === 'end_debate' || undefined}
                onClick={() => {
                  confirm(onEndDebate);
                }}
              >
                <Busy when={busy === 'end_debate'} idle="Yes, end debate now" working="Ending debate…" />
              </button>
              <button type="button" className="btn btn-ghost" aria-disabled={working || undefined} onClick={notYet('end')}>
                Not yet
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button id="end-debate-open" type="button" className="btn" aria-disabled={working || undefined} onClick={open('end')}>
              End debate now
            </button>
          </div>
        ))}

      {proposal.state === 'voting' &&
        testTimers === true &&
        (confirming === 'close' ? (
          <div className={styles.confirm} role="group" aria-labelledby="close-question">
            <p id="close-question">Close the vote now? It is counted as if its time were up.</p>
            <div className="row">
              <button
                id="close-vote-yes"
                type="button"
                className="btn"
                aria-disabled={working || undefined}
                aria-busy={busy === 'close_vote' || undefined}
                onClick={() => {
                  confirm(onCloseVote);
                }}
              >
                <Busy when={busy === 'close_vote'} idle="Yes, close the vote now" working="Closing the vote…" />
              </button>
              <button type="button" className="btn btn-ghost" aria-disabled={working || undefined} onClick={notYet('close')}>
                Not yet
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button id="close-vote-open" type="button" className="btn" aria-disabled={working || undefined} onClick={open('close')}>
              Close the vote now
            </button>
          </div>
        ))}

      {drafting &&
        (draft === undefined ? (
          <p className="muted">The draft task isn&apos;t here yet. Reload the page in a moment.</p>
        ) : (
          <DraftTaskForm key={proposal.id} draft={draft} busy={busy} onSave={onSaveDraft} onPublish={onPublish} />
        ))}

      {taskId !== undefined && (
        <p>
          <Link href={`/contribute/task/${taskId}`} className={`btn ${styles.btnWrap}`}>
            See task #{taskId} on the Contribute board
          </Link>
        </p>
      )}

      {!running && !drafting && taskId === undefined && (
        <p className="muted">Nothing for an admin to do at this stage.</p>
      )}
    </section>
  );
}

const DRAFT_FIELD_ID: Readonly<Record<DraftField, string>> = {
  title: 'draft-title',
  civilianSummary: 'draft-summary',
  acceptanceCriteria: 'draft-criteria',
};

function DraftTaskForm({
  draft,
  busy,
  onSave,
  onPublish,
}: {
  draft: DraftTask;
  busy: ProposalAction | null;
  onSave: (draft: DraftTaskRequest) => Promise<boolean>;
  onPublish: (draft: DraftTaskRequest) => Promise<boolean>;
}) {
  const [form, setForm] = useState<DraftForm>(() => draftFormOf(draft));
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({});
  const working = busy !== null;
  const lines = criteriaLines(form.criteria).length;

  const set = <K extends keyof DraftForm>(key: K) =>
    (value: DraftForm[K]): void => {
      if (working) return;
      setForm((current) => ({ ...current, [key]: value }));
    };

  const checked = (publishing: boolean): DraftTaskRequest | null => {
    const result = checkDraft(form);
    const found: Partial<Record<DraftField, string>> = result.ok ? {} : { ...result.errors };
    const branch = publishing && found.title === undefined ? publishTitleProblem(form.title) : null;
    if (branch !== null) found.title = branch;
    const first = (['title', 'civilianSummary', 'acceptanceCriteria'] as const).find((field) => found[field] !== undefined);
    if (!result.ok || first !== undefined) {
      setErrors(found);
      if (first !== undefined) document.getElementById(DRAFT_FIELD_ID[first])?.focus();
      return null;
    }
    setErrors({});
    return result.value;
  };

  return (
    <form
      className={styles.form}
      noValidate
      aria-labelledby="draft-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (working) return;
        const value = checked(false);
        if (value !== null) void onSave(value);
      }}
    >
      <h3 id="draft-heading" className={styles.subTitle}>
        The draft task
      </h3>
      <p className="muted">
        It passed, so it becomes a task. Write down what &ldquo;done&rdquo; means, then publish it to the
        Contribute board: the proposal moves to &ldquo;Being built&rdquo;.
      </p>
      <CountedField
        id="draft-title"
        label="Task title"
        help="Its branch on GitHub is named after it, so give it at least one letter or digit from A to Z or 0 to 9."
        value={form.title}
        onChange={set('title')}
        max={PROPOSAL_LIMITS.title}
        error={errors.title}
        readOnly={working}
      />
      <CountedField
        id="draft-summary"
        label="Plain summary"
        help="Agents read this as the task. It starts as the member's pitch, so check it says only what the task is: it's also what contributors read on the board."
        value={form.civilianSummary}
        onChange={set('civilianSummary')}
        max={PROPOSAL_LIMITS.summary}
        error={errors.civilianSummary}
        multiline
        rows={4}
        readOnly={working}
      />
      <div className={styles.field}>
        <label htmlFor="draft-criteria">What done means</label>
        <p id="draft-criteria-help" className={styles.help}>
          One line each, 1 to {PROPOSAL_LIMITS.criteria} lines of up to {PROPOSAL_LIMITS.criterion} characters.
          Every contribution is checked against them.
        </p>
        <textarea
          id="draft-criteria"
          className={`text-input ${styles.input}`}
          rows={6}
          value={form.criteria}
          readOnly={working}
          aria-invalid={errors.acceptanceCriteria === undefined ? undefined : true}
          aria-describedby={[
            'draft-criteria-help',
            errors.acceptanceCriteria === undefined ? null : 'draft-criteria-error',
            'draft-criteria-count',
          ]
            .filter((part): part is string => part !== null)
            .join(' ')}
          onChange={(event) => {
            set('criteria')(event.target.value);
          }}
        />
        <div className={styles.fieldFoot}>
          {errors.acceptanceCriteria === undefined ? (
            <span />
          ) : (
            <p id="draft-criteria-error" className={styles.fieldError}>
              {errors.acceptanceCriteria}
            </p>
          )}
          <span
            id="draft-criteria-count"
            className={`${styles.counter} ${lines > PROPOSAL_LIMITS.criteria ? styles.counterOver : ''}`}
          >
            {lines} / {PROPOSAL_LIMITS.criteria} lines
          </span>
        </div>
      </div>
      <div className={styles.selects}>
        <div className={styles.field}>
          <label htmlFor="draft-size">Size</label>
          <select
            id="draft-size"
            className={`text-input ${styles.input}`}
            value={form.size}
            aria-disabled={working || undefined}
            onChange={(event) => {
              set('size')(event.target.value as Size);
            }}
          >
            {SIZES.map((size) => (
              <option key={size} value={size}>
                {size} · {SIZE_FILTER_LABEL[size]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field} role="group" aria-labelledby="draft-tier-label">
          <span id="draft-tier-label" className={styles.fieldLabel}>
            Tier floor
          </span>
          <p className={styles.fixedValue}>{tierFloorLabel(OPEN_TIER_FLOOR)}</p>
          <p className={styles.help}>Higher tiers open later.</p>
        </div>
        <div className={styles.field}>
          <label htmlFor="draft-reward">Reward</label>
          <select
            id="draft-reward"
            className={`text-input ${styles.input}`}
            value={form.rewardClass}
            aria-disabled={working || undefined}
            onChange={(event) => {
              set('rewardClass')(event.target.value as RewardClass);
            }}
          >
            {REWARD_CLASSES.map((reward) => (
              <option key={reward} value={reward}>
                {REWARD_LABEL[reward]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <button type="submit" className="btn" aria-disabled={working || undefined} aria-busy={busy === 'save_draft' || undefined}>
          <Busy when={busy === 'save_draft'} idle="Save draft" working="Saving…" />
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={working || undefined}
          aria-busy={busy === 'publish' || undefined}
          onClick={() => {
            if (working) return;
            const value = checked(true);
            if (value !== null) void onPublish(value);
          }}
        >
          <Busy when={busy === 'publish'} idle="Publish to the board" working="Publishing…" />
        </button>
      </div>
    </form>
  );
}
