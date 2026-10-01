'use client';

/**
 * The connector URL with its Copy button: the one thing on /connect anyone
 * copies, once per agent. The address stays on screen and selectable either
 * way, so a clipboard the browser refuses (an insecure origin, a denied
 * permission) costs a manual copy, never the address itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './connect.module.css';

type CopyState = 'idle' | 'copied' | 'failed';

const ANNOUNCE: Readonly<Record<CopyState, string>> = {
  idle: '',
  copied: 'Connector URL copied.',
  failed: 'Couldn’t copy. Select the address and copy it yourself.',
};

export function CopyUrl({ url }: { url: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    const settle = (next: CopyState): void => {
      setState(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setState('idle');
      }, 2500);
    };
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      settle('failed');
      return;
    }
    clipboard.writeText(url).then(
      () => {
        settle('copied');
      },
      () => {
        settle('failed');
      },
    );
  }, [url]);

  return (
    <div className="stack">
      <div className={styles.urlBox}>
        <code className={styles.url} data-testid="connector-url">
          {url}
        </code>
        <button
          type="button"
          className={state === 'copied' ? `btn btn-primary ${styles.copied}` : 'btn btn-primary'}
          aria-label="Copy the connector URL"
          onClick={copy}
        >
          {state === 'copied' ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <p className={state === 'failed' ? 'muted' : 'visually-hidden'} role="status" aria-live="polite">
        {ANNOUNCE[state]}
      </p>
    </div>
  );
}
