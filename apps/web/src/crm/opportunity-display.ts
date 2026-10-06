// How a CRM Opportunity's references read to staff (CRM slice 4). PURE: no I/O, no clock, no React.
//
// The read model says what is known; this only words it. Unknown stays unknown, in words that
// cannot be mistaken for a value: "Unassigned" is the absence of an owner, never a person called
// that. Several BRANDs or PRIMARY_CONTACTs are all named -- none is picked as "the" one.
//
// A PRIMARY_CONTACT is the contact for this Opportunity, nothing more: it is not employment and
// implies no AFFILIATION with any brand, so no wording here joins a contact to a company.

import type {
  CrmOpportunityGap,
  CrmOpportunityListFiltersV1,
  CrmOpportunityPartyRefV1,
  CrmOpportunityUserRefV1,
} from '@emgloop/shared';
import { crmContactPointReasonCarriesContactValue, CRM_OPPORTUNITY_SEARCH_MAX } from '@emgloop/shared';

import { governedTerm } from './subject-display';

export const OPPORTUNITIES_HREF = '/app/crm/opportunities';
export const opportunityHref = (opportunityId: string) => `${OPPORTUNITIES_HREF}/${encodeURIComponent(opportunityId)}`;

export const PRIMARY_CONTACT_WORDING = 'Primary contact for this Opportunity';

export interface PartyRefDisplay {
  readonly text: string;
  /** Whether `text` is the Party's recorded name (rather than a description of it). */
  readonly named: boolean;
  /** A qualifier a person should see next to it, if any. */
  readonly note: string | null;
  /** The id to open, when it can be opened. The canonical id for a superseded reference. */
  readonly openPartyId: string | null;
}

/** One Party reference, worded. Never a guessed name. */
export function partyRefDisplay(ref: CrmOpportunityPartyRefV1): PartyRefDisplay {
  if (ref.state === 'UNAVAILABLE') {
    return { text: 'Unavailable record', named: false, note: 'This reference cannot be followed in this workspace.', openPartyId: null };
  }
  const kind = ref.partyType === 'COMPANY' ? 'A company' : 'A person';
  const name = ref.name?.trim() || null;
  const text = name ?? `${kind} (name not shown)`;
  if (ref.state === 'SUPERSEDED') {
    return { text, named: name !== null, note: 'Recorded under an earlier record, since merged.', openPartyId: ref.canonicalPartyId };
  }
  const notes = [ref.state === 'NOT_ESTABLISHED' ? 'Not established' : null, ref.archived ? 'Archived' : null].filter(Boolean);
  return { text, named: name !== null, note: notes.length ? notes.join(' · ') : null, openPartyId: ref.partyId };
}

/** All of them, in order, or what their absence means. */
export function partyRefsText(refs: readonly CrmOpportunityPartyRefV1[], none: string): string {
  return refs.length === 0 ? none : refs.map((r) => partyRefDisplay(r).text).join(', ');
}

export function ownerText(owner: CrmOpportunityUserRefV1 | null): string {
  if (owner === null) return 'Unassigned';
  if (owner.state === 'UNAVAILABLE') return 'Not a member of this workspace';
  return owner.displayName ?? 'A workspace member';
}

export function memberText(user: CrmOpportunityUserRefV1 | null, none = 'Not recorded'): string {
  return user === null ? none : ownerText(user);
}

export const GAP_LABELS: Readonly<Record<CrmOpportunityGap, string>> = Object.freeze({
  NO_OWNER: 'No owner',
  NO_BRAND: 'No brand',
  NO_PRIMARY_CONTACT: 'No primary contact',
});

/** The organization's category value, worded. Stages are the organization's own labels and are shown as recorded. */
export function categoryText(category: string): string {
  if (category === 'CLOSED_WON') return 'Closed – won';
  if (category === 'CLOSED_LOST') return 'Closed – lost';
  return governedTerm(category);
}

/** A forecast amount in minor units, worded without assuming a currency that was not recorded. */
export function amountText(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null) return null;
  const major = (amountMinor / 100).toFixed(2);
  return currency ? `${currency} ${major}` : `${major} (currency not recorded)`;
}

// --- URL filters -----------------------------------------------------------------------

export const OPPORTUNITY_FILTER_KEYS = ['q', 'owner', 'category', 'stage', 'creator', 'brand', 'contact'] as const;
type FilterKey = (typeof OPPORTUNITY_FILTER_KEYS)[number];
export type OpportunitySearchParams = Partial<Record<FilterKey | 'after', string | string[]>>;

export type ParsedOpportunityFilters =
  | { readonly ok: true; readonly filters: CrmOpportunityListFiltersV1; readonly params: Readonly<Partial<Record<FilterKey, string>>> }
  /** The search text looked like an email address or phone number. Contact values are not searchable. */
  | { readonly ok: false; readonly params: Readonly<Partial<Record<FilterKey, string>>> };

const one = (v: string | string[] | undefined): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};

/**
 * Read the list filters from the URL. Unknown values are dropped, not guessed. Search text that
 * carries a contact value is refused: it is never searched, and the caller redirects it away so
 * it does not stay in the address bar.
 */
export function parseOpportunityFilters(sp: OpportunitySearchParams | undefined): ParsedOpportunityFilters {
  const params: Partial<Record<FilterKey, string>> = {};
  const q = one(sp?.q)?.slice(0, CRM_OPPORTUNITY_SEARCH_MAX) ?? null;
  const owner = one(sp?.owner);
  const category = one(sp?.category);
  const stage = one(sp?.stage);
  const creator = one(sp?.creator);
  const brand = one(sp?.brand);
  const contact = one(sp?.contact);
  if (owner) params.owner = owner;
  if (category && ['OPEN', 'CLOSED_WON', 'CLOSED_LOST'].includes(category)) params.category = category;
  if (stage) params.stage = stage;
  if (creator) params.creator = creator;
  if (brand === 'PRESENT' || brand === 'MISSING') params.brand = brand;
  if (contact === 'PRESENT' || contact === 'MISSING') params.contact = contact;
  if (q && crmContactPointReasonCarriesContactValue(q)) return { ok: false, params };
  if (q) params.q = q;
  return {
    ok: true,
    params,
    filters: {
      q: params.q ?? null,
      owner: params.owner ?? null,
      category: params.category ?? null,
      stage: params.stage ?? null,
      creatorPartyId: params.creator ?? null,
      brand: (params.brand as 'PRESENT' | 'MISSING' | undefined) ?? null,
      primaryContact: (params.contact as 'PRESENT' | 'MISSING' | undefined) ?? null,
    },
  };
}

/** The list URL for these filters (and, optionally, a cursor). Never carries an organization. */
export function opportunitiesListHref(params: Readonly<Partial<Record<string, string>>>, after?: string | null): string {
  const search = new URLSearchParams();
  for (const key of OPPORTUNITY_FILTER_KEYS) {
    const value = params[key];
    if (value) search.set(key, value);
  }
  if (after) search.set('after', after);
  const s = search.toString();
  return s ? `${OPPORTUNITIES_HREF}?${s}` : OPPORTUNITIES_HREF;
}
