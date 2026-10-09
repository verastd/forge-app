'use client';

/**
 * One account: profile, trading and income (`/accounts/{account}`, market
 * layer) and its raw chain actions (`/accounts/{account}/actions`, cursor
 * feed, live), by role. Every account name in the UI links here.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Block, Button, Card, DataTable, FactList, PageHeader, Pager, Segment, Skeleton, StatTile, StatusBanner, TileRow } from '@forge/ui';
import type { Column } from '@forge/ui';
import type { ACCOUNT_ROLES, AccountDetail, Action, LedgerClient } from '@forge/upland-ledger';
import { isAntelopeAccount } from '@forge/upland-ledger';
import { useCallback, useState } from 'react';

import { formatDay, formatDuration, formatInstant, formatInt, formatPercent, formatUpx, NONE } from '../../_lib/format';
import { useCursorFeed, useLedgerQuery } from '../../_lib/hooks';
import { describeError, queryKey } from '../../_lib/query-core';
import { Region } from '../../_ui/Region';
import { SignInPrompt } from '../../_ui/SignIn';
import { TrxId, routes } from '../../_ui/links';

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
        <PageHeader title="Account" />
        <div role="alert">
          <Card style={{ justifyItems: 'start' }}>
            <strong>“{account}” isn’t an Upland chain account. Chain accounts are up to 13 characters: a–z, 1–5 and dots.</strong>
            <Button as={Link} href={routes.overview} icon="arrow-left">
              Back to the overview
            </Button>
          </Card>
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
        <PageHeader eyebrow="Account" title={<span className="em-mono">{account}</span>} />
        <SignInPrompt onRetry={profile.refetch} />
      </>
    );
  }
  const a = profile.data;
  return (
    <>
      <PageHeader
        eyebrow="Account"
        title={
          <>
            <span className="em-mono">{account}</span>
            {a?.username && a.username !== account && <span style={{ color: 'var(--text-muted)' }}> · {a.username}</span>}
          </>
        }
        lede={a && a.usernames.length > 1 ? `Also known as ${a.usernames.filter((u) => u !== a.username).join(', ')} (${formatInt(a.username_changes)} name changes)` : undefined}
        aside={
          a?.likely_bot ? (
            <Badge tone="warning" title="An inference from buy timing, not a fact">
              Likely automated
            </Badge>
          ) : undefined
        }
      />

      <Region
        query={profile}
        skeleton={<Skeleton height={180} />}
        emptyMessage="No profile."
        notFoundMessage={`The market layer has no trading record for ${account}. It may still have chain actions below.`}
      >
        {(p) => <Profile a={p} />}
      </Region>

      <Actions account={account} />
    </>
  );
}

function Profile({ a }: { a: AccountDetail }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {a.likely_bot && (
        <StatusBanner kind="info">
          The ledger flags this account as likely automated: median buy latency {formatDuration(a.median_buy_latency_s)}, {formatInt(a.sub_5s_buys)} buys within 5 s of
          listing, {formatPercent(a.pct_buys_under_1m)} of buys within a minute. It’s an inference, not a fact.
        </StatusBanner>
      )}
      <TileRow>
        <StatTile label="Buys / sells" value={`${formatInt(a.buys)} / ${formatInt(a.sells)}`} hint={`${formatInt(a.events)} market events`} />
        <StatTile label="UPX spent" value={formatUpx(a.upx_spent, { unit: false })} unit="UPX" />
        <StatTile label="UPX received" value={formatUpx(a.upx_received, { unit: false })} unit="UPX" />
        <StatTile
          label="Net"
          value={formatUpx(a.upx_net, { unit: false })}
          unit="UPX"
          hint={a.upx_net > 0 ? 'Received more than spent' : a.upx_net < 0 ? 'Spent more than received' : undefined}
        />
        <StatTile label="Yield income" value={formatUpx(a.income.yield_upx, { unit: false })} unit="UPX" hint={`${formatInt(a.income.yield_collections)} collections`} />
        <StatTile label="Visit income" value={formatUpx(a.income.visit_upx, { unit: false })} unit="UPX" />
      </TileRow>
      <Card>
        <FactList
          items={[
            { term: 'First seen', value: formatInstant(a.first_seen), mono: true },
            { term: 'Last seen', value: formatInstant(a.last_seen), mono: true },
            { term: 'Active days', value: formatInt(a.active_days), mono: true },
            { term: 'Median buy latency', value: a.buys > 0 ? formatDuration(a.median_buy_latency_s) : NONE, mono: true },
          ]}
        />
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>Market layer · rebuilt every 6 h at :17</span>
      </Card>
    </div>
  );
}

function summarize(action: Action): string {
  const memo = action.data.memo;
  if (typeof memo === 'string' && memo.trim() !== '') return memo;
  const keys = Object.keys(action.data);
  return keys.length === 0 ? NONE : keys.slice(0, 4).join(', ') + (keys.length > 4 ? '…' : '');
}

const ACTION_COLUMNS: Column<Action>[] = [
  { key: 'when', label: 'When', muted: true, render: (x) => formatInstant(x.timestamp) },
  { key: 'action', label: 'Action', mono: true, render: (x) => `${x.contract}:${x.action}` },
  {
    key: 'details',
    label: 'Details',
    muted: true,
    render: (x) => (
      <span title={summarize(x)} style={{ display: 'inline-block', maxWidth: '48ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
        {summarize(x)}
      </span>
    ),
  },
  { key: 'block', label: 'Block', num: true, render: (x) => formatInt(x.block_num) },
  { key: 'trx', label: 'Transaction', render: (x) => <TrxId id={x.trx_id} /> },
];

function Actions({ account }: { account: string }) {
  const [role, setRole] = useState<Role>('actor');
  const fetchPage = useCallback(
    (cursor: string | undefined, c: LedgerClient, signal: AbortSignal) => c.accounts.actions(account, { role, limit: ACTIONS_PAGE, cursor }, { signal }),
    [account, role],
  );
  const feed = useCursorFeed<Action>(queryKey(`/accounts/${account}/actions`, { role, limit: ACTIONS_PAGE }), fetchPage);
  const roleNoun = role === 'actor' ? 'the signer' : role === 'receiver' ? 'the receiver' : 'notified';
  return (
    <Block
      id="actions"
      title="Chain actions"
      note={`Live chain · newest first${feed.items.length > 0 ? ` · back to ${formatDay(feed.items.at(-1)?.timestamp)}` : ''}`}
      aside={<Segment<Role> size="dense" label="Which actions" value={role} onChange={setRole} options={ROLE_OPTIONS} />}
    >
      <Region query={feed} skeleton={<DataTable<Action> columns={ACTION_COLUMNS} rows={[]} loading skeletonRows={8} />} emptyMessage={`No chain actions where ${account} is ${roleNoun}.`}>
        {() => (
          <DataTable<Action>
            columns={ACTION_COLUMNS}
            rows={feed.items}
            rowKey={(x) => String(x.global_sequence)}
            footer={
              <>
                {feed.hasMore ? (
                  <Pager loadMore total={feed.items.length} hasMore busy={feed.loadingMore ? 'next' : null} onLoadMore={() => void feed.loadMore()} />
                ) : (
                  <span>All {formatInt(feed.items.length)} actions loaded</span>
                )}
                {feed.loadMoreError && (
                  <span role="alert" style={{ flexBasis: '100%', color: 'var(--state-error)', font: 'var(--type-body-sm)' }}>
                    {describeError(feed.loadMoreError).title}. The actions above are still current. Press Load more to try again.
                  </span>
                )}
              </>
            }
          />
        )}
      </Region>
    </Block>
  );
}
