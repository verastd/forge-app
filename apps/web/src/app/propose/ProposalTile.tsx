'use client';

/**
 * One proposal on the floor: its title, who moved (and seconded) it, its
 * state, and its deadline as a countdown.
 *
 * The title is the link, and its hit area is stretched over the whole card,
 * so the card opens from anywhere while the link's name stays the title: a
 * link wrapped around the card would be named from all of its text, or, with
 * an article inside it, from none of it.
 */

import Link from 'next/link';
import type { ProposalCard } from '@forge/shared';

import { Chip } from '../../components/Chip';
import { formatDate } from '../../lib/format';
import { STATE_LABEL, STATE_TONE } from '../../lib/proposals-format';
import { DeadlineCountdown } from './Countdown';
import styles from './propose.module.css';

function count(value: number, one: string): string {
  return `${value} ${value === 1 ? one : `${one}s`}`;
}

/** `paused`: the floor is paused, so the card's deadline isn't running. */
export function ProposalTile({ card, paused = false }: { card: ProposalCard; paused?: boolean }) {
  return (
    <article className={`card card-link ${styles.tile}`}>
      <div className={styles.tileHead}>
        <span className={styles.tileId}>Motion · #{card.id}</span>
        <Chip tone={STATE_TONE[card.state]}>{STATE_LABEL[card.state]}</Chip>
      </div>
      <h3 className={styles.tileTitle}>
        <Link id={`motion-${card.id}`} href={`/propose/${card.id}`} className={styles.tileLink}>
          {card.title}
        </Link>
      </h3>
      <p className={styles.tileMeta}>
        Moved by <strong>{card.mover}</strong> on {formatDate(card.movedAt)}
        {card.seconder !== undefined && (
          <>
            , seconded by <strong>{card.seconder}</strong>
          </>
        )}
      </p>
      <div className={styles.tileFoot}>
        <DeadlineCountdown state={card.state} deadline={card.deadline} paused={paused} />
        <span className="faint">
          {count(card.commentCount, 'comment')}
          {card.objectionCount > 0 && ` · ${count(card.objectionCount, 'objection')}`}
        </span>
      </div>
    </article>
  );
}
