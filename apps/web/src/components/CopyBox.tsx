'use client';

/**
 * Text with a Copy button. The handoff rails live or die on this control: the
 * contributor's whole job is copy, open the agent, paste (PRD I.3).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function CopyBox({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const copy = useCallback(() => {
    const done = () => {
      setCopied(true);
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    };
    // Clipboard access can be denied (insecure origin, permissions); the text
    // is on screen and selectable either way, so failure is not fatal.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      done();
      return;
    }
    void clipboard.writeText(text).then(done, done);
  }, [text]);

  return (
    <div className="copybox">
      <div className="copybox-head">
        <span className="copybox-label">{label}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
