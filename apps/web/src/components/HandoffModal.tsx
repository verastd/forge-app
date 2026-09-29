'use client';

/**
 * The guided handoff (PRD I.3): three taps and a paste — or, for Claude Code
 * with a short enough prompt (v0.2 PRD addendum), one tap: `claudeCodePrefillUrl`
 * hands it the whole task already typed in, so opening it IS the handoff and
 * the copy box becomes the secondary, optional path.
 *
 * Claude Code and Codex have no third-party session API, so the honest product
 * is a numbered set of instructions about *the contributor's agent app* — never
 * about git — plus the compiled prompt and a button that opens the agent.
 */

import type { DispatchResult, Rail } from '@forge/shared';

import { CopyBox } from './CopyBox';
import { Modal } from './Modal';
import { useSession } from './SessionProvider';
import { claudeCodePrefillUrl, RAIL_INFO } from '../lib/rails';

/**
 * Claude Code's opening lines when the prompt is too long to prefill. The
 * server's own first line promises the task already typed in, which only the
 * prefill link delivers, so these copy/paste lines stand in for its first two.
 * Web-only: only this screen knows whether the link fit.
 */
const CLAUDE_CODE_PASTE_LINES: readonly string[] = [
  'Tap Copy to put the whole task on your clipboard.',
  'Tap Open Claude Code, pick your own copy of the app, paste the task and send it. It runs on your own plan.',
];

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
  const { session } = useSession();
  const login = session && !session.demo ? session.login : null;
  // Only Claude Code has a prefill link; null here also covers "too long",
  // which the render below treats the same as "no prefill link at all".
  const prefillUrl =
    rail === 'claude-code' ? claudeCodePrefillUrl(result.compiledPrompt, login) : null;
  const instructions =
    rail === 'claude-code' && prefillUrl === null
      ? [...CLAUDE_CODE_PASTE_LINES, ...result.instructions.slice(2)]
      : result.instructions;

  const copyBox = <CopyBox label="The task, ready to paste" text={result.compiledPrompt} />;

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
          {instructions.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>

        {prefillUrl !== null ? (
          <>
            {/* Primary: nothing to copy, so the tap that opens the agent leads. */}
            <div className="row">
              <a
                className="btn btn-primary"
                href={prefillUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {info.label}
              </a>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Done for now
              </button>
            </div>

            {/* Secondary: still here for anyone who'd rather paste it by hand. */}
            {copyBox}
          </>
        ) : (
          <>
            {/* Today's behaviour: copying the prompt is the only way in, so it leads. */}
            {copyBox}

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
          </>
        )}
      </div>
    </Modal>
  );
}
