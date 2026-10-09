'use client';

/**
 * One account: profile, trading and income (`/accounts/{account}`, market
 * layer) and its raw chain actions (`/accounts/{account}/actions`, cursor
 * feed, live), by role. Every account name in the UI links here.
 */

import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ACCOUNT_ROLES, AccountDetail, Action, LedgerClient } from '@forge/upland-ledger';
import { isAntelopeAccount } from '@forge/upland-ledger';

import { DataState } from '../../_components/DataState';
import { DataTable, LoadMore, TableSkeleton } from '../../_components/DataTable';
import { LayerNote } from '../../_components/Freshness';
import { LedgerSignIn } from '../../_components/LedgerSignIn';
import { TrxId, routes } from '../../_components/links';
import { Badge, ButtonLink, Skeleton, Segment, StatTile, StatusBanner } from '../../_components/primitives';
import { formatDay, formatDuration, formatInstant, formatInt, formatPercent, formatUpx, NONE } from '../../_lib/format';
import { useCursorFeed, useLedgerQuery } from '../../_lib/hooks';
import { describeError, queryKey } from '../../_lib/query-core';

type Role = (typeof ACCOUNT_ROLES)[number];
const ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'actor', label: 'Signed by' },
  { value: 'receiver', label: 'Received' },
  { value: 'notified', label: 'Notified' },
];
const ACTIONS_PAGE = 50;

export default function AccountPage() {
  const params = useParams<{ account: string }>();
  const account = decodeURIComponent(params?.account ?? '').toLowerCase();

  if (!isAntelopeAccount(account)) {
    return (
      <>
        <h1 className="em-h1">Account</h1>
        <div className="em-card em-state" role="alert">
          <span className="em-state-title">“{account}” isn’t an Upland chain account</span>
          <span>Chain accounts are up to 13 characters: a–z, 1–5 and dots.</span>
          <ButtonLink href={routes.overview} icon="arrow-left">
            Back to the overview
          </ButtonLink>
        </div>
      </>
    );
  }
  return <Account account={account} />;
}

function Account({ account }: { account: string }) {
  const profile = useLedgerQuery<AccountDetail>(`/accounts/${account}`, (c, signal) => c.accounts.get(account, undefined, { signal }));

  if (profile.view === 'unauthenticated') {
    return (
      <>
        <h1 className="em-h1 em-mono">{account}</h1>
        <LedgerSignIn onRetry={profile.refetch} />
      </>
    );
  }

  const a = profile.data;
  return (
    <>
      <div className="em-page-head">
        <div style={{ minWidth: 0 }}>
          <p className="em-eyebrow">Account</p>
          <h1 className="em-h1">
            <span className="em-mono">{account}</span>
            {a?.username && a.username !== account && <span className="em-muted"> · {a.username}</span>}
          </h1>
          {a && a.usernames.length > 1 && (
            <p className="em-caption">
              Also known as {a.usernames.filter((u) => u !== a.username).join(', ')} ({formatInt(a.username_changes)} name changes)
            </p>
          )}
        </div>
        {a?.likely_bot && (
          <Badge tone="warning" title="An inference from buy timing, not a fact">
            Likely automated
          </Badge>
        )}
      </div>

      <section className="em-section" aria-label="Account profile">
        <DataState
          query={profile}
          label="the account"
          skeleton={<Skeleton height={160} />}
          notFound={`The market layer has no trading record for ${account}. It may still have chain actions below.`}
        >
          {(p) => <Profile a={p} />}
        </DataState>
      </section>

      <Actions account={account} />
    </>
  );
}

function Profile({ a }: { a: AccountDetail }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {a.likely_bot && (
        <StatusBanner kind="warning">
          The ledger flags this account as likely automated: median buy latency {formatDuration(a.median_buy_latency_s)},{' '}
          {formatInt(a.sub_5s_buys)} buys within 5 s of listing, {formatPercent(a.pct_buys_under_1m)} of buys within a minute. It’s an
          inference, not a fact.
        </StatusBanner>
      )}
      <div className="em-stat-grid">
        <StatTile label="Buys / sells" value={`${formatInt(a.buys)} / ${formatInt(a.sells)}`} sub={`${formatInt(a.events)} market events`} />
        <StatTile label="UPX spent" value={formatUpx(a.upx_spent, { unit: false })} unit="UPX" />
        <StatTile label="UPX received" value={formatUpx(a.upx_received, { unit: false })} unit="UPX" />
        <StatTile
          label="Net"
          value={formatUpx(a.upx_net, { unit: false })}
          unit="UPX"
          trend={a.upx_net !== 0 ? { value: a.upx_net, text: a.upx_net > 0 ? 'Received more than spent' : 'Spent more than received' } : null}
        />
        <StatTile label="Yield income" value={formatUpx(a.income.yield_upx, { unit: false })} unit="UPX" sub={`${formatInt(a.income.yield_collections)} collections`} />
        <StatTile label="Visit income" value={formatUpx(a.income.visit_upx, { unit: false })} unit="UPX" />
      </div>
      <div className="em-card" style={{ display: 'grid', gap: 10 }}>
        <dl className="em-dl">
          <dt>First seen</dt>
          <dd>{formatInstant(a.first_seen)}</dd>
          <dt>Last seen</dt>
          <dd>{formatInstant(a.last_seen)}</dd>
          <dt>Active days</dt>
          <dd className="em-num">{formatInt(a.active_days)}</dd>
          <dt>Median buy latency</dt>
          <dd className="em-num">{a.buys > 0 ? formatDuration(a.median_buy_latency_s) : NONE}</dd>
        </dl>
        <LayerNote layer="market" />
      </div>
    </div>
  );
}

function summarize(action: Action): string {
  const memo = action.data.memo;
  if (typeof memo === 'string' && memo.trim() !== '') return memo;
  const keys = Object.keys(action.data);
  return keys.length === 0 ? NONE : keys.slice(0, 4).join(', ') + (keys.length > 4 ? '…' : '');
}

const ACTION_COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'action', label: 'Action' },
  { key: 'details', label: 'Details' },
  { key: 'trx', label: 'Transaction' },
];

function Actions({ account }: { account: string }) {
  const [role, setRole] = useState<Role>('actor');
  const fetchPage = useCallback(
    (cursor: string | undefined, c: LedgerClient, signal: AbortSignal) =>
      c.accounts.actions(account, { role, limit: ACTIONS_PAGE, cursor }, { signal }),
    [account, role],
  );
  const feed = useCursorFeed<Action>(queryKey(`/accounts/${account}/actions`, { role, limit: ACTIONS_PAGE }), fetchPage);

  return (
    <section className="em-section" aria-labelledby="actions-h">
      <div className="em-section-head">
        <h2 id="actions-h" className="em-h3">
          Chain actions
        </h2>
        <LayerNote layer="chain" updatedAt={feed.updatedAt} />
      </div>
      <div className="em-row">
        <Segment options={ROLE_OPTIONS} value={role} onChange={setRole} label="Which actions" />
      </div>
      <DataState
        query={feed}
        label="chain actions"
        skeleton={<TableSkeleton columns={ACTION_COLUMNS} rows={8} />}
        empty={`No chain actions where ${account} is ${role === 'actor' ? 'the signer' : role === 'receiver' ? 'the receiver' : 'notified'}.`}
      >
        {() => (
          <DataTable
            caption={`Chain actions for ${account}, newest first`}
            rows={feed.items}
            rowKey={(x) => String(x.global_sequence)}
            columns={[
              { key: 'when', label: 'When', muted: true, render: (x) => formatInstant(x.timestamp) },
              {
                key: 'action',
                label: 'Action',
                render: (x) => (
                  <span className="em-mono">
                    {x.contract}:{x.action}
                  </span>
                ),
              },
              { key: 'details', label: 'Details', wrap: true, muted: true, render: (x) => <span className="em-trunc" style={{ maxWidth: '48ch' }} title={summarize(x)}>{summarize(x)}</span> },
              { key: 'block', label: 'Block', num: true, render: (x) => formatInt(x.block_num) },
              { key: 'trx', label: 'Transaction', render: (x) => <TrxId id={x.trx_id} /> },
            ]}
            footer={
              <>
                <LoadMore count={feed.items.length} hasMore={feed.hasMore} onLoadMore={feed.loadMore} noun="actions" />
                {feed.loadMoreError && (
                  <span role="alert" className="em-async-error" style={{ flexBasis: '100%' }}>
                    {describeError(feed.loadMoreError).title}. The actions above are still current.
                  </span>
                )}
              </>
            }
          />
        )}
      </DataState>
      <p className="em-caption">Times are UTC. Earliest action shown: {feed.items.length > 0 ? formatDay(feed.items.at(-1)?.timestamp) : NONE}.</p>
    </section>
  );
}
