'use client';

/**
 * /propose/new: bring a proposal (Phase 5 contract §4). A title and a pitch
 * in plain English, each with a character count; sending it opens the new
 * proposal's page.
 *
 * Signed out, the middleware sends the visitor to /signin first. The practice
 * account gets the form, to try it, and is refused when it sends (a proposal
 * needs a GitHub member behind it), as the BFF refuses it on the build we
 * deploy. A member who already has a proposal on the floor is pointed at it
 * instead: the API refuses a second one (`one_active_proposal`) either way.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProposalMe } from '@forge/shared';

import { useSession } from '../../../components/SessionProvider';
import { useToast } from '../../../components/Toast';
import { isDemoMode } from '../../../lib/mode';
import { createProposal, failureOf, loadMe, mayHaveHappened } from '../../../lib/proposals';
import { checkProposal, describeProposalError, signInHref } from '../../../lib/proposals-format';
import { ProposalFields } from '../fields';
import { Loading, SwitchedOff, useProposalsFlag } from '../gate';
import styles from '../propose.module.css';

type FieldErrors = Partial<Record<'title' | 'pitch', string>>;

interface Problem {
  message: string;
  /** Where to go instead: your proposal already on the floor. */
  proposalId?: number;
}

export function NewProposalForm() {
  const flag = useProposalsFlag();
  const { session } = useSession();
  const router = useRouter();
  const toast = useToast();
  const practiceUser = session !== null && (isDemoMode() || session.demo);
  const identified = session !== null && !practiceUser;

  const [me, setMe] = useState<ProposalMe | null>(null);
  const [meSettled, setMeSettled] = useState(false);
  const [title, setTitle] = useState('');
  const [pitch, setPitch] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  /**
   * The form can be drawn on the server, and a click before the page has
   * come alive would submit it the browser's way, losing what was typed. So
   * the button waits for the page (it needs JavaScript to send anyway).
   */
  const [alive, setAlive] = useState(false);
  /** A refusal takes focus once it is on screen, so it is heard and the form is next. */
  const focusProblem = useRef(false);

  useEffect(() => {
    setAlive(true);
  }, []);

  useEffect(() => {
    if (problem === null || !focusProblem.current) return;
    focusProblem.current = false;
    document.getElementById('new-proposal-problem')?.focus();
  }, [problem]);

  useEffect(() => {
    if (!flag.on || !identified) {
      return;
    }
    let cancelled = false;
    void loadMe()
      .then((result) => {
        if (!cancelled) setMe(result);
      })
      .catch(() => {
        // The form still shows: the API checks one-at-a-time itself.
      })
      .finally(() => {
        if (!cancelled) setMeSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [flag.on, identified]);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (sending) return;
      setProblem(null);
      const checked = checkProposal({ title, pitch });
      if (!checked.ok) {
        setErrors(checked.errors);
        document.getElementById(checked.errors.title === undefined ? 'proposal-pitch' : 'proposal-title')?.focus();
        return;
      }
      setErrors({});
      setSending(true);
      void createProposal(checked.value)
        .then((id) => {
          toast.push('Your proposal is on the floor. It needs another member to second it.', 'ok');
          router.push(`/propose/${id}`);
        })
        .catch(async (error: unknown) => {
          const failure = failureOf(error);
          if (mayHaveHappened(error)) {
            // No answer is not a "no": if it landed, it is your proposal on the floor now.
            const landed = await loadMe().catch(() => null);
            focusProblem.current = true;
            setProblem({
              message: describeProposalError('upstream_timeout', 'create'),
              ...(landed?.activeProposalId === undefined ? {} : { proposalId: landed.activeProposalId }),
            });
            setSending(false);
            return;
          }
          if (failure.code === 'invalid_request' && failure.fields !== undefined) {
            const named: FieldErrors = {};
            for (const field of failure.fields) {
              if (/(^|\.)title$/.test(field)) named.title = describeProposalError({ code: 'invalid_request', fields: ['title'] }, 'create');
              if (/(^|\.)pitch$/.test(field)) named.pitch = describeProposalError({ code: 'invalid_request', fields: ['pitch'] }, 'create');
            }
            setErrors(named);
          }
          focusProblem.current = true;
          setProblem({
            message: describeProposalError(failure, 'create'),
            ...(failure.proposalId === undefined ? {} : { proposalId: failure.proposalId }),
          });
          setSending(false);
        });
    },
    [pitch, router, sending, title, toast],
  );

  const heading = (
    <div>
      <Link href="/propose" className="faint">
        ← The floor
      </Link>
      <h1 className="page-title" style={{ marginTop: 10 }}>
        Bring a proposal
      </h1>
      <p className="lede">
        Say what FORGE should build and why it matters, in plain English. Another member has to second it
        before the floor debates it.
      </p>
    </div>
  );

  if (session === null) {
    // The middleware sends signed-out visitors to /signin before they get here.
    return (
      <main className="page stack-lg">
        {heading}
        <p>
          <Link href={signInHref('/propose/new')} className="btn btn-primary">
            Sign in to bring a proposal
          </Link>
        </p>
      </main>
    );
  }

  if (flag.loading || (flag.on && identified && !meSettled)) {
    return (
      <main className="page stack-lg">
        {heading}
        <Loading text="Getting the form ready…" />
      </main>
    );
  }

  if (!flag.on) {
    return (
      <main className="page stack-lg">
        {heading}
        <SwitchedOff />
      </main>
    );
  }

  if (me?.activeProposalId !== undefined) {
    return (
      <main className="page stack-lg">
        {heading}
        <div className={`card stack ${styles.onFloor}`}>
          <p>
            <strong>You have a proposal on the floor.</strong> One at a time: once it&apos;s decided, you can
            bring another.
          </p>
          <p>
            <Link href={`/propose/${me.activeProposalId}`} className="btn">
              See your proposal
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="page stack-lg">
      {heading}
      {practiceUser && (
        <p className="demo-banner">
          Practice: try the form, but only a GitHub member can put a proposal on the floor. Nothing is saved.
        </p>
      )}
      <form className={`card ${styles.form}`} onSubmit={submit} noValidate aria-describedby="proposal-rules">
        <ProposalFields
          idPrefix="proposal"
          title={title}
          pitch={pitch}
          onTitle={setTitle}
          onPitch={setPitch}
          errors={errors}
          readOnly={sending}
        />
        <p id="proposal-rules" className="faint">
          You can edit it until someone seconds it, and withdraw it until it&apos;s decided. Everything on the
          floor is public, your name included.
        </p>
        {problem !== null && (
          <div id="new-proposal-problem" tabIndex={-1} className={styles.problem} role="alert">
            <p>{problem.message}</p>
            {problem.proposalId !== undefined && (
              <Link href={`/propose/${problem.proposalId}`} className={styles.inlineLink}>
                See your proposal
              </Link>
            )}
          </div>
        )}
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!alive}
            aria-disabled={sending || undefined}
            aria-busy={sending || undefined}
          >
            {sending && <span className="spinner" aria-hidden="true" />}
            {sending ? 'Putting it on the floor…' : 'Put it on the floor'}
          </button>
          <Link href="/propose" className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
