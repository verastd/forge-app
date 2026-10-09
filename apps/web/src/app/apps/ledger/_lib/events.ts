/**
 * Property history events (`/properties/{id}/history`) for display. The
 * ledger doesn't publish the list of `event_type` values (only
 * `property_sale` is documented, with its fields), so known types get a
 * label and anything else is shown under its own humanized name.
 */
import type { PropertyEvent } from '@forge/upland-ledger';

import { humanize } from './format';

const EVENT_LABELS: Record<string, string> = {
  property_sale: 'Sale',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? humanize(type.replace(/^property_/, ''));
}

/**
 * Listing activity for one property. `/listings` cannot filter by property,
 * so a property's listings come from its own history: any event whose type
 * names a listing.
 */
export function isListingEvent(event: PropertyEvent): boolean {
  return /list/i.test(event.event_type);
}

/** Which side of the event the history's `account` is, in words. */
export function eventParties(event: PropertyEvent): { from: string | null; to: string | null } {
  if (event.event_type === 'property_sale') {
    // For a sale the history row's account is the buyer (the new owner) and the counterparty the seller.
    return { from: event.counterparty || null, to: event.account || null };
  }
  return { from: event.account || null, to: event.counterparty || null };
}

/** A string field from `fields`, or null. */
export function fieldString(event: PropertyEvent, key: string): string | null {
  const v = event.fields[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A numeric field from `fields`, or null. */
export function fieldNumber(event: PropertyEvent, key: string): number | null {
  const v = event.fields[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
