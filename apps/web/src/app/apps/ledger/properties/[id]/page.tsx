'use client';

/**
 * One property: its header (`/properties/{id}`), its sale and ownership
 * timeline (`/properties/{id}/history`, offset pages), its listings and the
 * offers accepted on it (`/offers?property_id=`).
 *
 * `/listings` can't filter by property, so the Listings section reads the
 * listing events out of the property's own history (the latest 100 events),
 * and says so.
 */

import { useParams } from 'next/navigation';
import type { Offer, PropertyDetail, PropertyEvent, PropertyHistory } from '@forge/upland-ledger';

import { DataState } from '../../_components/DataState';
import { DataTable, ListPager, TableSkeleton } from '../../_components/DataTable';
import { LayerNote } from '../../_components/Freshness';
import { LedgerSignIn } from '../../_components/LedgerSignIn';
import { AccountLink, TrxId, routes } from '../../_components/links';
import { Badge, ButtonLink, Skeleton } from '../../_components/primitives';
import { eventLabel, eventParties, fieldString, isListingEvent } from '../../_lib/events';
import { isPropertyId } from '../../_lib/filters';
import { formatDay, formatInstant, formatInt, formatMultiple, formatUpx, humanize, NONE, placeLabel } from '../../_lib/format';
import { useLedgerQuery, useOffsetPages } from '../../_lib/hooks';
import { queryKey } from '../../_lib/query-core';

const HISTORY_PAGE = 20;
const OFFERS_PAGE = 10;
const LISTING_SCAN = 100;

const HISTORY_COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'event', label: 'Event' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
  { key: 'amount', label: 'Amount' },
  { key: 'trx', label: 'Transaction' },
];

export default function PropertyPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params?.id ?? '');

  if (!isPropertyId(id)) {
    return (
      <>
        <h1 className="em-h1">Property</h1>
        <div className="em-card em-state" role="alert">
          <span className="em-state-title">“{id}” isn’t a property id</span>
          <span>Property ids are up to 20 digits.</span>
          <ButtonLink href={routes.properties} icon="arrow-left">
            Back to properties
          </ButtonLink>
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
        <h1 className="em-h1">Property #{id}</h1>
        <LedgerSignIn onRetry={detail.refetch} />
      </>
    );
  }

  const p = detail.data;
  const title = p ? placeLabel(p.address, p.city) : `Property #${id}`;

  return (
    <>
      <div className="em-page-head">
        <div style={{ minWidth: 0 }}>
          <p className="em-eyebrow">
            Property <span className="em-mono">#{id}</span>
          </p>
          <h1 className="em-h1">{detail.view === 'loading' ? <Skeleton height={32} width={320} /> : title}</h1>
        </div>
        <ButtonLink href={routes.properties} variant="ghost" size="dense" icon="arrow-left">
          All properties
        </ButtonLink>
      </div>

      <section className="em-section" aria-label="Property details">
        <DataState query={detail} label="the property" skeleton={<Skeleton height={140} />} notFound={`The ledger has no property #${id}.`}>
          {(prop) => <Header prop={prop} />}
        </DataState>
      </section>

      {detail.view !== 'not-found' && (
        <>
          <History id={id} />
          <div className="em-grid-2">
            <Listings id={id} />
            <Offers id={id} />
          </div>
        </>
      )}
    </>
  );
}

function Header({ prop }: { prop: PropertyDetail }) {
  const api = prop.upland_api;
  return (
    <div className="em-card" style={{ display: 'grid', gap: 14 }}>
      <div className="em-chip-row">
        {prop.chain_known ? <Badge tone="success">Seen on chain</Badge> : <Badge tone="info">From the Upland API only</Badge>}
        {prop.api_status && <Badge>{prop.api_status}</Badge>}
        {api?.collection && <Badge tone="new">{api.collection}</Badge>}
      </div>
      {!prop.chain_known && (
        <p className="em-caption">This property hasn’t traded or minted inside the chain window, so its details come from the Upland Developers API.</p>
      )}
      <div className="em-stat-grid">
        <Fact label="Mint price" value={prop.mint_price_upx > 0 ? formatUpx(prop.mint_price_upx) : NONE} sub={prop.mint_price_source !== 'none' ? `Source: ${prop.mint_price_source}` : 'No mint price known'} />
        <Fact label="Last sale" value={prop.last_sale_upx > 0 ? formatUpx(prop.last_sale_upx) : NONE} sub={prop.last_sale_at ? formatInstant(prop.last_sale_at) : 'Never sold on chain'} />
        <Fact label="Sales on chain" value={formatInt(prop.sales)} sub="Counted at the last 6-hourly build" />
        <Fact
          label="Last sale ÷ mint"
          value={prop.mint_price_upx > 0 && prop.last_sale_upx > 0 ? formatMultiple(prop.last_sale_upx / prop.mint_price_upx) : NONE}
        />
      </div>
      <dl className="em-dl">
        <dt>City</dt>
        <dd>{[prop.city, prop.region].filter(Boolean).join(', ') || NONE}</dd>
        <dt>Neighborhood</dt>
        <dd>{prop.neighborhood || api?.neighborhood || NONE}</dd>
        <dt>Minted</dt>
        <dd>{prop.minted_at ? formatInstant(prop.minted_at) : NONE}{prop.mint_kind ? ` · ${humanize(prop.mint_kind)}` : ''}</dd>
        {api && (
          <>
            <dt>Upland API</dt>
            <dd>
              {[api.status, api.collection && `collection ${api.collection}`, api.mint_price_upx > 0 && `mint ${formatUpx(api.mint_price_upx)}`]
                .filter(Boolean)
                .join(' · ') || NONE}
            </dd>
          </>
        )}
      </dl>
      <LayerNote layer="market" />
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="em-stat">
      <div className="em-stat-label">{label}</div>
      <span className="em-stat-num em-num">{value}</span>
      {sub && <span className="em-stat-sub">{sub}</span>}
    </div>
  );
}

function eventColumns() {
  return [
    { key: 'when', label: 'When', muted: true, render: (e: PropertyEvent) => formatInstant(e.timestamp) },
    { key: 'event', label: 'Event', render: (e: PropertyEvent) => <strong>{eventLabel(e.event_type)}</strong> },
    {
      key: 'from',
      label: 'From',
      render: (e: PropertyEvent) => <AccountLink account={eventParties(e).from} />,
    },
    {
      key: 'to',
      label: 'To',
      render: (e: PropertyEvent) => (
        <AccountLink account={eventParties(e).to} username={e.event_type === 'property_sale' ? fieldString(e, 'owner_username') : null} />
      ),
    },
    { key: 'amount', label: 'Amount', num: true, render: (e: PropertyEvent) => formatUpx(e.amount_upx) },
    { key: 'trx', label: 'Transaction', render: (e: PropertyEvent) => <TrxId id={e.trx_id} /> },
  ];
}

function History({ id }: { id: string }) {
  const history = useOffsetPages<PropertyEvent>(
    queryKey(`/properties/${id}/history`),
    (page, c, signal) => c.properties.history(id, page, { signal }),
    { pageSize: HISTORY_PAGE },
  );
  return (
    <section className="em-section" aria-labelledby="history-h">
      <div className="em-section-head">
        <h2 id="history-h" className="em-h3">
          Sales and ownership history
        </h2>
        <LayerNote layer="decoded" updatedAt={history.updatedAt} />
      </div>
      <DataState
        query={history}
        label="the property history"
        skeleton={<TableSkeleton columns={HISTORY_COLUMNS} rows={5} />}
        empty="No decoded events for this property in the chain window."
      >
        {() => (
          <DataTable
            caption="Property history, newest first"
            rows={history.rows}
            rowKey={(e, i) => `${e.trx_id}:${e.event_type}:${i}`}
            columns={eventColumns()}
            footer={
              <ListPager list={history} />
            }
          />
        )}
      </DataState>
    </section>
  );
}

function Listings({ id }: { id: string }) {
  const scan = useLedgerQuery<PropertyHistory>(
    queryKey(`/properties/${id}/history`, { limit: LISTING_SCAN }),
    (c, signal) => c.properties.history(id, { limit: LISTING_SCAN }, { signal }),
    { isEmpty: (d) => !d.data.some(isListingEvent) },
  );
  return (
    <section className="em-section" aria-labelledby="listings-h">
      <div className="em-section-head">
        <h2 id="listings-h" className="em-h3">
          Listings
        </h2>
      </div>
      <p className="em-caption">
        Listing events from this property’s latest {LISTING_SCAN} history events. The ledger’s listings route can’t filter by property yet.
      </p>
      <DataState
        query={scan}
        label="listing events"
        skeleton={<TableSkeleton columns={HISTORY_COLUMNS.slice(0, 3)} rows={3} />}
        empty={`No listing events among the latest ${LISTING_SCAN} history events.`}
      >
        {(d) => (
          <DataTable
            caption="Listing events"
            rows={d.data.filter(isListingEvent)}
            rowKey={(e, i) => `${e.trx_id}:${i}`}
            columns={[
              { key: 'when', label: 'When', muted: true, render: (e) => formatDay(e.timestamp) },
              { key: 'event', label: 'Event', render: (e) => eventLabel(e.event_type) },
              { key: 'by', label: 'By', render: (e) => <AccountLink account={e.account} /> },
              { key: 'amount', label: 'Ask', num: true, render: (e) => formatUpx(e.amount_upx) },
            ]}
          />
        )}
      </DataState>
    </section>
  );
}

function Offers({ id }: { id: string }) {
  const offers = useOffsetPages<Offer>(
    queryKey('/offers', { property_id: id }),
    (page, c, signal) => c.offers.list({ property_id: id, ...page }, { signal }),
    { pageSize: OFFERS_PAGE },
  );
  return (
    <section className="em-section" aria-labelledby="offers-h">
      <div className="em-section-head">
        <h2 id="offers-h" className="em-h3">
          Accepted offers
        </h2>
        <LayerNote layer="market" updatedAt={offers.updatedAt} />
      </div>
      <p className="em-caption">Off-book sales: the seller accepted an offer, so these never appear in Sales.</p>
      <DataState query={offers} label="offers" skeleton={<TableSkeleton columns={HISTORY_COLUMNS.slice(0, 4)} rows={3} />} empty="No accepted offers on record for this property.">
        {() => (
          <DataTable
            caption="Accepted offers on this property"
            rows={offers.rows}
            rowKey={(o) => `${o.offer_id}:${o.trx_id}`}
            columns={[
              { key: 'when', label: 'When', muted: true, render: (o) => formatDay(o.timestamp) },
              { key: 'buyer', label: 'Buyer', render: (o) => <AccountLink account={o.buyer} username={o.buyer_username} /> },
              { key: 'seller', label: 'Seller', render: (o) => <AccountLink account={o.seller} /> },
              { key: 'price', label: 'Price', num: true, render: (o) => formatUpx(o.price_upx) },
            ]}
            footer={
              <ListPager list={offers} />
            }
          />
        )}
      </DataState>
    </section>
  );
}
