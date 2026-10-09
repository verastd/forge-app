'use client';

/**
 * Properties: a filterable, paginated list over `/properties` (offset
 * pages of 25, filters applied on submit, kept in the URL). A bare property
 * id in the address box offers a direct link to that property, since
 * `/properties` only lists the ~398 K properties seen on chain while
 * `/properties/{id}` also knows the rest through the Upland API.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import type { Property, PropertyListParams } from '@forge/upland-ledger';
import { PROPERTY_SORTS } from '@forge/upland-ledger';

import { DataState } from '../_components/DataState';
import { DataTable, ListPager, TableSkeleton } from '../_components/DataTable';
import { FilterBar, NumberField, SortFields, TextField } from '../_components/FilterBar';
import { LayerNote } from '../_components/Freshness';
import { PropertyLink, routes } from '../_components/links';
import { ButtonLink, SkeletonRows } from '../_components/primitives';
import { countApplied, isPropertyId, numberDraftError, readEnum, readNumber, readText } from '../_lib/filters';
import { formatDay, formatInt, formatUpx, NONE } from '../_lib/format';
import { useOffsetPages } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';
import { useFilters } from '../_lib/useFilters';

const FILTER_KEYS = ['address', 'city', 'min_mint', 'max_mint', 'min_sales', 'sort', 'order'] as const;
const PAGE_SIZE = 25;

const SORT_LABELS: Record<(typeof PROPERTY_SORTS)[number], string> = {
  mint_price_upx: 'Mint price',
  last_sale_upx: 'Last sale price',
  last_sale_at: 'Last sale date',
  minted_at: 'Mint date',
  sales: 'Number of sales',
  address: 'Address',
};

const COLUMNS = [
  { key: 'address', label: 'Property' },
  { key: 'city', label: 'City' },
  { key: 'mint', label: 'Mint price' },
  { key: 'last', label: 'Last sale' },
  { key: 'when', label: 'Sold' },
  { key: 'sales', label: 'Sales' },
];

export default function PropertiesPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Properties />
    </Suspense>
  );
}

function Properties() {
  const params = useSearchParams();
  const filters = useFilters(FILTER_KEYS);

  const request = useMemo<PropertyListParams>(() => {
    const p = params ?? new URLSearchParams();
    return {
      address: readText(p, 'address'),
      city: readText(p, 'city', 64),
      min_mint: readNumber(p, 'min_mint', { min: 0 }),
      max_mint: readNumber(p, 'max_mint', { min: 0 }),
      min_sales: readNumber(p, 'min_sales', { min: 0 }),
      sort: readEnum(p, 'sort', PROPERTY_SORTS) ?? 'last_sale_at',
      order: readEnum(p, 'order', ['asc', 'desc'] as const) ?? 'desc',
    };
  }, [params]);

  const list = useOffsetPages<Property>(
    queryKey('/properties', request),
    (page, c, signal) => c.properties.list({ ...request, ...page }, { signal }),
    { pageSize: PAGE_SIZE },
  );

  const d = filters.draft;
  const errors = {
    min_mint: numberDraftError(d.min_mint),
    max_mint: numberDraftError(d.max_mint),
    min_sales: numberDraftError(d.min_sales),
  };
  const invalid = Object.values(errors).find((e) => e !== null) ?? null;
  const typedId = d.address.trim();
  const applied = countApplied(request as Record<string, unknown>, ['address', 'city', 'min_mint', 'max_mint', 'min_sales']);

  return (
    <>
      <div className="em-page-head">
        <div>
          <h1 className="em-h1">Properties</h1>
          <p className="em-lede">Every property the chain has seen minted or traded. Open one for its sales, listings and offers.</p>
        </div>
        <LayerNote layer="market" updatedAt={list.updatedAt} />
      </div>

      <FilterBar
        label="Filter properties"
        dirty={filters.dirty}
        applying={list.fetching && list.paging === null}
        invalid={invalid}
        appliedCount={applied}
        onApply={filters.apply}
        onReset={filters.reset}
      >
        <TextField label="Address contains" value={d.address} onChange={(v) => filters.set('address', v)} placeholder="e.g. Main St, or a property id" width={220} />
        <TextField label="City" value={d.city} onChange={(v) => filters.set('city', v)} placeholder="e.g. Cleveland" maxLength={64} />
        <NumberField label="Min mint price" prefix="UPX" value={d.min_mint} onChange={(v) => filters.set('min_mint', v)} step={1000} />
        <NumberField label="Max mint price" prefix="UPX" value={d.max_mint} onChange={(v) => filters.set('max_mint', v)} step={1000} />
        <NumberField label="Min sales" value={d.min_sales} onChange={(v) => filters.set('min_sales', v)} width={110} />
        <SortFields
          value={PROPERTY_SORTS.find((s) => s === d.sort) ?? 'last_sale_at'}
          onChange={(v) => filters.set('sort', v)}
          options={PROPERTY_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
          dir={d.order === 'asc' ? 'asc' : 'desc'}
          onDir={(v) => filters.set('order', v)}
        />
      </FilterBar>

      {isPropertyId(typedId) && (
        <p className="em-row em-caption">
          That looks like a property id.
          <ButtonLink href={routes.property(typedId)} size="dense" variant="secondary" icon="chevron-right">
            Open property #{typedId}
          </ButtonLink>
        </p>
      )}

      <DataState
        query={list}
        label="properties"
        skeleton={<TableSkeleton columns={COLUMNS} rows={10} />}
        empty={
          applied > 0
            ? 'No properties on chain match these filters. Properties that have never traded or minted on chain aren’t listed; open one by its id instead.'
            : 'The ledger has no properties yet.'
        }
        emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
      >
        {() => (
          <DataTable
            caption="Properties"
            sort={{ key: request.sort ?? 'last_sale_at', dir: request.order ?? 'desc' }}
            onSort={(next) => filters.applyNow({ sort: next.key, order: next.dir })}
            rows={list.rows}
            rowKey={(p) => p.property_id}
            columns={[
              { key: 'address', label: 'Property', wrap: true, sortKey: 'address', render: (p) => <PropertyLink id={p.property_id} label={p.address} /> },
              { key: 'city', label: 'City', muted: true, render: (p) => [p.city, p.region].filter(Boolean).join(', ') || NONE },
              { key: 'mint', label: 'Mint price', num: true, sortKey: 'mint_price_upx', render: (p) => (p.mint_price_upx > 0 ? formatUpx(p.mint_price_upx) : NONE) },
              { key: 'last', label: 'Last sale', num: true, sortKey: 'last_sale_upx', render: (p) => (p.last_sale_upx > 0 ? formatUpx(p.last_sale_upx) : NONE) },
              { key: 'when', label: 'Sold', muted: true, sortKey: 'last_sale_at', render: (p) => formatDay(p.last_sale_at) },
              { key: 'sales', label: 'Sales', num: true, sortKey: 'sales', render: (p) => formatInt(p.sales) },
            ]}
            footer={
              <ListPager list={list} />
            }
          />
        )}
      </DataState>
    </>
  );
}
