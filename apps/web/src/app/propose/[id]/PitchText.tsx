'use client';

/**
 * A proposal's pitch on its page: plain text, line breaks kept, never HTML.
 *
 * A pitch a member may write (up to 4,000 characters) shows whole. An
 * admin's may run to 50,000, which would push the rest of the page (where it
 * stands, your part, the debate) out of reach, so it opens with its first
 * 4,000 characters (`pitchOpening`) and a button that shows the rest in place
 * and folds it again. The button names how long the whole pitch is, says
 * whether it is open (`aria-expanded`), and keeps focus as it changes. Its
 * label wraps on a narrow screen. While the pitch is open the button stays at
 * the bottom of the screen for as long as the pitch is in view, so it can be
 * folded from anywhere in it, not only from its end; folding it brings the
 * button back into view, since it moves up the page.
 */

import { useRef, useState } from 'react';

import { pitchOpening, pitchToggleText } from '../../../lib/proposals-format';
import styles from '../propose.module.css';

export function PitchText({ pitch }: { pitch: string }) {
  const [whole, setWhole] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const opening = pitchOpening(pitch);
  if (opening === null) return <p className={styles.pitch}>{pitch}</p>;
  return (
    <>
      <p id="pitch-text" className={styles.pitch}>
        {whole ? pitch : opening.text}
      </p>
      <div className={whole ? `row ${styles.pitchToggleOpen}` : 'row'}>
        <button
          ref={button}
          type="button"
          className={`btn ${styles.pitchToggle}`}
          aria-expanded={whole}
          aria-controls="pitch-text"
          onClick={() => {
            setWhole(!whole);
            if (whole) {
              requestAnimationFrame(() => {
                button.current?.scrollIntoView({ block: 'nearest' });
              });
            }
          }}
        >
          {pitchToggleText(opening.total, whole)}
        </button>
      </div>
    </>
  );
}
