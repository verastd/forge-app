'use client';

/**
 * The one line /propose shows a visitor who tapped an empty slot in the
 * lobby (`/propose?slot=<index>`): which slot it was, and that proposals are
 * coming. Nothing for a missing, malformed or out-of-range slot, or for a
 * slot an app already holds. Render it inside a Suspense boundary: it reads
 * the query string, and the rest of the page should still prerender.
 */

import { appAt, isSlotIndex, slotFromIndex } from '@forge/lobby';
import { useSearchParams } from 'next/navigation';

import styles from './ProposeSlotNote.module.css';

export function ProposeSlotNote() {
  const raw = useSearchParams().get('slot');
  if (raw === null || !/^\d{1,4}$/.test(raw)) {
    return null;
  }
  const slot = Number(raw);
  if (!isSlotIndex(slot) || appAt(slotFromIndex(slot)) !== undefined) {
    return null;
  }
  return (
    <p className={styles.note}>{`Slot ${slot} is free. Proposals open soon; this slot is where yours would go.`}</p>
  );
}
