'use client';

/**
 * Market: recent sales, active listings, accepted offers and UPX/USD rates,
 * one at a time behind a Segment (only the open view reads anything). Each
 * view is the kit's filter → panel → table composition. Filters live in the
 * URL and carry across views where the route supports them:
 *   Sales     /sales     city, neighborhood, buyer, seller, price, sort
 *   Listings  /listings  city, neighborhood, book, open only, sort
 *   Offers    /offers    city, buyer, seller, sort        (no neighborhood filter)
 *   Rates     /market/upx-usd (heavy slot) + /rates       method
 * No route can filter by collection yet; that field is shown disabled with
 * its reason (DESIGN_SYSTEM.md: disabled controls always carry a reason).
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Block, Card, DataTable, FilterBar, FilterField, NumberField, PageHeader, Pager, Segment, Select, Skeleton, TextField, Toggle } from '@forge/ui';
import type { Column } from '@forge/ui';
import type { Listing, ListingParams, Offer, OfferParams, RateRow, Sale, SaleParams, UpxUsd } from '@forge/upland-ledger';
import { RATE_METHODS } from '@forge/upland-ledger';
import { Suspense, useMemo } from 'react';

import { accountDraftError, countApplied, hrefWith, readAccount, readEnum, readNumber, readText } from '../_lib/filters';
import type { ParamSource } from '../_lib/filters';
import { formatDay, formatInstant, formatInt, formatMultiple, formatRate, formatUpx, formatUsd, NONE } from '../_lib/format';
import { useLedgerQuery, useOffsetPages } from '../_lib/hooks';
import type { OffsetPagesResult } from '../_lib/hooks';
import { rateSeries } from '../_lib/market';
import { queryKey } from '../_lib/query-core';
import { useFilters } from '../_lib/useFilters';
import { RateFigure } from '../_ui/RateFigure';
import { Region } from '../_ui/Region';
import { SearchFilterField } from '../_ui/fields';
import { draftNumber, filterBarState, numberDraft } from '../_ui/filterbar';
import { AccountLink, PropertyLink, TrxId, routes } from '../_ui/links';

const VIEWS = ['sales', 'listings', 'offers', 'rates'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { sales: 'Sales', listings: 'Listings', offers: 'Offers', rates: 'Rates' };
const PAGE_SIZE = 25;
const NO_COLLECTION = 'The ledger can’t filter sales, listings or offers by collection yet.';
const NO_OFFER_NEIGHBORHOOD = 'The offers route has no neighborhood filter.';
const DIR_OPTIONS = [
  { value: 'asc', label: '↑', ariaLabel: 'Ascending' },
  { value: 'desc', label: '↓', ariaLabel: 'Descending' },
] as const;

export default function MarketPage() {
  return (
    <Suspense fallback={<Skeleton height={240} />}>
      <Market />
    </Suspense>
  );
}

function Market() {
  const params = useSearchParams() ?? new URLSearchParams();
  const router = useRouter();
  const view: View = readEnum(params, 'tab', VIEWS) ?? 'sales';
  const keep = { city: readText(params, 'city', 64), neighborhood: readText(params, 'neighborhood') };
  return (
    <>
      <PageHeader
        title="Market"
        lede="What changed hands, what’s for sale, and what UPX is worth in dollars."
        aside={
          <Segment<View>
            label="Market view"
            value={view}
            onChange={(v) => router.replace(hrefWith(routes.market, { tab: v === 'sales' ? undefined : v, ...keep }), { scroll: false })}
            options={VIEWS.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
          />
        }
      />
      {view === 'sales' && <SalesView params={params} />}
      {view === 'listings' && <ListingsView params={params} />}
      {view === 'offers' && <OffersView params={params} />}
      {view === 'rates' && <RatesView params={params} />}
    </>
  );
}

function ListPager<T>({ list }: { list: OffsetPagesResult<T> }) {
  return <Pager page={list.page} hasMore={list.hasMore} busy={list.paging} onPage={(n) => (n > list.page ? list.next() : list.previous())} />;
}

function CollectionField() {
  return (
    <FilterField label="Collection">
      <Select size="dense" width={150} label="Collection" placeholder="Any collection" options={[]} disabledReason={NO_COLLECTION} />
    </FilterField>
  );
}

/* --- Sales ------------------------------------------------------------------- */

const SALE_KEYS = ['city', 'neighborhood', 'buyer', 'seller', 'min_price', 'max_price', 'sort', 'order'] as const;
const SALE_SORTS = ['timestamp', 'price_upx', 'price_to_mint'] as const;
type SaleSort = (typeof SALE_SORTS)[number];

const SALE_COLUMNS: Column<Sale>[] = [
  { key: 'timestamp', label: 'When', muted: true, sortable: true, render: (s) => formatInstant(s.timestamp) },
  { key: 'property', label: 'Property', render: (s) => <PropertyLink id={s.property_id} label={s.address} /> },
  { key: 'city', label: 'City', muted: true, render: (s) => s.city || NONE },
  { key: 'price_upx', label: 'Price', num: true, sortable: true, render: (s) => formatUpx(s.price_upx) },
  { key: 'price_to_mint', label: 'Price ÷ mint', num: true, sortable: true, hint: 'Sale price over the property’s mint price; — when no mint price is known', render: (s) => formatMultiple(s.price_to_mint) },
  { key: 'buyer', label: 'Buyer', render: (s) => <AccountLink account={s.buyer} /> },
  { key: 'seller', label: 'Seller', render: (s) => <AccountLink account={s.seller} /> },
  { key: 'trx', label: 'Transaction', render: (s) => <TrxId id={s.trx_id} /> },
];

function SalesView({ params }: { params: ParamSource }) {
  const filters = useFilters(SALE_KEYS);
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
  const list = useOffsetPages<Sale>(queryKey('/sales', request), (page, c, signal) => c.sales.list({ ...request, ...page }, { signal }), { pageSize: PAGE_SIZE });
  const d = filters.draft;
  const buyerError = accountDraftError(d.buyer);
  const sellerError = accountDraftError(d.seller);
  const applied = countApplied(request as Record<string, unknown>, ['city', 'neighborhood', 'buyer', 'seller', 'min_price', 'max_price']);
  return (
    <>
      <FilterBar
        state={filterBarState(filters.dirty, list.fetching && list.paging === null, applied)}
        appliedCount={applied}
        onApply={async () => {
          if (buyerError || sellerError) throw new Error('Fix the account names first');
          filters.apply();
        }}
        onReset={filters.reset}
      >
        <FilterField label="City">
          <SearchFilterField kind="city" label="City" value={d.city} onChange={(v) => filters.set('city', v)} width={180} />
        </FilterField>
        <FilterField label="Neighborhood">
          <SearchFilterField kind="neighborhood" label="Neighborhood" value={d.neighborhood} onChange={(v) => filters.set('neighborhood', v)} width={200} />
        </FilterField>
        <CollectionField />
        <TextField label="Buyer account" value={d.buyer} onChange={(v) => filters.set('buyer', v)} error={buyerError} mono maxLength={13} width={150} />
        <TextField label="Seller account" value={d.seller} onChange={(v) => filters.set('seller', v)} error={sellerError} mono maxLength={13} width={150} />
        <FilterField label="Sort">
          <Select<SaleSort>
            size="dense"
            width={140}
            label="Sort"
            value={SALE_SORTS.find((s) => s === d.sort) ?? 'timestamp'}
            onChange={(v) => filters.set('sort', v)}
            options={[
              { value: 'timestamp', label: 'Time' },
              { value: 'price_upx', label: 'Price' },
              { value: 'price_to_mint', label: 'Price ÷ mint' },
            ]}
          />
        </FilterField>
        <FilterField label="Dir">
          <Segment size="dense" label="Sort direction" value={d.order === 'asc' ? 'asc' : 'desc'} onChange={(v) => filters.set('order', v)} options={DIR_OPTIONS} />
        </FilterField>
      </FilterBar>

      <Block id="sale-bounds" title="Min / Max" note="Empty means no bound">
        <Card style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          <NumberField label="Min price" prefix="UPX" min={0} step={1000} width="100%" value={draftNumber(d.min_price)} onCommit={(v) => filters.set('min_price', numberDraft(v))} />
          <NumberField label="Max price" prefix="UPX" min={0} step={1000} width="100%" value={draftNumber(d.max_price)} onCommit={(v) => filters.set('max_price', numberDraft(v))} />
        </Card>
      </Block>

      <Block id="sales" title="Recent sales" note="Decoded events · every 15 min">
        <Region
          query={list}
          skeleton={<DataTable<Sale> columns={SALE_COLUMNS} rows={[]} loading skeletonRows={10} />}
          emptyMessage="No sales match these filters."
          emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
        >
          {() => (
            <DataTable<Sale>
              columns={SALE_COLUMNS}
              rows={list.rows}
              rowKey={(s) => `${s.trx_id}:${s.property_id}`}
              sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
              onSort={(s) => filters.applyNow({ sort: s.key, order: s.dir })}
              footer={<ListPager list={list} />}
            />
          )}
        </Region>
      </Block>
    </>
  );
}

/* --- Listings ------------------------------------------------------------------ */

const LISTING_KEYS = ['city', 'neighborhood', 'book', 'open', 'sort', 'order'] as const;
const LISTING_SORTS = ['timestamp', 'ask_upx', 'ask_fiat', 'ask_to_mint'] as const;
type ListingSort = (typeof LISTING_SORTS)[number];
type Book = 'any' | 'upx' | 'fiat';

const LISTING_COLUMNS: Column<Listing>[] = [
  { key: 'timestamp', label: 'Listed', muted: true, sortable: true, render: (l) => formatInstant(l.timestamp) },
  { key: 'property', label: 'Property', render: (l) => <PropertyLink id={l.property_id} label={l.address} /> },
  { key: 'city', label: 'City', muted: true, render: (l) => l.city || NONE },
  { key: 'ask', label: 'Ask', num: true, render: (l) => (l.ask_upx > 0 ? formatUpx(l.ask_upx) : l.ask_fiat > 0 ? formatUsd(l.ask_fiat) : NONE) },
  { key: 'book', label: 'Book', render: (l) => <Badge>{l.ask_upx > 0 ? 'UPX' : 'USD'}</Badge> },
  { key: 'ask_to_mint', label: 'Ask ÷ mint', num: true, sortable: true, render: (l) => formatMultiple(l.ask_to_mint) },
  { key: 'seller', label: 'Seller', render: (l) => <AccountLink account={l.seller} /> },
];

function ListingsView({ params }: { params: ParamSource }) {
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
  const list = useOffsetPages<Listing>(queryKey('/listings', request), (page, c, signal) => c.listings.list({ ...request, ...page }, { signal }), { pageSize: PAGE_SIZE });
  const d = filters.draft;
  const applied = countApplied({ ...request, open: request.open ? undefined : 'all' } as Record<string, unknown>, ['city', 'neighborhood', 'book', 'open']);
  const draftSort = LISTING_SORTS.find((s) => s === d.sort) ?? 'timestamp';
  return (
    <>
      <FilterBar state={filterBarState(filters.dirty, list.fetching && list.paging === null, applied)} appliedCount={applied} onApply={async () => filters.apply()} onReset={filters.reset}>
        <FilterField label="City">
          <SearchFilterField kind="city" label="City" value={d.city} onChange={(v) => filters.set('city', v)} width={180} />
        </FilterField>
        <FilterField label="Neighborhood">
          <SearchFilterField kind="neighborhood" label="Neighborhood" value={d.neighborhood} onChange={(v) => filters.set('neighborhood', v)} width={200} />
        </FilterField>
        <CollectionField />
        <FilterField label="Priced in">
          <Segment<Book>
            size="dense"
            label="Priced in"
            value={d.book === 'upx' || d.book === 'fiat' ? d.book : 'any'}
            onChange={(v) => filters.set('book', v === 'any' ? '' : v)}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'upx', label: 'UPX' },
              { value: 'fiat', label: 'USD' },
            ]}
          />
        </FilterField>
        <FilterField label="Sort">
          <Select<ListingSort>
            size="dense"
            width={140}
            label="Sort"
            value={draftSort}
            onChange={(v) => filters.set('sort', v)}
            options={[
              { value: 'timestamp', label: 'Listed' },
              { value: 'ask_upx', label: 'UPX ask' },
              { value: 'ask_fiat', label: 'USD ask' },
              { value: 'ask_to_mint', label: 'Ask ÷ mint' },
            ]}
          />
        </FilterField>
        <FilterField label="Dir">
          <Segment
            size="dense"
            label="Sort direction"
            value={d.order === 'asc' || d.order === 'desc' ? d.order : draftSort === 'timestamp' ? 'desc' : 'asc'}
            onChange={(v) => filters.set('order', v)}
            options={DIR_OPTIONS}
          />
        </FilterField>
        <Toggle label="Still open only" checked={d.open !== '0'} onChange={(on) => filters.set('open', on ? '' : '0')} style={{ alignSelf: 'center', marginTop: 12 }} />
      </FilterBar>

      <Block id="listings" title={request.open ? 'Active listings' : 'All listings'} note="Decoded events · every 15 min">
        <Region
          query={list}
          skeleton={<DataTable<Listing> columns={LISTING_COLUMNS} rows={[]} loading skeletonRows={10} />}
          emptyMessage="No listings match these filters."
          emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
        >
          {() => (
            <DataTable<Listing>
              columns={LISTING_COLUMNS}
              rows={list.rows}
              rowKey={(l) => `${l.property_id}:${l.timestamp ?? ''}:${l.seller}`}
              sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
              onSort={(s) => filters.applyNow({ sort: s.key, order: s.dir })}
              footer={<ListPager list={list} />}
            />
          )}
        </Region>
      </Block>
    </>
  );
}

/* --- Offers --------------------------------------------------------------------- */

const OFFER_KEYS = ['city', 'buyer', 'seller', 'sort', 'order'] as const;
const OFFER_SORTS = ['timestamp', 'price_upx', 'price_to_mint'] as const;
type OfferSort = (typeof OFFER_SORTS)[number];

const OFFER_COLUMNS: Column<Offer>[] = [
  { key: 'timestamp', label: 'When', muted: true, sortable: true, render: (o) => formatInstant(o.timestamp) },
  { key: 'property', label: 'Property', render: (o) => <PropertyLink id={o.property_id} label={o.address} /> },
  { key: 'city', label: 'City', muted: true, render: (o) => o.city || NONE },
  { key: 'price_upx', label: 'Price', num: true, sortable: true, render: (o) => formatUpx(o.price_upx) },
  { key: 'price_to_mint', label: 'Price ÷ mint', num: true, sortable: true, render: (o) => formatMultiple(o.price_to_mint) },
  { key: 'buyer', label: 'Buyer', render: (o) => <AccountLink account={o.buyer} username={o.buyer_username} /> },
  { key: 'seller', label: 'Seller', hint: 'The seller is the one who accepted the offer', render: (o) => <AccountLink account={o.seller} /> },
];

function OffersView({ params }: { params: ParamSource }) {
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
  const list = useOffsetPages<Offer>(queryKey('/offers', request), (page, c, signal) => c.offers.list({ ...request, ...page }, { signal }), { pageSize: PAGE_SIZE });
  const d = filters.draft;
  const buyerError = accountDraftError(d.buyer);
  const sellerError = accountDraftError(d.seller);
  const applied = countApplied(request as Record<string, unknown>, ['city', 'buyer', 'seller']);
  return (
    <>
      <FilterBar
        state={filterBarState(filters.dirty, list.fetching && list.paging === null, applied)}
        appliedCount={applied}
        onApply={async () => {
          if (buyerError || sellerError) throw new Error('Fix the account names first');
          filters.apply();
        }}
        onReset={filters.reset}
      >
        <FilterField label="City">
          <SearchFilterField kind="city" label="City" value={d.city} onChange={(v) => filters.set('city', v)} width={180} />
        </FilterField>
        <TextField label="Neighborhood" value="" onChange={() => undefined} disabledReason={NO_OFFER_NEIGHBORHOOD} placeholder="Not available" width={160} />
        <CollectionField />
        <TextField label="Buyer account" value={d.buyer} onChange={(v) => filters.set('buyer', v)} error={buyerError} mono maxLength={13} width={150} />
        <TextField label="Seller account" value={d.seller} onChange={(v) => filters.set('seller', v)} error={sellerError} mono maxLength={13} width={150} />
        <FilterField label="Sort">
          <Select<OfferSort>
            size="dense"
            width={140}
            label="Sort"
            value={OFFER_SORTS.find((s) => s === d.sort) ?? 'timestamp'}
            onChange={(v) => filters.set('sort', v)}
            options={[
              { value: 'timestamp', label: 'Time' },
              { value: 'price_upx', label: 'Price' },
              { value: 'price_to_mint', label: 'Price ÷ mint' },
            ]}
          />
        </FilterField>
        <FilterField label="Dir">
          <Segment size="dense" label="Sort direction" value={d.order === 'asc' ? 'asc' : 'desc'} onChange={(v) => filters.set('order', v)} options={DIR_OPTIONS} />
        </FilterField>
      </FilterBar>

      <Block id="offers" title="Accepted offers" note="Off-book sales a seller accepted; never in Sales · market layer">
        <Region
          query={list}
          skeleton={<DataTable<Offer> columns={OFFER_COLUMNS} rows={[]} loading skeletonRows={10} />}
          emptyMessage="No accepted offers match these filters."
          emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
        >
          {() => (
            <DataTable<Offer>
              columns={OFFER_COLUMNS}
              rows={list.rows}
              rowKey={(o) => `${o.offer_id}:${o.trx_id}`}
              sort={{ key: request.sort ?? 'timestamp', dir: request.order ?? 'desc' }}
              onSort={(s) => filters.applyNow({ sort: s.key, order: s.dir })}
              footer={<ListPager list={list} />}
            />
          )}
        </Region>
      </Block>
    </>
  );
}

/* --- Rates ------------------------------------------------------------------------ */

const RATE_KEYS = ['method'] as const;
const RATE_DAYS = 90;
type MethodChoice = 'preferred' | (typeof RATE_METHODS)[number];

const RATE_COLUMNS: Column<RateRow>[] = [
  { key: 'day', label: 'Day', render: (r) => formatDay(r.day) },
  { key: 'method', label: 'Method', mono: true, render: (r) => r.method },
  { key: 'rate', label: 'UPX per $1', num: true, render: (r) => formatRate(r.upx_per_usd) },
  { key: 'band', label: 'p25–p75', num: true, render: (r) => `${formatRate(r.p25)}–${formatRate(r.p75)}` },
  { key: 'samples', label: 'Samples', num: true, render: (r) => formatInt(r.samples) },
  { key: 'cities', label: 'Cities', num: true, render: (r) => formatInt(r.cities) },
  { key: 'listings', label: 'UPX / USD listings', num: true, render: (r) => `${formatInt(r.upx_listings)} / ${formatInt(r.fiat_listings)}` },
];

function RatesView({ params }: { params: ParamSource }) {
  const filters = useFilters(RATE_KEYS, { tab: 'rates' });
  const method = readEnum(params, 'method', RATE_METHODS);
  const chart = useLedgerQuery<UpxUsd>(queryKey('/market/upx-usd', { method, limit: RATE_DAYS }), (c, signal) => c.market.upxUsd({ method, limit: RATE_DAYS }, { signal }), {
    heavy: true,
    isEmpty: (d) => d.points.length === 0,
  });
  const rows = useOffsetPages<RateRow>(queryKey('/rates', { method }), (page, c, signal) => c.rates.list({ method, ...page }, { signal }), { pageSize: PAGE_SIZE });
  const shown = method ?? chart.data?.preferred;
  const series = chart.data && shown ? rateSeries(chart.data, shown) : [];
  return (
    <>
      <FilterBar
        state={filterBarState(filters.dirty, (chart.fetching || rows.fetching) && rows.paging === null, method ? 1 : 0)}
        appliedCount={method ? 1 : 0}
        onApply={async () => filters.apply()}
        onReset={filters.reset}
      >
        <FilterField label="Method">
          <Select<MethodChoice>
            size="dense"
            width={200}
            label="Rate method"
            value={RATE_METHODS.find((m) => m === filters.draft.method) ?? 'preferred'}
            onChange={(v) => filters.set('method', v === 'preferred' ? '' : v)}
            options={[{ value: 'preferred', label: 'Ledger’s preferred' }, ...RATE_METHODS.map((m) => ({ value: m, label: m }))]}
          />
        </FilterField>
      </FilterBar>

      <Block id="rate-chart" title={`UPX per $1, last ${RATE_DAYS} days`} note="Market layer · rebuilt every 6 h at :17">
        <Region query={chart} skeleton={<Skeleton height={300} />} emptyMessage="No rate points for this method yet.">
          {(d) => (
            <Card>
              <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
                Method <code>{shown}</code>
                {shown === d.preferred ? ' (the ledger’s preferred method)' : ''}
                {d.spread !== null ? ` · spread between methods today ${formatRate(d.spread)} UPX` : ''} · {d.notes.join(' ')}
              </span>
              {series.length === 0 ? <p style={{ margin: 0 }}>No points for {shown} in this window.</p> : <RateFigure series={series} method={shown} />}
            </Card>
          )}
        </Region>
      </Block>

      <Block id="rate-rows" title="Daily rate rows" note="/rates, newest first">
        <Region query={rows} skeleton={<DataTable<RateRow> columns={RATE_COLUMNS} rows={[]} loading skeletonRows={8} />} emptyMessage="No rate rows for this method.">
          {() => <DataTable<RateRow> columns={RATE_COLUMNS} rows={rows.rows} rowKey={(r) => `${r.day}:${r.method}`} footer={<ListPager list={rows} />} />}
        </Region>
      </Block>
    </>
  );
}
