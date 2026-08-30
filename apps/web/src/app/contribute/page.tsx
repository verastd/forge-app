'use client';

/**
 * The Bridge home — Browse (PRD I.2).
 *
 * Plain-language task cards rendered from the same tasks the GitHub-native
 * client sees. The Bridge is a client, never a bypass (PRD §4.9 invariant 1).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SIZES } from '@forge/shared';
import type { Size, TaskCard as TaskCardType } from '@forge/shared';

import { FilterChip } from '../../components/Chip';
import { TaskCard } from '../../components/TaskCard';
import { fetchTasks } from '../../lib/api';
import { SIZE_FILTER_LABEL } from '../../lib/format';

type Filter = 'all' | Size | 'reward';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  ...SIZES.map((size) => ({ value: size as Filter, label: SIZE_FILTER_LABEL[size] })),
  { value: 'reward', label: 'Has a reward' },
];

export default function ContributePage() {
  const [tasks, setTasks] = useState<TaskCardType[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchTasks()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setTasks(result.data);
        setLoading(false);
      })
      .catch(() => {
        // Live: an empty board is the truth. Fixtures here would invent tasks
        // that nobody can actually claim.
        if (cancelled) {
          return;
        }
        setTasks([]);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const visible = useMemo(() => {
    if (filter === 'all') {
      return tasks;
    }
    if (filter === 'reward') {
      return tasks.filter((task) => task.rewardClass !== 'none');
    }
    return tasks.filter((task) => task.size === filter);
  }, [tasks, filter]);

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Help build FORGE</h1>
        <p className="lede">
          Point the coding agent you already pay for at a task. Your tokens, our checks, everyone&apos;s
          app.
        </p>
      </div>

      <div className="row" role="group" aria-label="Filter tasks">
        {FILTERS.map((option) => (
          <FilterChip
            key={option.value}
            active={filter === option.value}
            onClick={() => {
              setFilter(option.value);
            }}
          >
            {option.label}
          </FilterChip>
        ))}
      </div>

      {loading ? (
        <div className="card">
          <div className="stack">
            <div className="skeleton" style={{ width: '40%' }} />
            <div className="skeleton" style={{ width: '70%' }} />
            <div className="skeleton" style={{ width: '55%' }} />
          </div>
        </div>
      ) : failed ? (
        <div className="card stack" role="alert">
          <h2 className="section-title">We can&apos;t show the tasks just now</h2>
          <p className="muted">
            The list would not load, so we are not showing you one. Nothing on your side has gone
            wrong.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <div className="empty">
            Nothing matches that filter right now. Try &ldquo;All&rdquo; — new tasks land most weeks.
          </div>
        </div>
      ) : (
        <section className="grid" aria-label="Tasks">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </section>
      )}
    </main>
  );
}
