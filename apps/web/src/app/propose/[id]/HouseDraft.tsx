'use client';

/**
 * The house model's draft of a passed proposal's task (Phase 6 contract §10).
 *
 * An admin sees it in the admin panel, above the draft task's form: why the
 * house model is off, that it will draft the task or is drafting it (the page
 * reads the proposal again every 5 s meanwhile: `ProposalView`), why its
 * draft failed, or the draft's verdict, questions, risks and scope, with who
 * drafted it and when. Then where its draft is, worked out by comparing it
 * with the form and the saved draft (`housePlace`): in both, in the form only
 * (unsaved), or not in the form, when "Use the house draft" puts it there
 * without saving, and "Undo" puts back the unsaved changes it replaced.
 * "Draft it again" asks for a new draft behind a confirm step, unless one is
 * under way or the house model is off. Once the task is published the block
 * stays, read-only. Members never see it: the page renders it only inside the
 * admin panel, which shows only when the API says you are an admin, and the
 * API sends `house` to admins only.
 *
 * The practice app (no admins there) shows the block on its own card,
 * marked as practice, with the task the house drafted, since there is no
 * form for it to fill.
 *
 * Everything in a spec is model output, cleaned by the API: rendered as text,
 * each path's segments isolated so right-to-left letters can't reorder them,
 * and a model name of any length cut short. Focus follows the Phase 5 rules
 * (`./problem`): opening the confirm step moves focus into it, "Not yet"
 * gives it back, a write's outcome takes it. "Use the house draft" moves it to
 * the block's status line (never into the form, where Enter saves), and
 * "Undo" back to "Use the house draft".
 *
 * Screen readers hear the block's two live regions, each always on the page:
 * its status line beside the form, and a hidden line said once drafting
 * stops. The start of drafting is said where it was asked for (the admin's
 * outcome line), so the drafting line itself is not a live region.
 */

import { Fragment, useState } from 'react';
import type { HouseDraft, HouseSpec } from '@forge/shared';

import { Chip } from '../../../components/Chip';
import { SIZE_FILTER_LABEL } from '../../../lib/format';
import {
  HOUSE_VERDICT_LABEL,
  HOUSE_VERDICT_TONE,
  houseDraftedLine,
  houseFormWords,
  houseStatusLine,
  isHouseWorking,
} from '../../../lib/proposals-format';
import type { HousePlace, ProposalAction } from '../../../lib/proposals-format';
import styles from '../propose.module.css';
import { Busy, useFocusNext } from './problem';

/**
 * Where the block is: beside the draft task's form (`edit`), after the task
 * is published (`read`: no buttons), or in the practice app (`practice`).
 */
export type HouseMode = 'edit' | 'read' | 'practice';

/** The block's status line beside the form: focus goes there after "Use the house draft". */
export const HOUSE_STATUS_ID = 'house-status';
/** "Use the house draft": focus comes back to it after "Undo". */
export const HOUSE_USE_ID = 'house-use';

/** Beside the draft task's form: where the house's draft is, and what the block may do to the form. */
export interface HouseForm extends HousePlace {
  /** The admin has changed the form since it was last filled. */
  edited: boolean;
  /** "Use the house draft": put it in the form, unsaved. */
  onUse: () => void;
  /** "Undo": put back the unsaved changes "Use the house draft" replaced; offered only while it can. */
  onUndo?: (() => void) | undefined;
}

/** Said once the house model stops drafting while the page is open, for a screen reader. */
const LANDED: Readonly<Record<'done' | 'other', string>> = {
  done: 'The house model has drafted it: its draft is below.',
  other: 'The house model stopped drafting: the reason is below.',
};

export function HouseDraftBlock({
  house,
  mode,
  busy,
  unchecked = false,
  form,
  onDraftAgain,
}: {
  house: HouseDraft;
  mode: HouseMode;
  busy: ProposalAction | null;
  /** The page can't read the proposal just now, so it can't check on the drafting: said while it drafts. */
  unchecked?: boolean;
  /** Beside the draft task's form (`edit`). Without it (no form), the block says nothing of one. */
  form?: HouseForm | undefined;
  /** "Draft it again": true once the API has taken it. */
  onDraftAgain?: () => Promise<boolean>;
}) {
  const working = isHouseWorking(house.status);
  const writing = busy !== null;
  const line = houseStatusLine(house);
  const spec = house.spec;
  const applied = house.appliedToDraft === true;
  const words = mode === 'edit' && spec !== undefined && form !== undefined ? houseFormWords(form, applied, form.edited) : null;

  // A polite word once drafting stops while the page is open (the drafting line itself goes away).
  const [wasWorking, setWasWorking] = useState(working);
  const [landed, setLanded] = useState('');
  if (wasWorking !== working) {
    setWasWorking(working);
    setLanded(working ? '' : house.status === 'done' ? LANDED.done : LANDED.other);
  }

  return (
    <div className={styles.house}>
      <p className="visually-hidden" role="status">
        {landed}
      </p>
      {working && (
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          {line}
        </p>
      )}
      {working && unchecked && (
        <p className="faint">Couldn&apos;t check on the house model&apos;s draft. Trying again every minute.</p>
      )}
      {!working && line !== null && (
        <p className={house.status === 'failed' ? styles.houseProblem : 'muted'}>{line}</p>
      )}

      {!working && spec !== undefined && <SpecDetails house={house} spec={spec} mode={mode} />}

      {!working && form !== undefined && words !== null && (
        <div className={styles.houseForm}>
          {words.line !== null && <p>{words.line}</p>}
          {/* Always here while the draft shows, empty and out of sight until it has something to say. */}
          <div className={words.status === '' ? styles.houseUseIdle : styles.houseUse}>
            <p
              id={HOUSE_STATUS_ID}
              role="status"
              tabIndex={-1}
              className={words.status === '' ? 'visually-hidden' : `${styles.outcome} ${styles.houseStatus}`}
            >
              {words.status}
            </p>
            {words.status !== '' && form.onUndo !== undefined && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-disabled={writing || undefined}
                onClick={() => {
                  if (!writing) form.onUndo?.();
                }}
              >
                Undo
              </button>
            )}
          </div>
          {words.offerUse && (
            <div className="row">
              <button
                id={HOUSE_USE_ID}
                type="button"
                className="btn"
                aria-disabled={writing || undefined}
                onClick={() => {
                  if (!writing) form.onUse();
                }}
              >
                Use the house draft
              </button>
            </div>
          )}
        </div>
      )}

      {!working && spec !== undefined && mode === 'read' && (
        <p className="muted">
          {applied ? 'Its draft filled the draft task.' : "The draft had already been saved, so it wasn't replaced."}
        </p>
      )}

      {!working && spec !== undefined && mode === 'practice' && <PracticeTask spec={spec} />}

      {/* While it is off, asking would only be refused: "Write the draft yourself" is the way. */}
      {mode === 'edit' && !working && house.status !== 'off' && onDraftAgain !== undefined && (
        <DraftAgain busy={busy} onDraftAgain={onDraftAgain} />
      )}
    </div>
  );
}

/** The verdict, the mover's questions, the risks and the scope, then who drafted it and when. */
function SpecDetails({ house, spec, mode }: { house: HouseDraft; spec: HouseSpec; mode: HouseMode }) {
  const drafted = houseDraftedLine(house);
  const Heading = mode === 'practice' ? 'h3' : 'h4';
  return (
    <>
      <div className={styles.houseVerdict}>
        <Chip tone={HOUSE_VERDICT_TONE[spec.verdict]}>{HOUSE_VERDICT_LABEL[spec.verdict]}</Chip>
        <p>{spec.verdictReason}</p>
      </div>
      {spec.questions.length > 0 && (
        <HouseList id="house-questions" title="Questions for the mover" items={spec.questions} Heading={Heading} />
      )}
      <HouseList id="house-risks" title="Risks" items={spec.risks} empty="None noted." Heading={Heading} />
      <HouseList id="house-scope-in" title="Scope in" items={spec.scopeIn} empty="No paths named." paths Heading={Heading} />
      <HouseList id="house-scope-out" title="Scope out" items={spec.scopeOut} empty="No paths named." paths Heading={Heading} />
      {drafted !== null && <p className="faint">{drafted}</p>}
    </>
  );
}

function HouseList({
  id,
  title,
  items,
  empty,
  paths = false,
  Heading,
}: {
  id: string;
  title: string;
  items: readonly string[];
  /** Said when the list is empty; without it, an empty list isn't shown. */
  empty?: string;
  /** Repo paths or globs, shown as code. */
  paths?: boolean;
  Heading: 'h3' | 'h4';
}) {
  if (items.length === 0 && empty === undefined) return null;
  return (
    <div className={styles.houseSection}>
      <Heading id={id} className={styles.houseHeading}>
        {title}
      </Heading>
      {items.length === 0 ? (
        <p className="faint">{empty}</p>
      ) : (
        <ul className={styles.houseList} aria-labelledby={id}>
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{paths ? <RepoPath path={item} /> : item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A repo path, left to right, each segment isolated (`<bdi>`): right-to-left
 * letters in one segment can't swap it with its neighbours.
 */
function RepoPath({ path }: { path: string }) {
  return (
    <code className={styles.housePath} dir="ltr">
      {path.split('/').map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && '/'}
          <bdi>{segment}</bdi>
        </Fragment>
      ))}
    </code>
  );
}

/** In the practice app there is no form for the draft to fill, so the block shows the task it drafted. */
function PracticeTask({ spec }: { spec: HouseSpec }) {
  return (
    <div className={styles.houseSection}>
      <h3 id="house-task" className={styles.houseHeading}>
        The task it drafted
      </h3>
      <p className={styles.houseTaskTitle}>{spec.title}</p>
      <p className="muted">{spec.civilianSummary}</p>
      <p className={styles.houseHeading} id="house-criteria">
        What done means
      </p>
      <ol className={styles.houseList} aria-labelledby="house-criteria">
        {spec.acceptanceCriteria.map((criterion, index) => (
          <li key={`${index}-${criterion}`}>{criterion}</li>
        ))}
      </ol>
      <p className="faint">
        Size {spec.size} · {SIZE_FILTER_LABEL[spec.size]}
      </p>
    </div>
  );
}

/** "Draft it again", behind a confirm step. */
function DraftAgain({ busy, onDraftAgain }: { busy: ProposalAction | null; onDraftAgain: () => Promise<boolean> }) {
  const focusNext = useFocusNext();
  const [confirming, setConfirming] = useState(false);
  const writing = busy !== null;

  if (confirming) {
    return (
      <div className={styles.confirm} role="group" aria-labelledby="house-again-question">
        <p id="house-again-question">
          Draft it again? The house model writes a new draft from the proposal and its debate. It replaces the
          draft task only if nobody has saved it yet.
        </p>
        <div className="row">
          <button
            id="house-again-yes"
            type="button"
            className="btn"
            aria-disabled={writing || undefined}
            aria-busy={busy === 'house_draft' || undefined}
            onClick={() => {
              if (writing) return;
              void onDraftAgain().then((done) => {
                if (done) setConfirming(false);
              });
            }}
          >
            <Busy when={busy === 'house_draft'} idle="Yes, draft it again" working="Asking the house model…" />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            aria-disabled={writing || undefined}
            onClick={() => {
              if (writing) return;
              setConfirming(false);
              focusNext('house-again-open');
            }}
          >
            Not yet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="row">
      <button
        id="house-again-open"
        type="button"
        className="btn"
        aria-disabled={writing || undefined}
        onClick={() => {
          if (writing) return;
          setConfirming(true);
          focusNext('house-again-yes');
        }}
      >
        Draft it again
      </button>
    </div>
  );
}

/**
 * The practice app's house card: what an admin would see once a sample has
 * passed. Nobody is an admin there, so it is shown to everyone, and says so.
 */
export function PracticeHouse({ house }: { house: HouseDraft }) {
  return (
    <section className="card stack" aria-labelledby="house-title">
      <h2 id="house-title" className="section-title">
        House draft
      </h2>
      <p className={styles.practiceNote}>
        Practice: on the live floor only FORGE&apos;s admins see this, and they check every line of its draft before
        it goes on the Contribute board.
      </p>
      <HouseDraftBlock house={house} mode="practice" busy={null} />
    </section>
  );
}
