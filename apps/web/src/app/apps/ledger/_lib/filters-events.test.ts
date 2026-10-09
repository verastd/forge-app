import { describe, expect, it } from 'vitest';
import { PropertyHistorySchema } from '@forge/upland-ledger';
import type { PropertyEvent } from '@forge/upland-ledger';

import { eventLabel, eventParties, fieldNumber, fieldString, isListingEvent } from './events';
import {
  accountDraftError,
  countApplied,
  hrefWith,
  isPropertyId,
  numberDraftError,
  readAccount,
  readEnum,
  readFlag,
  readNumber,
  readText,
} from './filters';
import { fixture } from './fixtures.test-helper';

const history = fixture('GET_properties_{propertyId}_history', PropertyHistorySchema);

describe('property history events (GET_properties_{propertyId}_history)', () => {
  const sale = history.data[0]!;

  it('labels a sale and reads buyer and seller the right way round', () => {
    expect(eventLabel(sale.event_type)).toBe('Sale');
    // The captured sale: ymc55j4fboxi bought from tlifor1bq435 (same trx in GET_sales.json).
    expect(eventParties(sale)).toEqual({ from: 'tlifor1bq435', to: 'ymc55j4fboxi' });
    expect(fieldString(sale, 'owner_username')).toBe('kingbo');
    expect(fieldNumber(sale, 'price_upx')).toBe(29999);
    expect(fieldString(sale, 'price_upx')).toBeNull();
    expect(fieldNumber(sale, 'owner_username')).toBeNull();
  });

  it('humanizes event types it has no label for', () => {
    expect(eventLabel('property_listing_cancelled')).toBe('Listing cancelled');
    expect(eventLabel('fee_paid')).toBe('Fee paid');
  });

  it('finds listing events by type and passes other parties through', () => {
    const listing: PropertyEvent = { ...sale, event_type: 'property_listing', account: 'abc', counterparty: '' };
    expect(isListingEvent(listing)).toBe(true);
    expect(isListingEvent(sale)).toBe(false);
    expect(eventParties(listing)).toEqual({ from: 'abc', to: null });
  });
});

describe('URL filters', () => {
  const p = new URLSearchParams({
    city: '  Rome ',
    empty: '',
    min: '12.5',
    neg: '-1',
    bad: 'x',
    sort: 'price_upx',
    open: '1',
    buyer: 'YMC55J4FBOXI',
    seller: 'not an account',
  });

  it('reads text, numbers, enums and flags defensively', () => {
    expect(readText(p, 'city')).toBe('Rome');
    expect(readText(p, 'empty')).toBeUndefined();
    expect(readText(p, 'missing')).toBeUndefined();
    expect(readText(new URLSearchParams({ q: 'abcdef' }), 'q', 3)).toBe('abc');
    expect(readNumber(p, 'min')).toBe(12.5);
    expect(readNumber(p, 'neg', { min: 0 })).toBeUndefined();
    expect(readNumber(p, 'min', { max: 10 })).toBeUndefined();
    expect(readNumber(p, 'bad')).toBeUndefined();
    expect(readNumber(p, 'empty')).toBeUndefined();
    expect(readEnum(p, 'sort', ['timestamp', 'price_upx'] as const)).toBe('price_upx');
    expect(readEnum(p, 'city', ['timestamp'] as const)).toBeUndefined();
    expect(readFlag(p, 'open')).toBe(true);
    expect(readFlag(p, 'city')).toBe(false);
  });

  it('only passes real chain accounts (the ledger 400s on anything else)', () => {
    expect(readAccount(p, 'buyer')).toBe('ymc55j4fboxi');
    expect(readAccount(p, 'seller')).toBeUndefined();
    expect(accountDraftError('')).toBeNull();
    expect(accountDraftError('ymc55j4fboxi')).toBeNull();
    expect(accountDraftError('kingbo!')).toMatch(/Not an Upland chain account/);
  });

  it('validates numeric drafts and property ids', () => {
    expect(numberDraftError('')).toBeNull();
    expect(numberDraftError('100')).toBeNull();
    expect(numberDraftError('abc')).toBe('Enter a number');
    expect(numberDraftError('-5')).toBe('Must be 0 or more');
    expect(isPropertyId('81826746578110')).toBe(true);
    expect(isPropertyId('123456789012345678901')).toBe(false);
    expect(isPropertyId('12a')).toBe(false);
  });

  it('builds hrefs without empty values and counts applied filters', () => {
    expect(hrefWith('/apps/ledger/market', { tab: 'listings', city: 'Rome', open: true, all: false, x: '', y: undefined })).toBe(
      '/apps/ledger/market?tab=listings&city=Rome&open=1',
    );
    expect(hrefWith('/apps/ledger', {})).toBe('/apps/ledger');
    expect(countApplied({ city: 'Rome', buyer: undefined, min: 0, open: false, q: '' }, ['city', 'buyer', 'min', 'open', 'q'])).toBe(2);
  });
});
