import Link from 'next/link';
import type { TaskCard as TaskCardType } from '@forge/shared';

import { Chip } from './Chip';
import { SIZE_LABEL, rewardLabel, tierFloorLabel } from '../lib/format';

/**
 * A task card (PRD I.2, Browse row). The plain-language summary is the
 * headline; the engineering title is a footnote for the curious.
 */
export function TaskCard({ task }: { task: TaskCardType }) {
  const reward = rewardLabel(task.rewardClass, task.rewardUsd);
  const claimed = task.status === 'claimed';

  return (
    <Link
      href={`/contribute/task/${task.id}`}
      className={`card card-link ${claimed ? 'task-card-claimed' : ''}`}
    >
      <article className="task-card">
        <div>
          <h3 className="task-summary">{task.civilianSummary}</h3>
          <p className="task-title">{task.title}</p>
        </div>
        <div className="task-chips">
          <Chip>{SIZE_LABEL[task.size]}</Chip>
          {reward !== null && <Chip tone="accent">{reward}</Chip>}
          <Chip>{tierFloorLabel(task.tierFloor)}</Chip>
          {claimed && (
            <Chip tone="warn">
              {task.claimedBy === 'you' ? 'yours right now' : 'someone is on it'}
            </Chip>
          )}
        </div>
      </article>
    </Link>
  );
}
