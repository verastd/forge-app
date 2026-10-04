'use client';

import Link from 'next/link';
import type { TaskCard as TaskCardType } from '@forge/shared';

import { Chip } from './Chip';
import { useSession } from './SessionProvider';
import { DEMO_IDENTITY } from '../lib/fixtures';
import { SIZE_LABEL, rewardLabel, tierFloorLabel } from '../lib/format';
import { isDemoMode } from '../lib/mode';

/**
 * A task card (PRD I.2, Browse row). The plain-language summary is the
 * headline; the engineering title is a footnote for the curious.
 *
 * `claimedBy` is the holder's GitHub login, so "yours" means the signed-in
 * login (the practice account's stand-in in the practice app).
 *
 * The summary is the link, and its hit area is stretched over the whole card
 * (`card-stretch`), so the card opens from anywhere while the link's name
 * stays the summary: a link wrapped around an `<article>` gets no name from
 * its content at all, so a screen reader would announce it as just "link".
 */
export function TaskCard({ task }: { task: TaskCardType }) {
  const { session } = useSession();
  const reward = rewardLabel(task.rewardClass, task.rewardUsd);
  const claimed = task.status === 'claimed';
  const me = isDemoMode() || session?.demo === true ? DEMO_IDENTITY : (session?.login ?? null);
  const mine = claimed && me !== null && task.claimedBy?.toLowerCase() === me.toLowerCase();

  return (
    <article className={`card card-link task-card ${claimed ? 'task-card-claimed' : ''}`}>
      <p className="deed-head">
        <span className="deed-id">Deed · #{String(task.id).padStart(4, '0')}</span>
        {claimed ? (
          <span className="deed-held">Held</span>
        ) : (
          <span className="deed-open">Open</span>
        )}
      </p>
      <div>
        <h3 className="task-summary">
          <Link href={`/contribute/task/${task.id}`} className="card-stretch">
            {task.civilianSummary}
          </Link>
        </h3>
        <p className="task-title">{task.title}</p>
      </div>
      <div className="task-chips">
        <Chip>{SIZE_LABEL[task.size]}</Chip>
        {reward !== null && <Chip tone="accent">{reward}</Chip>}
        <Chip>{tierFloorLabel(task.tierFloor)}</Chip>
        {claimed && (
          <Chip tone="warn">
            {mine ? 'yours right now' : 'someone is on it'}
          </Chip>
        )}
      </div>
    </article>
  );
}
