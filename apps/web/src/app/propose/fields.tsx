'use client';

/**
 * Text fields with a character counter, for everything a member writes on
 * the Propose screens: a proposal's title and pitch, a comment, an
 * objection's reason, and the admin's draft task.
 *
 * The counter counts what the API counts (`textLength`: Unicode code points),
 * so there is deliberately no `maxLength` attribute, which counts UTF-16
 * units and would cut emoji text short of the real limit. Going over is
 * shown, and checked before anything is sent.
 *
 * While what was written is being sent, a field is `readOnly`, not
 * `disabled`: a disabled field would throw keyboard focus out of the page.
 */

import { PROPOSAL_LIMITS } from '@forge/shared';

import { adminPitchNote, counterText, overLimit } from '../../lib/proposals-format';
import styles from './propose.module.css';

export function CountedField({
  id,
  label,
  help,
  value,
  onChange,
  max,
  error,
  multiline = false,
  rows = 4,
  readOnly = false,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  error?: string | undefined;
  multiline?: boolean;
  rows?: number;
  /** Sending: the text can't change, and the field keeps focus. */
  readOnly?: boolean;
}) {
  const helpId = `${id}-help`;
  const counterId = `${id}-count`;
  const errorId = `${id}-error`;
  const describedBy = [help === undefined ? null : helpId, error === undefined ? null : errorId, counterId]
    .filter((part): part is string => part !== null)
    .join(' ');
  const common = {
    id,
    value,
    readOnly,
    'aria-describedby': describedBy,
    'aria-invalid': error === undefined ? undefined : true,
    className: `text-input ${styles.input}`,
  } as const;

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {help !== undefined && (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      )}
      {multiline ? (
        <textarea
          {...common}
          rows={rows}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      ) : (
        <input
          {...common}
          type="text"
          autoComplete="off"
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
      <div className={styles.fieldFoot}>
        {error === undefined ? (
          <span />
        ) : (
          <p id={errorId} className={styles.fieldError}>
            {error}
          </p>
        )}
        <span id={counterId} className={`${styles.counter} ${overLimit(value, max) ? styles.counterOver : ''}`}>
          {counterText(value, max)}
        </span>
      </div>
    </div>
  );
}

/**
 * A proposal's title and pitch: the new-proposal form and the mover's edit.
 * `pitchMax` is the most the writer may send (`pitchLimit`, from what the API
 * says of them: an admin's is longer), which the counter shows.
 */
export function ProposalFields({
  idPrefix,
  title,
  pitch,
  onTitle,
  onPitch,
  errors,
  pitchMax,
  readOnly = false,
}: {
  idPrefix: string;
  title: string;
  pitch: string;
  onTitle: (value: string) => void;
  onPitch: (value: string) => void;
  errors: Partial<Record<'title' | 'pitch', string>>;
  pitchMax: number;
  readOnly?: boolean;
}) {
  const adminNote = adminPitchNote(pitchMax);
  return (
    <>
      <CountedField
        id={`${idPrefix}-title`}
        label="Title"
        help="A short name for the idea."
        value={title}
        onChange={onTitle}
        max={PROPOSAL_LIMITS.title}
        error={errors.title}
        readOnly={readOnly}
      />
      <CountedField
        id={`${idPrefix}-pitch`}
        label="Your pitch"
        help={`Say what FORGE should build and why it matters, in plain English. Plain text: line breaks stay, formatting doesn't.${adminNote === null ? '' : ` ${adminNote}`}`}
        value={pitch}
        onChange={onPitch}
        max={pitchMax}
        error={errors.pitch}
        multiline
        rows={10}
        readOnly={readOnly}
      />
    </>
  );
}
