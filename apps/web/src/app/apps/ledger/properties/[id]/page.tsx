'use client';

/**
 * One property: header facts (`/properties/{id}`), its sale and ownership
 * history as an Embers EventTimeline (`/properties/{id}/history`, "Load
 * older"), its listing events and the offers accepted on it
 * (`/offers?property_id=`).
 *
 * `/listings` can't filter by property, so the Listings block reads the
 * listing events out of the property's latest 100 history events, and says so.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Block, Button, Card, DataTable, EventTimeline, FactList, PageHeader, Pager, Skeleton, StatTile, TileRow } from '@forge/ui';
import type { Column, TimelineEntry } from '@forge/ui';
import type { Offer, PropertyDetail, PropertyEvent, PropertyHistory } from '@forge/upland-ledger';

import { eventLabel, eventParties, fieldString, isListingEvent } from '../../_lib/events';
import { isPropertyId } from '../../_lib/filters';
import { formatDay, formatInstant, formatMultiple, formatUpx, humanize, NONE, placeLabel } from '../../_lib/format';
import { useLedgerQuery, useOffsetFeed, useOffsetPages } from '../../_lib/hooks';
import { describeError, queryKey } from '../../_lib/query-core';
import { Region } from '../../_ui/Region';
import { SignInPrompt } from '../../_ui/SignIn';
import { AccountLink, TrxId, routes } from '../../_ui/links';

const LISTING_SCAN = 100;
const OFFERS_PAGE = 10;

export default function PropertyPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params?.id ?? '');
  if (!isPropertyId(id)) {
    return (
      <>
        <PageHeader title="Property" />
        <div role="alert">
          <Card style={{ justifyItems: 'start' }}>
            <strong>“{id}” isn’t a property id. Property ids are up to 20 digits.</strong>
            <Button as={Link} href={routes.properties} icon="arrow-left">
              Back to properties
            </Button>
          </Card>
        </div>
      </>
    );
  }
  return <Property id={id} />;
}

function Property({ id }: { id: string }) {
  const detail = useLedgerQuery<PropertyDetail>(`/properties/${id}`, (c, signal) => c.properties.get(id, undefined, { signal }));
  if (detail.view === 'unauthenticated') {
    return (
      <>
        <PageHeader eyebrow={`Property #${id}`} title="Property" />
        <SignInPrompt onRetry={detail.refetch} />
      </>
    );
  }
  const p = detail.data;
  return (
    <>
      <PageHeader
        eyebrow={<span className="em-mono">Property #{id}</span>}
        title={p ? placeLabel(p.address, p.city) : detail.view === 'loading' ? <Skeleton width={320} height={32} /> : `Property #${id}`}
        aside={
          <>
            {p && (p.chain_known ? <Badge tone="success">Seen on chain</Badge> : <Badge tone="info">Upland API only</Badge>)}
            {p?.upland_api?.collection && <Badge tone="new">{p.upland_api.collection}</Badge>}
            <Button as={Link} href={routes.properties} variant="ghost" size="dense" icon="arrow-left">
              All properties
            </Button>
          </>
        }
      />

      <Region query={detail} skeleton={<Skeleton height={180} />} emptyMessage="No property." notFoundMessage={`The ledger has no property #${id}.`}>
        {(prop) => <Facts prop={prop} />}
      </Region>

      {detail.view !== 'not-found' && (
        <>
          <History id={id} />
          <Listings id={id} />
          <Offers id={id} />
        </>
      )}
    </>
  );
}

function Facts({ prop }: { prop: PropertyDetail }) {
  const api = prop.upland_api;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <TileRow>
        <StatTile label="Mint price" value={prop.mint_price_upx > 0 ? formatUpx(prop.mint_price_upx, { unit: false }) : '—'} unit={prop.mint_price_upx > 0 ? 'UPX' : undefined} />
        <StatTile label="Last sale" value={prop.last_sale_upx > 0 ? formatUpx(prop.last_sale_upx, { unit: false }) : '—'} unit={prop.last_sale_upx > 0 ? 'UPX' : undefined} />
        <StatTile label="Sales on chain" value={prop.sales} hint="Counted at the last 6-hourly market build" />
        <StatTile
          label="Last sale ÷ mint"
          value={prop.mint_price_upx > 0 && prop.last_sale_upx > 0 ? formatMultiple(prop.last_sale_upx / prop.mint_price_upx) : '—'}
        />
      </TileRow>
      <Card>
        {!prop.chain_known && (
          <p style={{ margin: 0, font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
            This property hasn’t traded or minted inside the chain window, so these details come from the Upland Developers API.
          </p>
        )}
        <FactList
          items={[
            { term: 'City', value: [prop.city, prop.region].filter(Boolean).join(', ') || NONE },
            { term: 'Neighborhood', value: prop.neighborhood || api?.neighborhood || NONE },
            { term: 'Minted', value: `${formatInstant(prop.minted_at)}${prop.mint_kind ? ` · ${humanize(prop.mint_kind)}` : ''}`, mono: true },
            { term: 'Mint price source', value: prop.mint_price_source === 'none' ? 'No mint price known' : humanize(prop.mint_price_source) },
            { term: 'Last sale', value: formatInstant(prop.last_sale_at), mono: true },
            ...(api
              ? [{ term: 'Upland API', value: [api.status, api.collection && `collection ${api.collection}`, api.mint_price_upx > 0 && `mint ${formatUpx(api.mint_price_upx)}`].filter(Boolean).join(' · ') || NONE }]
              : []),
          ]}
        />
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>Market layer · rebuilt every 6 h at :17</span>
      </Card>
    </div>
  );
}

function historyEntry(e: PropertyEvent, i: number): TimelineEntry {
  const { from, to } = eventParties(e);
  return {
    id: `${e.trx_id}:${e.event_type}:${i}`,
    date: e.timestamp ?? '',
    dateLabel: formatInstant(e.timestamp),
    title: `${eventLabel(e.event_type)}${e.amount_upx !== null ? ` · ${formatUpx(e.amount_upx)}` : ''}`,
    status: 'done',
    content: (
      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', font: 'var(--type-body-sm)' }}>
        {from && (
          <span>
            From <AccountLink account={from} />
          </span>
        )}
        {to && (
          <span>
            to <AccountLink account={to} username={e.event_type === 'property_sale' ? fieldString(e, 'owner_username') : null} />
          </span>
        )}
        <TrxId id={e.trx_id} />
      </span>
    ),
  };
}

function History({ id }: { id: string }) {
  const feed = useOffsetFeed<PropertyEvent>(queryKey(`/properties/${id}/history`), (page, c, signal) => c.properties.history(id, page, { signal }), 20);
  return (
    <Block id="history" title="Sales and ownership history" note="Decoded events · every 15 min · newest first">
      <Region query={feed} skeleton={<Skeleton height={160} />} emptyMessage="No decoded events for this property in the chain window.">
        {() => (
          <Card>
            <EventTimeline
              density="compact"
              entries={feed.items.map(historyEntry)}
              hasMore={feed.hasMore}
              loadingMore={feed.loadingMore}
              loadMoreError={feed.loadMoreError ? `${describeError(feed.loadMoreError).title}. The events above are still current.` : undefined}
              onLoadMore={() => void feed.loadMore()}
            />
          </Card>
        )}
      </Region>
    </Block>
  );
}

const LISTING_COLUMNS: Column<PropertyEvent>[] = [
  { key: 'when', label: 'When', muted: true, render: (e) => formatDay(e.timestamp) },
  { key: 'event', label: 'Event', render: (e) => eventLabel(e.event_type) },
  { key: 'by', label: 'By', render: (e) => <AccountLink account={e.account} /> },
  { key: 'ask', label: 'Ask', num: true, render: (e) => formatUpx(e.amount_upx) },
];

function Listings({ id }: { id: string }) {
  const scan = useLedgerQuery<PropertyHistory>(queryKey(`/properties/${id}/history`, { limit: LISTING_SCAN }), (c, signal) => c.properties.history(id, { limit: LISTING_SCAN }, { signal }), {
    isEmpty: (d) => !d.data.some(isListingEvent),
  });
  return (
    <Block id="listings" title="Listings" note={`From the latest ${LISTING_SCAN} history events; /listings can’t filter by property yet`}>
      <Region
        query={scan}
        skeleton={<DataTable<PropertyEvent> columns={LISTING_COLUMNS} rows={[]} loading skeletonRows={3} />}
        emptyMessage={`No listing events among the latest ${LISTING_SCAN} history events.`}
      >
        {(d) => <DataTable<PropertyEvent> columns={LISTING_COLUMNS} rows={d.data.filter(isListingEvent)} rowKey={(e) => `${e.trx_id}:${e.event_type}`} />}
      </Region>
    </Block>
  );
}

const OFFER_COLUMNS: Column<Offer>[] = [
  { key: 'when', label: 'When', muted: true, render: (o) => formatDay(o.timestamp) },
  { key: 'buyer', label: 'Buyer', render: (o) => <AccountLink account={o.buyer} username={o.buyer_username} /> },
  { key: 'seller', label: 'Seller', render: (o) => <AccountLink account={o.seller} /> },
  { key: 'price', label: 'Price', num: true, render: (o) => formatUpx(o.price_upx) },
];

function Offers({ id }: { id: string }) {
  const offers = useOffsetPages<Offer>(queryKey('/offers', { property_id: id }), (page, c, signal) => c.offers.list({ property_id: id, ...page }, { signal }), {
    pageSize: OFFERS_PAGE,
  });
  return (
    <Block id="offers" title="Accepted offers" note="Off-book sales; never in Sales · market layer">
      <Region
        query={offers}
        skeleton={<DataTable<Offer> columns={OFFER_COLUMNS} rows={[]} loading skeletonRows={3} />}
        emptyMessage="No accepted offers on record for this property."
      >
        {() => (
          <DataTable<Offer>
            columns={OFFER_COLUMNS}
            rows={offers.rows}
            rowKey={(o) => `${o.offer_id}:${o.trx_id}`}
            footer={<Pager page={offers.page} hasMore={offers.hasMore} busy={offers.paging} onPage={(n) => (n > offers.page ? offers.next() : offers.previous())} />}
          />
        )}
      </Region>
    </Block>
  );
}

