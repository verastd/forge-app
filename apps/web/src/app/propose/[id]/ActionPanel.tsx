'use client';

/**
 * A member's part on a proposal's page (Phase 5 contract §4), driven by the
 * API's `you`: second; consent or object (each final, each behind a confirm
 * step, an objection with a one-line reason); vote; the mover's edit and
 * withdraw. `ProposalView` owns the data and the requests; this only asks for
 * them. Every button shows because the API said the caller may use it, and
 * the API checks again when it arrives: hiding a button is a courtesy, never
 * the rule.
 *
 * Signed in, the page reads the proposal in public first, then asks the BFF
 * what you can do (`you`). Until that answers this says so, and if it can't
 * answer the page stays readable, with "Your actions can't load right now".
 *
 * Keyboard focus never drops to the page: opening a step moves focus into it,
 * Cancel returns it to the button that opened the step, and after a write it
 * moves to the line at the top of this panel that says how it went.
 */

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ELIGIBLE_ACTIVITY_DAYS, PROPOSAL_LIMITS, VOTE_CHOICES, pitchLimit } from '@forge/shared';
import type { NewProposal, VoteChoice } from '@forge/shared';

import type { DisplayDetail } from '../../../lib/proposals';
import {
  VOTE_LABEL,
  checkComment,
  checkProposal,
  quorumLine,
  signInHref,
  yourConsentLine,
} from '../../../lib/proposals-format';
import type { ProposalAction } from '../../../lib/proposals-format';
import { PRACTICE_NOTE } from '../../../lib/proposals-offline';
import type { SignInAvailability } from '../../../lib/session';
import { CountedField, ProposalFields } from '../fields';
import styles from '../propose.module.css';
import { Busy, OutcomeLine, useFocusNext } from './problem';
import type { Outcome } from './problem';

/** Whether the BFF has said what you can do: not asked (signed out), asking, said, or couldn't. */
export type YouState = 'none' | 'loading' | 'ok' | 'failed';

interface Handlers {
  onEdit: (proposal: NewProposal) => Promise<boolean>;
  onWithdraw: () => Promise<boolean>;
  onSecond: () => void;
  onConsent: () => Promise<boolean>;
  onObject: (reason: string) => Promise<boolean>;
  onVote: (choice: VoteChoice) => void;
}

export function ActionPanel({
  detail,
  login,
  signedIn,
  practice,
  availability,
  youState,
  onRetryYou,
  busy,
  outcome,
  ...handlers
}: {
  detail: DisplayDetail;
  /** The caller's login (the practice stand-in in the practice app), or null signed out. */
  login: string | null;
  signedIn: boolean;
  practice: boolean;
  availability: SignInAvailability;
  youState: YouState;
  /** Ask the BFF again what you can do. */
  onRetryYou: () => void;
  busy: ProposalAction | null;
  outcome: Outcome | null;
} & Handlers) {
  const { proposal, you } = detail;

  if (you === undefined) {
    return (
      <section className="card stack" aria-labelledby="part-title">
        <h2 id="part-title" className="section-title">
          {signedIn ? 'Your part' : 'Take part'}
        </h2>
        <p className="muted">Anyone can read everything here: the pitch, the debate and the whole record.</p>
        <OutcomeLine part="part" outcome={outcome} />
        {signedIn ? (
          youState === 'loading' ? (
            <p className="loading-line">
              <span className="spinner" aria-hidden="true" />
              Loading what you can do here…
            </p>
          ) : (
            <div className={styles.action}>
              <p className="faint">Your actions can&apos;t load right now. Try again.</p>
              <div className="row">
                <button type="button" className="btn" onClick={onRetryYou}>
                  Try again
                </button>
              </div>
            </div>
          )
        ) : availability === 'unavailable' ? (
          <p className="faint">Sign in with GitHub to take part. Sign-in isn&apos;t available here right now.</p>
        ) : (
          <p>
            <Link href={signInHref(`/propose/${proposal.id}`)} className={`btn btn-primary ${styles.btnWrap}`}>
              {availability === 'demo' ? 'Sign in to practise' : 'Sign in with GitHub to take part'}
            </Link>
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="part-title">
      <h2 id="part-title" className="section-title">
        Your part
      </h2>
      {practice && <p className={styles.practiceNote}>{PRACTICE_NOTE}</p>}
      <OutcomeLine part="part" outcome={outcome} />
      {/* Keyed by state: an open step closes when the proposal moves on. */}
      <MemberActions key={`${proposal.id}-${proposal.state}`} detail={detail} login={login} busy={busy} {...handlers} />
    </section>
  );
}

function MemberActions({
  detail,
  login,
  busy,
  onEdit,
  onWithdraw,
  onSecond,
  onConsent,
  onObject,
  onVote,
}: { detail: DisplayDetail; login: string | null; busy: ProposalAction | null } & Handlers) {
  const { proposal } = detail;
  const you = detail.you;
  const focusNext = useFocusNext();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [pitch, setPitch] = useState(detail.pitch);
  const [editErrors, setEditErrors] = useState<Partial<Record<'title' | 'pitch', string>>>({});
  const [withdrawing, setWithdrawing] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [objecting, setObjecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  if (you === undefined) return null;

  const working = busy !== null;
  // The API says who is an admin, and holds the pitch to the same limit again.
  const pitchMax = pitchLimit(you.isAdmin);
  const mover = login !== null && login.toLowerCase() === proposal.mover.toLowerCase();
  const consentAnswer = yourConsentLine(you.consent, proposal.state, mover);
  const nothing =
    !you.canEdit &&
    !you.canWithdraw &&
    !you.canSecond &&
    !you.canConsent &&
    consentAnswer === null &&
    !you.canVote &&
    you.vote === undefined;

  /** Open a step (`open`), moving focus into it (`to`). */
  const opening = (open: () => void, to: string) => () => {
    if (working) return;
    open();
    focusNext(to);
  };

  const saveEdit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (working) return;
    const checked = checkProposal({ title, pitch }, pitchMax);
    if (!checked.ok) {
      setEditErrors(checked.errors);
      document.getElementById(checked.errors.title === undefined ? 'edit-pitch' : 'edit-title')?.focus();
      return;
    }
    setEditErrors({});
    void onEdit(checked.value).then((saved) => {
      if (saved) setEditing(false);
    });
  };

  const sendObjection = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (working) return;
    const checked = checkComment(reason, 'Say why in one line: it is posted in the debate.');
    if (!checked.ok) {
      setReasonError(checked.errors.text);
      document.getElementById('object-reason')?.focus();
      return;
    }
    setReasonError(undefined);
    void onObject(checked.value).then((sent) => {
      if (sent) {
        setObjecting(false);
        setReason('');
      }
    });
  };

  return (
    <>
      {you.canSecond && (
        <div className={styles.action}>
          <p className="muted">
            Seconding says the floor should take it up. Debate opens at once, and the members active in the last{' '}
            {ELIGIBLE_ACTIVITY_DAYS} days, with you and the member who brought it, can then consent, object and
            vote on it.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!working) onSecond();
              }}
              aria-disabled={working || undefined}
              aria-busy={busy === 'second' || undefined}
            >
              <Busy when={busy === 'second'} idle="Second this proposal" working="Seconding…" />
            </button>
          </div>
        </div>
      )}

      {you.canConsent &&
        (objecting ? (
          <form className={styles.confirm} onSubmit={sendObjection} noValidate aria-labelledby="object-question">
            <p id="object-question">
              <strong>Object to this proposal?</strong> Objecting is final: it ends the fast path, and the
              proposal goes to a vote once debate ends.
            </p>
            <CountedField
              id="object-reason"
              label="Why do you object? One line, posted in the debate."
              value={reason}
              onChange={setReason}
              max={PROPOSAL_LIMITS.comment}
              error={reasonError}
              readOnly={working}
            />
            <div className="row">
              <button type="submit" className="btn" aria-disabled={working || undefined} aria-busy={busy === 'object' || undefined}>
                <Busy when={busy === 'object'} idle="Send my objection" working="Objecting…" />
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-disabled={working || undefined}
                onClick={() => {
                  if (working) return;
                  setObjecting(false);
                  setReasonError(undefined);
                  focusNext('object-open');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : consenting ? (
          <div className={styles.confirm} role="group" aria-labelledby="consent-question">
            <p id="consent-question">
              <strong>Consent to this proposal?</strong> Consenting is final: you can&apos;t object afterwards.
            </p>
            <div className="row">
              <button
                id="consent-yes"
                type="button"
                className="btn btn-primary"
                aria-disabled={working || undefined}
                aria-busy={busy === 'consent' || undefined}
                onClick={() => {
                  if (working) return;
                  void onConsent().then((done) => {
                    if (done) setConsenting(false);
                  });
                }}
              >
                <Busy when={busy === 'consent'} idle="Yes, consent" working="Consenting…" />
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-disabled={working || undefined}
                onClick={() => {
                  if (working) return;
                  setConsenting(false);
                  focusNext('consent-open');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.action}>
            <p className="muted">
              Consent if you&apos;re happy for it to pass as it stands: once everyone counted has consented, it
              passes at once. One objection sends it to a vote after debate. Consenting is final, and so is
              objecting.
            </p>
            <div className="row">
              <button
                id="consent-open"
                type="button"
                className="btn btn-primary"
                aria-disabled={working || undefined}
                onClick={opening(() => {
                  setConsenting(true);
                }, 'consent-yes')}
              >
                Consent
              </button>
              <button
                id="object-open"
                type="button"
                className="btn btn-ghost"
                aria-disabled={working || undefined}
                onClick={opening(() => {
                  setObjecting(true);
                }, 'object-reason')}
              >
                Object
              </button>
            </div>
          </div>
        ))}
      {consentAnswer !== null && <p className={styles.yourAnswer}>{consentAnswer}</p>}

      {you.canVote ? (
        <fieldset className={styles.vote} aria-describedby="vote-quorum">
          <legend>Your vote</legend>
          <div className="row">
            {VOTE_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={`btn ${you.vote === choice ? 'btn-primary' : ''}`}
                aria-pressed={you.vote === choice}
                aria-disabled={working || undefined}
                aria-busy={(busy === 'vote' && you.vote !== choice) || undefined}
                onClick={() => {
                  if (!working) onVote(choice);
                }}
              >
                {VOTE_LABEL[choice]}
              </button>
            ))}
          </div>
          <p className="faint">
            {you.vote === undefined
              ? 'One vote each. You can change it until the vote closes.'
              : `Your vote: ${VOTE_LABEL[you.vote]}. You can change it until the vote closes.`}
          </p>
          <p id="vote-quorum" className="faint">
            {quorumLine(detail.eligibleCount)}
          </p>
          <p className="faint">Votes are public: your name shows next to your vote after the close.</p>
        </fieldset>
      ) : (
        you.vote !== undefined && <p className={styles.yourAnswer}>You voted {VOTE_LABEL[you.vote]}.</p>
      )}

      {you.canEdit &&
        (editing ? (
          <form className={styles.form} onSubmit={saveEdit} noValidate aria-label="Edit your proposal">
            <ProposalFields
              idPrefix="edit"
              title={title}
              pitch={pitch}
              onTitle={setTitle}
              onPitch={setPitch}
              errors={editErrors}
              pitchMax={pitchMax}
              readOnly={working}
            />
            <div className="row">
              <button type="submit" className="btn btn-primary" aria-disabled={working || undefined} aria-busy={busy === 'edit' || undefined}>
                <Busy when={busy === 'edit'} idle="Save changes" working="Saving…" />
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-disabled={working || undefined}
                onClick={() => {
                  if (working) return;
                  setEditing(false);
                  setEditErrors({});
                  focusNext('edit-open');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.action}>
            <p className="muted">You can edit it until someone seconds it.</p>
            <div className="row">
              <button
                id="edit-open"
                type="button"
                className="btn"
                aria-disabled={working || undefined}
                onClick={opening(() => {
                  setTitle(proposal.title);
                  setPitch(detail.pitch);
                  setEditing(true);
                }, 'edit-title')}
              >
                Edit
              </button>
            </div>
          </div>
        ))}

      {you.canWithdraw &&
        (withdrawing ? (
          <div className={styles.confirm} role="group" aria-labelledby="withdraw-question">
            <p id="withdraw-question">
              Withdraw this proposal? It leaves the floor for good and keeps its record. You can bring another
              afterwards.
            </p>
            <div className="row">
              <button
                id="withdraw-yes"
                type="button"
                className="btn"
                aria-disabled={working || undefined}
                aria-busy={busy === 'withdraw' || undefined}
                onClick={() => {
                  if (working) return;
                  void onWithdraw().then((done) => {
                    if (done) setWithdrawing(false);
                  });
                }}
              >
                <Busy when={busy === 'withdraw'} idle="Yes, withdraw it" working="Withdrawing…" />
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-disabled={working || undefined}
                onClick={() => {
                  if (working) return;
                  setWithdrawing(false);
                  focusNext('withdraw-open');
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              id="withdraw-open"
              type="button"
              className="btn btn-ghost"
              aria-disabled={working || undefined}
              onClick={opening(() => {
                setWithdrawing(true);
              }, 'withdraw-yes')}
            >
              Withdraw
            </button>
            <span className="faint">You can withdraw it until it&apos;s decided.</span>
          </div>
        ))}

      {nothing && (
        <p className="muted">
          {proposal.state === 'debate' || proposal.state === 'voting'
            ? 'Only the members counted when it was seconded can consent, object or vote on it. Anyone signed in can still comment below.'
            : proposal.state === 'submitted'
              ? 'Nothing for you to do here until someone seconds it.'
              : 'It has been decided, so there is nothing left to do here.'}
        </p>
      )}
    </>
  );
}
