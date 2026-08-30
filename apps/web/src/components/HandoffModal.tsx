'use client';

/**
 * The guided handoff (PRD I.3): three taps and a paste.
 *
 * Claude Code and Codex have no third-party session API, so the honest product
 * is a numbered set of instructions about *the contributor's agent app* — never
 * about git — plus the compiled prompt and a button that opens the agent.
 */

import type { DispatchResult, Rail } from '@forge/shared';

import { CopyBox } from './CopyBox';
import { Modal } from './Modal';
import { RAIL_INFO } from '../lib/rails';

export function HandoffModal({
  rail,
  result,
  preview,
  onClose,
}: {
  rail: Rail;
  result: DispatchResult;
  /** True when the prompt was composed here because the server was unreachable. */
  preview: boolean;
  onClose: () => void;
}) {
  const info = RAIL_INFO[rail];
  const deepLink = result.deepLink ?? info.deepLink;

  return (
    <Modal title={`Hand this to ${info.label}`} onClose={onClose}>
      <div className="stack">
        <p className="muted">
          {info.label} does the work in your own copy of the app. You only have to pass it the
          task.
        </p>

        {preview && (
          <p className="faint">
            Preview: we put this together on your device because we could not reach the FORGE
            service just now. The wording is the same one we send.
          </p>
        )}

        <ol className="steps">
          {result.instructions.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>

        <CopyBox label="The task, ready to paste" text={result.compiledPrompt} />

        <div className="row">
          {deepLink !== undefined && (
            <a
              className="btn btn-primary"
              href={deepLink}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open {info.label}
            </a>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Done for now
          </button>
        </div>
      </div>
    </Modal>
  );
}
