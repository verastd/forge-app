'use client';

/**
 * Properties, laid out like the kit's Properties Search screen: a FilterBar
 * (clean / dirty / applying / applied; Apply and Reset), a Min / Max panel
 * of NumberFields, and the results DataTable inside DataState with sortable
 * headers and a Pager. Reads `/properties` (offset pages of 25; filters and
 * sort live in the URL). A bare property id offers a direct link, since
 * `/properties` only lists the properties seen on chain while
 * `/properties/{id}` also knows the rest through the Upland API.
 */
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Block, Button, Card, DataTable, FilterBar, FilterField, NumberField, PageHeader, Pager, Segment, Select, TextField } from '@forge/ui';
import type { Column } from '@forge/ui';
import type { Property, PropertyListParams } from '@forge/upland-ledger';
import { PROPERTY_SORTS } from '@forge/upland-ledger';
import { Suspense, useMemo } from 'react';

import { countApplied, isPropertyId, readEnum, readNumber, readText } from '../_lib/filters';
import { formatDay, formatInt, formatUpx, NONE } from '../_lib/format';
import { useOffsetPages } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';
import { useFilters } from '../_lib/useFilters';
import { Region } from '../_ui/Region';
import { SearchFilterField } from '../_ui/fields';
import { draftNumber, filterBarState, numberDraft } from '../_ui/filterbar';
import { PropertyLink, routes } from '../_ui/links';

const FILTER_KEYS = ['address', 'city', 'min_mint', 'max_mint', 'min_sales', 'sort', 'order'] as const;
const PAGE_SIZE = 25;
type Sort = (typeof PROPERTY_SORTS)[number];

const SORT_LABELS: Record<Sort, string> = {
  mint_price_upx: 'Mint price',
  last_sale_upx: 'Last sale price',
  last_sale_at: 'Last sale date',
  minted_at: 'Mint date',
  sales: 'Sales',
  address: 'Address',
};

const COLUMNS: Column<Property>[] = [
  { key: 'address', label: 'Address', sortable: true, render: (p) => <PropertyLink id={p.property_id} label={p.address} /> },
  { key: 'city', label: 'City', muted: true, render: (p) => [p.city, p.region].filter(Boolean).join(', ') || NONE },
  { key: 'mint_price_upx', label: 'Mint price', num: true, sortable: true, render: (p) => (p.mint_price_upx > 0 ? formatUpx(p.mint_price_upx) : NONE) },
  { key: 'last_sale_upx', label: 'Last sale', num: true, sortable: true, render: (p) => (p.last_sale_upx > 0 ? formatUpx(p.last_sale_upx) : NONE) },
  { key: 'last_sale_at', label: 'Sold', muted: true, sortable: true, render: (p) => formatDay(p.last_sale_at) },
  { key: 'sales', label: 'Sales', num: true, sortable: true, render: (p) => formatInt(p.sales) },
];

export default function PropertiesPage() {
  return (
    <Suspense fallback={<DataTable<Property> columns={COLUMNS} rows={[]} loading />}>
      <Properties />
    </Suspense>
  );
}

function Properties() {
  const params = useSearchParams() ?? new URLSearchParams();
  const filters = useFilters(FILTER_KEYS);
  const request = useMemo<PropertyListParams>(
    () => ({
      address: readText(params, 'address'),
      city: readText(params, 'city', 64),
      min_mint: readNumber(params, 'min_mint', { min: 0 }),
      max_mint: readNumber(params, 'max_mint', { min: 0 }),
      min_sales: readNumber(params, 'min_sales', { min: 0 }),
      sort: readEnum(params, 'sort', PROPERTY_SORTS) ?? 'last_sale_at',
      order: readEnum(params, 'order', ['asc', 'desc'] as const) ?? 'desc',
    }),
    [params],
  );
  const list = useOffsetPages<Property>(queryKey('/properties', request), (page, c, signal) => c.properties.list({ ...request, ...page }, { signal }), {
    pageSize: PAGE_SIZE,
  });

  const d = filters.draft;
  const applied = countApplied(request as Record<string, unknown>, ['address', 'city', 'min_mint', 'max_mint', 'min_sales']);
  const typedId = d.address.trim();

  return (
    <>
      <PageHeader
        title="Properties"
        lede="Every property the chain has seen minted or traded. Open one for its sales, listings and offers."
        aside={<span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>Market layer · rebuilt every 6 h</span>}
      />

      <FilterBar
        state={filterBarState(filters.dirty, list.fetching && list.paging === null, applied)}
        appliedCount={applied}
        onApply={async () => filters.apply()}
        onReset={filters.reset}
      >
        <TextField label="Address contains" value={d.address} onChange={(v) => filters.set('address', v)} placeholder="Main St, or a property id" icon="search" width={240} />
        <FilterField label="City">
          <SearchFilterField kind="city" label="City" value={d.city} onChange={(v) => filters.set('city', v)} />
        </FilterField>
        <FilterField label="Sort">
          <Select<Sort>
            size="dense"
            width={160}
            label="Sort"
            value={PROPERTY_SORTS.find((s) => s === d.sort) ?? 'last_sale_at'}
            onChange={(v) => filters.set('sort', v)}
            options={PROPERTY_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
          />
        </FilterField>
        <FilterField label="Dir">
          <Segment
            size="dense"
            label="Sort direction"
            value={d.order === 'asc' ? 'asc' : 'desc'}
            onChange={(v) => filters.set('order', v)}
            options={[
              { value: 'asc', label: '↑', ariaLabel: 'Ascending' },
              { value: 'desc', label: '↓', ariaLabel: 'Descending' },
            ]}
          />
        </FilterField>
      </FilterBar>

      <Block id="minmax" title="Min / Max" note="Empty means no bound · values apply with Apply">
        <Card style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          <NumberField label="Min mint price" prefix="UPX" min={0} step={1000} width="100%" value={draftNumber(d.min_mint)} onCommit={(v) => filters.set('min_mint', numberDraft(v))} />
          <NumberField label="Max mint price" prefix="UPX" min={0} step={1000} width="100%" value={draftNumber(d.max_mint)} onCommit={(v) => filters.set('max_mint', numberDraft(v))} />
          <NumberField label="Min sales" min={0} width="100%" value={draftNumber(d.min_sales)} onCommit={(v) => filters.set('min_sales', numberDraft(v))} />
        </Card>
      </Block>

      {isPropertyId(typedId) && (
        <p style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
          That looks like a property id.
          <Button as={Link} href={routes.property(typedId)} size="dense" iconRight="chevron-right">
            Open property #{typedId}
          </Button>
        </p>
      )}

      <Block id="results" title="Results" note={list.data ? `Page ${list.page}` : undefined}>
        <Region
          query={list}
          skeleton={<DataTable<Property> columns={COLUMNS} rows={[]} loading skeletonRows={10} />}
          emptyMessage={
            applied > 0
              ? 'No properties on chain match these filters. Properties that never traded or minted on chain aren’t listed; open one by its id instead.'
              : 'The ledger has no properties yet.'
          }
          emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
        >
          {() => (
            <DataTable<Property>
              columns={COLUMNS}
              rows={list.rows}
              rowKey={(p) => p.property_id}
              sort={{ key: request.sort ?? 'last_sale_at', dir: request.order ?? 'desc' }}
              onSort={(s) => filters.applyNow({ sort: s.key, order: s.dir })}
              footer={
                <Pager
                  page={list.page}
                  hasMore={list.hasMore}
                  busy={list.paging}
                  onPage={(p) => (p > list.page ? list.next() : list.previous())}
                />
              }
            />
          )}
        </Region>
      </Block>
    </>
  );
}
