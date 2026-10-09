'use client';

/**
 * Market: recent sales, active listings, accepted offers and UPX/USD rates,
 * one tab at a time (only the open tab reads anything). Filters live in the
 * URL and carry across tabs where the route supports them:
 *   Sales     /sales      city, neighborhood, buyer, seller, price, sort
 *   Listings  /listings   city, neighborhood, book, open only, sort
 *   Offers    /offers     city, buyer, seller, sort        (no neighborhood filter)
 *   Rates     /market/upx-usd (heavy slot) + /rates         method
 * No route can filter by collection yet; the field says so instead of hiding.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import type { Listing, ListingParams, Offer, OfferParams, RateRow, Sale, SaleParams, UpxUsd } from '@forge/upland-ledger';
import { RATE_METHODS } from '@forge/upland-ledger';

import { DataState } from '../_components/DataState';
import { DataTable, ListPager, TableSkeleton } from '../_components/DataTable';
import { FilterBar, NumberField, SelectField, SortFields, TextField, ToggleField, UnavailableField } from '../_components/FilterBar';
import { LayerNote } from '../_components/Freshness';
import { AccountLink, PropertyLink, TrxId, routes } from '../_components/links';
import { RateChart } from '../_components/charts';
import { Badge, Skeleton, SkeletonRows, Tabs } from '../_components/primitives';
import { accountDraftError, countApplied, hrefWith, numberDraftError, readAccount, readEnum, readNumber, readText } from '../_lib/filters';
import type { ParamSource } from '../_lib/filters';
import { formatDay, formatInstant, formatInt, formatMultiple, formatUpx, formatUsd, NONE } from '../_lib/format';
import { useLedgerQuery, useOffsetPages } from '../_lib/hooks';
import { rateSeries, rateSummary } from '../_lib/market';
import { queryKey } from '../_lib/query-core';
import { useFilters } from '../_lib/useFilters';

const TABS = ['sales', 'listings', 'offers', 'rates'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { sales: 'Sales', listings: 'Listings', offers: 'Offers', rates: 'Rates' };
const PAGE_SIZE = 25;
const NO_COLLECTION = 'the ledger can’t filter sales, listings or offers by collection yet.';
const NO_NEIGHBORHOOD_OFFERS = 'the offers route has no neighborhood filter.';

const SKELETON_COLUMNS = [
  { key: 'a', label: 'When' },
  { key: 'b', label: 'Property' },
  { key: 'c', label: 'City' },
  { key: 'd', label: 'Price' },
  { key: 'e', label: 'Account' },
];

export default function MarketPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Market />
    </Suspense>
  );
}

function Market() {
  const params = useSearchParams() ?? new URLSearchParams();
  const tab: Tab = readEnum(params, 'tab', TABS) ?? 'sales';
  const keep = { city: readText(params, 'city', 64), neighborhood: readText(params, 'neighborhood') };

  return (
    <>
      <div className="em-page-head">
        <div>
          <h1 className="em-h1">Market</h1>
          <p className="em-lede">What changed hands, what’s for sale, and what UPX is worth in dollars.</p>
        </div>
      </div>
      <Tabs
        label="Market views"
        tabs={TABS.map((t) => ({ href: hrefWith(routes.market, { tab: t === 'sales' ? undefined : t, ...keep }), label: TAB_LABELS[t], current: t === tab }))}
      />
      {tab === 'sales' && <SalesTab params={params} />}
      {tab === 'listings' && <ListingsTab params={params} />}
      {tab === 'offers' && <OffersTab params={params} />}
      {tab === 'rates' && <RatesTab params={params} />}
    </>
  );
}

/* --- Sales ------------------------------------------------------------------- */

const SALE_KEYS = ['city', 'neighborhood', 'buyer', 'seller', 'min_price', 'max_price', 'sort', 'order'] as const;
const SALE_SORTS = ['timestamp', 'price_upx', 'price_to_mint'] as const;

function SalesTab({ params }: { params: ParamSource }) {
  const filters = useFilters(SALE_KEYS, { tab: undefined });
  const request = useMemo<SaleParams>(
    () => ({
      city: readText(params, 'city', 64),
      neighborhood: readText(params, 'neighborhood'),
      buyer: readAccount(params, 'buyer'),
      seller: readAccount(params, 'seller'),
      min_price: readNumber(params, 'min_price', { min: 0 }),
      max_price: readNumber(params, 'max_price', { min: 0 }),
      sort: readEnum(params, 'sort', SALE_SORTS) ?? 'timestamp',
      order: readEnum(params, 'order', ['asc', 'desc'] as const) ?? 'desc',
    }),
    [params],
  );
  const list = useOffsetPages<Sale>(queryKey('/sales', request), (page, c, signal) => c.sales.list({ ...request, ...page }, { signal }), {
    pageSize: PAGE_SIZE,
  });
  const d = filters.draft;
  const errors = {
    buyer: accountDraftError(d.buyer),
    seller: accountDraftError(d.seller),
    min_price: numberDraftError(d.min_price),
    max_price: numberDraftError(d.max_price),
  };
  return (
    <section className="em-section" aria-labelledby="sales-h">
      <div className="em-section-head">
        <h2 id="sales-h" className="em-h3">
          Recent sales
        </h2>
        <LayerNote layer="decoded" updatedAt={list.updatedAt} />
      </div>
      <FilterBar
        label="Filter sales"
        dirty={filters.dirty}
        applying={list.fetching && list.paging === null}
        invalid={Object.values(errors).find((e) => e !== null) ?? null}
        appliedCount={countApplied(request as Record<string, unknown>, ['city', 'neighborhood', 'buyer', 'seller', 'min_price', 'max_price'])}
        onApply={filters.apply}
        onReset={filters.reset}
        notes={[`Collection: ${NO_COLLECTION}`]}
      >
        <TextField label="City" value={d.city} onChange={(v) => filters.set('city', v)} placeholder="e.g. Rome" maxLength={64} />
        <TextField label="Neighborhood" value={d.neighborhood} onChange={(v) => filters.set('neighborhood', v)} />
        <UnavailableField label="Collection" reason={NO_COLLECTION} />
        <TextField label="Buyer account" value={d.buyer} onChange={(v) => filters.set('buyer', v)} error={errors.buyer} maxLength={13} />
        <TextField label="Seller account" value={d.seller} onChange={(v) => filters.set('seller', v)} error={errors.seller} maxLength={13} />
        <NumberField label="Min price" prefix="UPX" value={d.min_price} onChange={(v) => filters.set('min_price', v)} step={1000} />
        <NumberField label="Max price" prefix="UPX" value={d.max_price} onChange={(v) => filters.set('max_price', v)} step={1000} />
        <SortFields
          value={SALE_SORTS.find((s) => s === d.sort) ?? 'timestamp'}
          onChange={(v) => filters.set('sort', v)}
          options={[
            { value: 'timestamp', label: 'Time' },
            { value: 'price_upx', label: 'Price' },
            { value: 'price_to_mint', label: 'Price ÷ mint' },
          ]}
          dir={d.order === 'asc' ? 'asc' : 'desc'}
          onDir={(v) => filters.set('order', v)}
        />
      </FilterBar>
      <DataState query={list} label="sales" skeleton={<TableSkeleton columns={SKELETON_COLUMNS} rows={10} />} empty="No sales match these filters." emptyAction={{ label: 'Reset filters', onClick: filters.reset }}>
        {() => (
          <DataTable
            caption="Sales"
            sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
            onSort={(next) => filters.applyNow({ sort: next.key, order: next.dir })}
            rows={list.rows}
            rowKey={(s) => `${s.trx_id}:${s.property_id}`}
            columns={[
              { key: 'when', label: 'When', muted: true, sortKey: 'timestamp', render: (s) => formatInstant(s.timestamp) },
              { key: 'property', label: 'Property', wrap: true, render: (s) => <PropertyLink id={s.property_id} label={s.address} /> },
              { key: 'city', label: 'City', muted: true, render: (s) => s.city || NONE },
              { key: 'price', label: 'Price', num: true, sortKey: 'price_upx', render: (s) => formatUpx(s.price_upx) },
              { key: 'ratio', label: 'Price ÷ mint', num: true, sortKey: 'price_to_mint', render: (s) => formatMultiple(s.price_to_mint) },
              { key: 'buyer', label: 'Buyer', render: (s) => <AccountLink account={s.buyer} /> },
              { key: 'seller', label: 'Seller', render: (s) => <AccountLink account={s.seller} /> },
              { key: 'trx', label: 'Transaction', render: (s) => <TrxId id={s.trx_id} /> },
            ]}
            footer={<ListPager list={list} />}
          />
        )}
      </DataState>
    </section>
  );
}

/* --- Listings ------------------------------------------------------------------ */

const LISTING_KEYS = ['city', 'neighborhood', 'book', 'open', 'sort', 'order'] as const;
const LISTING_SORTS = ['timestamp', 'ask_upx', 'ask_fiat', 'ask_to_mint'] as const;

function ListingsTab({ params }: { params: ParamSource }) {
  const filters = useFilters(LISTING_KEYS, { tab: 'listings' });
  const request = useMemo<ListingParams>(() => {
    const sort = readEnum(params, 'sort', LISTING_SORTS) ?? 'timestamp';
    return {
      city: readText(params, 'city', 64),
      neighborhood: readText(params, 'neighborhood'),
      book: readEnum(params, 'book', ['upx', 'fiat'] as const),
      // Open listings by default: "active listings" is what people come for.
      open: params.get('open') === '0' ? undefined : true,
      sort,
      order: readEnum(params, 'order', ['asc', 'desc'] as const) ?? (sort === 'timestamp' ? 'desc' : 'asc'),
    };
  }, [params]);
  const list = useOffsetPages<Listing>(queryKey('/listings', request), (page, c, signal) => c.listings.list({ ...request, ...page }, { signal }), {
    pageSize: PAGE_SIZE,
  });
  const d = filters.draft;
  return (
    <section className="em-section" aria-labelledby="listings-h">
      <div className="em-section-head">
        <h2 id="listings-h" className="em-h3">
          {request.open ? 'Active listings' : 'All listings'}
        </h2>
        <LayerNote layer="decoded" updatedAt={list.updatedAt} />
      </div>
      <FilterBar
        label="Filter listings"
        dirty={filters.dirty}
        applying={list.fetching && list.paging === null}
        appliedCount={countApplied({ ...request, open: request.open ? undefined : 'all' } as Record<string, unknown>, ['city', 'neighborhood', 'book', 'open'])}
        onApply={filters.apply}
        onReset={filters.reset}
        notes={[`Collection: ${NO_COLLECTION}`]}
      >
        <TextField label="City" value={d.city} onChange={(v) => filters.set('city', v)} placeholder="e.g. Miami" maxLength={64} />
        <TextField label="Neighborhood" value={d.neighborhood} onChange={(v) => filters.set('neighborhood', v)} />
        <UnavailableField label="Collection" reason={NO_COLLECTION} />
        <SelectField
          label="Priced in"
          value={d.book === 'upx' || d.book === 'fiat' ? d.book : 'any'}
          onChange={(v) => filters.set('book', v === 'any' ? '' : v)}
          options={[
            { value: 'any', label: 'UPX or USD' },
            { value: 'upx', label: 'UPX' },
            { value: 'fiat', label: 'USD' },
          ]}
        />
        <SortFields
          value={LISTING_SORTS.find((s) => s === d.sort) ?? 'timestamp'}
          onChange={(v) => filters.set('sort', v)}
          options={[
            { value: 'timestamp', label: 'Listed' },
            { value: 'ask_upx', label: 'UPX ask' },
            { value: 'ask_fiat', label: 'USD ask' },
            { value: 'ask_to_mint', label: 'Ask ÷ mint' },
          ]}
          dir={d.order === 'asc' || d.order === 'desc' ? d.order : (d.sort || 'timestamp') === 'timestamp' ? 'desc' : 'asc'}
          onDir={(v) => filters.set('order', v)}
        />
        <ToggleField label="Still open only" checked={d.open !== '0'} onChange={(on) => filters.set('open', on ? '' : '0')} />
      </FilterBar>
      <DataState query={list} label="listings" skeleton={<TableSkeleton columns={SKELETON_COLUMNS} rows={10} />} empty="No listings match these filters." emptyAction={{ label: 'Reset filters', onClick: filters.reset }}>
        {() => (
          <DataTable
            caption="Listings"
            sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
            onSort={(next) => filters.applyNow({ sort: next.key, order: next.dir })}
            rows={list.rows}
            rowKey={(l, i) => `${l.property_id}:${l.timestamp ?? ''}:${i}`}
            columns={[
              { key: 'when', label: 'Listed', muted: true, sortKey: 'timestamp', render: (l) => formatInstant(l.timestamp) },
              { key: 'property', label: 'Property', wrap: true, render: (l) => <PropertyLink id={l.property_id} label={l.address} /> },
              { key: 'city', label: 'City', muted: true, render: (l) => l.city || NONE },
              {
                key: 'ask',
                label: 'Ask',
                num: true,
                render: (l) => (l.ask_upx > 0 ? formatUpx(l.ask_upx) : l.ask_fiat > 0 ? formatUsd(l.ask_fiat) : NONE),
              },
              { key: 'book', label: 'Book', render: (l) => <Badge>{l.ask_upx > 0 ? 'UPX' : 'USD'}</Badge> },
              { key: 'ratio', label: 'Ask ÷ mint', num: true, sortKey: 'ask_to_mint', render: (l) => formatMultiple(l.ask_to_mint) },
              { key: 'seller', label: 'Seller', render: (l) => <AccountLink account={l.seller} /> },
            ]}
            footer={<ListPager list={list} />}
          />
        )}
      </DataState>
    </section>
  );
}

/* --- Offers --------------------------------------------------------------------- */

const OFFER_KEYS = ['city', 'buyer', 'seller', 'sort', 'order'] as const;
const OFFER_SORTS = ['timestamp', 'price_upx', 'price_to_mint'] as const;

function OffersTab({ params }: { params: ParamSource }) {
  const filters = useFilters(OFFER_KEYS, { tab: 'offers', neighborhood: undefined });
  const request = useMemo<OfferParams>(
    () => ({
      city: readText(params, 'city', 64),
      buyer: readAccount(params, 'buyer'),
      seller: readAccount(params, 'seller'),
      sort: readEnum(params, 'sort', OFFER_SORTS) ?? 'timestamp',
      order: readEnum(params, 'order', ['asc', 'desc'] as const) ?? 'desc',
    }),
    [params],
  );
  const list = useOffsetPages<Offer>(queryKey('/offers', request), (page, c, signal) => c.offers.list({ ...request, ...page }, { signal }), {
    pageSize: PAGE_SIZE,
  });
  const d = filters.draft;
  const errors = { buyer: accountDraftError(d.buyer), seller: accountDraftError(d.seller) };
  return (
    <section className="em-section" aria-labelledby="offers-h">
      <div className="em-section-head">
        <h2 id="offers-h" className="em-h3">
          Accepted offers
        </h2>
        <LayerNote layer="market" updatedAt={list.updatedAt} />
      </div>
      <p className="em-caption">
        Off-book sales, where a seller accepted a buyer’s offer. They never appear under Sales, and their prices often have little to do with the
        order book.
      </p>
      <FilterBar
        label="Filter offers"
        dirty={filters.dirty}
        applying={list.fetching && list.paging === null}
        invalid={Object.values(errors).find((e) => e !== null) ?? null}
        appliedCount={countApplied(request as Record<string, unknown>, ['city', 'buyer', 'seller'])}
        onApply={filters.apply}
        onReset={filters.reset}
        notes={[`Neighborhood: ${NO_NEIGHBORHOOD_OFFERS}`, `Collection: ${NO_COLLECTION}`]}
      >
        <TextField label="City" value={d.city} onChange={(v) => filters.set('city', v)} placeholder="e.g. Singapore" maxLength={64} />
        <UnavailableField label="Neighborhood" reason={NO_NEIGHBORHOOD_OFFERS} />
        <UnavailableField label="Collection" reason={NO_COLLECTION} />
        <TextField label="Buyer account" value={d.buyer} onChange={(v) => filters.set('buyer', v)} error={errors.buyer} maxLength={13} />
        <TextField label="Seller account" value={d.seller} onChange={(v) => filters.set('seller', v)} error={errors.seller} maxLength={13} />
        <SortFields
          value={OFFER_SORTS.find((s) => s === d.sort) ?? 'timestamp'}
          onChange={(v) => filters.set('sort', v)}
          options={[
            { value: 'timestamp', label: 'Time' },
            { value: 'price_upx', label: 'Price' },
            { value: 'price_to_mint', label: 'Price ÷ mint' },
          ]}
          dir={d.order === 'asc' ? 'asc' : 'desc'}
          onDir={(v) => filters.set('order', v)}
        />
      </FilterBar>
      <DataState query={list} label="offers" skeleton={<TableSkeleton columns={SKELETON_COLUMNS} rows={10} />} empty="No accepted offers match these filters." emptyAction={{ label: 'Reset filters', onClick: filters.reset }}>
        {() => (
          <DataTable
            caption="Accepted offers"
            sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
            onSort={(next) => filters.applyNow({ sort: next.key, order: next.dir })}
            rows={list.rows}
            rowKey={(o) => `${o.offer_id}:${o.trx_id}`}
            columns={[
              { key: 'when', label: 'When', muted: true, sortKey: 'timestamp', render: (o) => formatInstant(o.timestamp) },
              { key: 'property', label: 'Property', wrap: true, render: (o) => <PropertyLink id={o.property_id} label={o.address} /> },
              { key: 'city', label: 'City', muted: true, render: (o) => o.city || NONE },
              { key: 'price', label: 'Price', num: true, sortKey: 'price_upx', render: (o) => formatUpx(o.price_upx) },
              { key: 'ratio', label: 'Price ÷ mint', num: true, sortKey: 'price_to_mint', render: (o) => formatMultiple(o.price_to_mint) },
              { key: 'buyer', label: 'Buyer', render: (o) => <AccountLink account={o.buyer} username={o.buyer_username} /> },
              { key: 'seller', label: 'Seller (accepted)', render: (o) => <AccountLink account={o.seller} /> },
            ]}
            footer={<ListPager list={list} />}
          />
        )}
      </DataState>
    </section>
  );
}

/* --- Rates ------------------------------------------------------------------------ */

const RATE_KEYS = ['method'] as const;
const RATE_DAYS = 90;

function RatesTab({ params }: { params: ParamSource }) {
  const filters = useFilters(RATE_KEYS, { tab: 'rates' });
  const method = readEnum(params, 'method', RATE_METHODS);
  const chart = useLedgerQuery<UpxUsd>(
    queryKey('/market/upx-usd', { method, limit: RATE_DAYS }),
    (c, signal) => c.market.upxUsd({ method, limit: RATE_DAYS }, { signal }),
    { heavy: true, isEmpty: (d) => d.points.length === 0 },
  );
  const rows = useOffsetPages<RateRow>(queryKey('/rates', { method }), (page, c, signal) => c.rates.list({ method, ...page }, { signal }), {
    pageSize: PAGE_SIZE,
  });
  const shownMethod = method ?? chart.data?.preferred;
  const series = chart.data && shownMethod ? rateSeries(chart.data, shownMethod) : [];
  const summary = rateSummary(series);
  return (
    <>
      <FilterBar
        label="Choose a rate method"
        dirty={filters.dirty}
        applying={(chart.fetching || rows.fetching) && rows.paging === null}
        appliedCount={method ? 1 : 0}
        onApply={filters.apply}
        onReset={filters.reset}
      >
        <SelectField
          label="Method"
          value={RATE_METHODS.find((m) => m === filters.draft.method) ?? 'preferred'}
          onChange={(v) => filters.set('method', v === 'preferred' ? '' : v)}
          options={[{ value: 'preferred', label: 'Ledger’s preferred' }, ...RATE_METHODS.map((m) => ({ value: m, label: m }))]}
        />
      </FilterBar>

      <section className="em-section" aria-labelledby="rate-chart-h">
        <div className="em-section-head">
          <h2 id="rate-chart-h" className="em-h3">
            UPX per $1, last {RATE_DAYS} days
          </h2>
          <LayerNote layer="market" updatedAt={chart.updatedAt} />
        </div>
        <div className="em-card">
          <DataState query={chart} label="the rate chart" skeleton={<Skeleton height={260} />} empty="No rate points for this method yet.">
            {(d) => (
              <div style={{ display: 'grid', gap: 10 }}>
                <p className="em-caption">
                  Method <code>{shownMethod}</code>
                  {shownMethod === d.preferred ? ' (the ledger’s preferred method)' : ''}.{' '}
                  {d.spread !== null && <>Spread between methods today: {formatInt(d.spread)} UPX. </>}
                  {d.notes.join(' ')}
                </p>
                {series.length === 0 ? (
                  <p className="em-state">No points for {shownMethod} in this window.</p>
                ) : (
                  <RateChart
                    series={series}
                    label={summary ? `UPX per US dollar by ${shownMethod}, latest ${formatInt(summary.upxPerUsd)} on ${formatDay(summary.day)}` : 'UPX per US dollar'}
                  />
                )}
              </div>
            )}
          </DataState>
        </div>
      </section>

      <section className="em-section" aria-labelledby="rate-rows-h">
        <div className="em-section-head">
          <h2 id="rate-rows-h" className="em-h3">
            Daily rate rows
          </h2>
          <span className="em-caption">/rates, newest first</span>
        </div>
        <DataState query={rows} label="rate rows" skeleton={<TableSkeleton columns={SKELETON_COLUMNS} rows={8} />} empty="No rate rows for this method.">
          {() => (
            <DataTable
              caption="Daily UPX/USD rate rows"
              rows={rows.rows}
              rowKey={(r) => `${r.day}:${r.method}`}
              columns={[
                { key: 'day', label: 'Day', render: (r) => formatDay(r.day) },
                { key: 'method', label: 'Method', mono: true, render: (r) => r.method },
                { key: 'rate', label: 'UPX per $1', num: true, render: (r) => formatInt(r.upx_per_usd) },
                { key: 'band', label: 'p25–p75', num: true, render: (r) => `${formatInt(r.p25)}–${formatInt(r.p75)}` },
                { key: 'samples', label: 'Samples', num: true, render: (r) => formatInt(r.samples) },
                { key: 'cities', label: 'Cities', num: true, render: (r) => formatInt(r.cities) },
                { key: 'listings', label: 'UPX / USD listings', num: true, render: (r) => `${formatInt(r.upx_listings)} / ${formatInt(r.fiat_listings)}` },
              ]}
              footer={<ListPager list={rows} />}
            />
          )}
        </DataState>
      </section>
    </>
  );
}
