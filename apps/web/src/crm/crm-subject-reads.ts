// Read models for the redesigned CRM slice: People, a Person, Relationships and a
// Relationship (handoff 2026-09-16, pp. 6-8).
//
// COMPOSITION ONLY. Every fact comes from its authority, through the services that
// already check the viewer's permission before reading: `PartyRecordService`
// (identityResolution) and `CrmRelationshipReadService` (relationships). Nothing
// here widens a permission, reads Prisma, or invents a value. What an authority
// cannot say (opportunities, campaigns, contact details, Party activity) is left
// out and named as unavailable by the page.
//
// Each read fails on its own. A failed or refused secondary read (relationship
// context, a Party's name) degrades that part to "unavailable"; only the subject's
// own read decides the page's outcome.
//
// BOUNDED. A People page reads at most one relationship page per row (25 rows),
// and names are read only for the Parties on the page. A list projection that
// carries relationship context would remove the per-row reads; it does not exist yet.
//
// Takes its services as arguments so tests can drive it; `crm-slice-data.ts` binds
// the real ones to the signed session.

import type {
  CrmRelationshipCapabilitiesV1,
  CrmRelationshipListItemV1,
  CrmRelationshipListPageV1,
  CrmRelationshipRecordV1,
  PartyListItemV1,
  PartyListPageV1,
  PartyRecordV1,
  PartyViewerCapabilitiesV1,
} from '@emgloop/shared';
import {
  crmPartyId,
  partyListSubject,
  partyRecordSubject,
  partyRelationshipContext,
  relationshipSubject,
  type PartyRelationshipContext,
  type SubjectDisplay,
} from './subject-display';

type PartyResult<T> =
  | { outcome: 'OK'; value: T; capabilities: PartyViewerCapabilitiesV1 }
  | { outcome: 'NOT_AUTHORIZED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_CURSOR' };

type RelationshipResult<T> =
  | { readonly outcome: 'OK'; readonly value: T; readonly capabilities: CrmRelationshipCapabilitiesV1 }
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'INVALID_CURSOR' };

export interface CrmSubjectReadDeps {
  readonly listPeople: (opts: { cursor?: string | null; limit?: number }) => Promise<PartyResult<PartyListPageV1>>;
  readonly establishmentQueue: (opts: { limit?: number; partyType?: 'PERSON' | 'COMPANY' | null }) => Promise<PartyResult<PartyListPageV1>>;
  readonly partyRecord: (partyId: string) => Promise<PartyResult<PartyRecordV1>>;
  readonly relationships: (opts: { cursor?: string | null; limit?: number; includeVoided?: boolean }) => Promise<RelationshipResult<CrmRelationshipListPageV1>>;
  readonly relationshipsForParty: (partyId: string) => Promise<RelationshipResult<CrmRelationshipListPageV1>>;
  readonly relationship: (relationshipId: string) => Promise<RelationshipResult<CrmRelationshipRecordV1>>;
  readonly workspaceName: () => Promise<string | null>;
}

/** A secondary read: its value, or why there is none. */
export type Secondary<T> = { readonly state: 'OK'; readonly value: T } | { readonly state: 'NOT_AUTHORIZED' } | { readonly state: 'FAILED' };

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

async function secondaryRelationships(deps: CrmSubjectReadDeps, partyId: string): Promise<Secondary<readonly CrmRelationshipListItemV1[]>> {
  const read = await attempt(() => deps.relationshipsForParty(partyId));
  if (!read.ok) return { state: 'FAILED' };
  if (read.value.outcome === 'OK') return { state: 'OK', value: read.value.value.items };
  if (read.value.outcome === 'NOT_AUTHORIZED') return { state: 'NOT_AUTHORIZED' };
  return { state: 'FAILED' };
}

/** Names for the given Parties, when the viewer may read them. Missing names stay missing. */
export async function partyNames(deps: CrmSubjectReadDeps, partyIds: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(partyIds)].slice(0, 50);
  const names = new Map<string, string>();
  await Promise.all(
    unique.map(async (id) => {
      const read = await attempt(() => deps.partyRecord(id));
      if (read.ok && read.value.outcome === 'OK') {
        const name = read.value.value.displayName?.trim();
        if (name) names.set(id, name);
      }
    }),
  );
  return names;
}

async function workspaceNameOrNull(deps: CrmSubjectReadDeps): Promise<string | null> {
  const read = await attempt(() => deps.workspaceName());
  return read.ok ? read.value : null;
}

function otherSideIds(partyId: string, items: readonly CrmRelationshipListItemV1[]): string[] {
  return items.flatMap((r) => r.sides.map((s) => crmPartyId(s.party)).filter((id): id is string => id !== null && id !== partyId));
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PeopleRow {
  readonly item: PartyListItemV1;
  readonly context: PartyRelationshipContext;
  readonly subject: SubjectDisplay;
}

export type PeopleDirectory =
  | { readonly outcome: 'NOT_AUTHORIZED' | 'INVALID_CURSOR' | 'FAILED' }
  | {
      readonly outcome: 'OK';
      readonly rows: readonly PeopleRow[];
      readonly nextCursor: string | null;
      readonly firstPage: boolean;
      readonly capabilities: PartyViewerCapabilitiesV1;
      /** People awaiting identity review: a count, or why there is none. `more` when the count was capped. */
      readonly review: Secondary<{ readonly count: number; readonly more: boolean }>;
      /** True when relationship context could not be read for at least one row. */
      readonly partialContext: boolean;
    };

export const PEOPLE_PAGE_SIZE = 25;
const REVIEW_COUNT_CAP = 100;

export async function readPeopleDirectory(
  deps: CrmSubjectReadDeps,
  opts: { cursor?: string | null; personHref: (partyId: string) => string },
): Promise<PeopleDirectory> {
  const listed = await attempt(() => deps.listPeople({ cursor: opts.cursor ?? null, limit: PEOPLE_PAGE_SIZE }));
  if (!listed.ok) return { outcome: 'FAILED' };
  const page = listed.value;
  if (page.outcome === 'NOT_AUTHORIZED') return { outcome: 'NOT_AUTHORIZED' };
  if (page.outcome !== 'OK') return { outcome: page.outcome === 'INVALID_CURSOR' ? 'INVALID_CURSOR' : 'FAILED' };

  const items = page.value.items.filter((i) => i.partyType === 'PERSON');
  const [contexts, workspaceName, review] = await Promise.all([
    Promise.all(items.map((i) => secondaryRelationships(deps, i.partyId))),
    workspaceNameOrNull(deps),
    (async (): Promise<Secondary<{ count: number; more: boolean }>> => {
      const read = await attempt(() => deps.establishmentQueue({ limit: REVIEW_COUNT_CAP, partyType: 'PERSON' }));
      if (!read.ok) return { state: 'FAILED' };
      if (read.value.outcome === 'NOT_AUTHORIZED') return { state: 'NOT_AUTHORIZED' };
      if (read.value.outcome !== 'OK') return { state: 'FAILED' };
      return { state: 'OK', value: { count: read.value.value.items.length, more: read.value.value.nextCursor !== null } };
    })(),
  ]);

  const names = await partyNames(
    deps,
    items.flatMap((item, i) => {
      const ctx = contexts[i]!;
      return ctx.state === 'OK' ? otherSideIds(item.partyId, ctx.value) : [];
    }),
  );

  const rows = items.map((item, i) => {
    const ctx = contexts[i]!;
    const context = partyRelationshipContext(item.partyId, ctx.state === 'OK' ? ctx.value : null, names, workspaceName);
    // A table row: the relationship has its own column.
    return { item, context, subject: partyListSubject(item, context, opts.personHref(item.partyId), { withRelationship: false }) };
  });

  return {
    outcome: 'OK',
    rows,
    nextCursor: page.value.nextCursor,
    firstPage: !opts.cursor,
    capabilities: page.capabilities,
    review,
    partialContext: contexts.some((c) => c.state !== 'OK'),
  };
}

// ---------------------------------------------------------------------------
// A Person
// ---------------------------------------------------------------------------

export type PersonView =
  | { readonly outcome: 'NOT_FOUND' | 'FAILED' }
  | {
      readonly outcome: 'OK';
      readonly record: PartyRecordV1;
      readonly capabilities: PartyViewerCapabilitiesV1;
      readonly subject: SubjectDisplay;
      readonly context: PartyRelationshipContext;
      readonly relationships: Secondary<readonly SubjectDisplay[]>;
      /** The Party that replaced this one, when it was superseded. */
      readonly current: { readonly partyId: string; readonly name: string | null } | null;
    };

export async function readPersonView(
  deps: CrmSubjectReadDeps,
  partyId: string,
  hrefs: { relationship: (id: string) => string },
): Promise<PersonView> {
  const read = await attempt(() => deps.partyRecord(partyId));
  if (!read.ok) return { outcome: 'FAILED' };
  // Refused and missing read the same: another tenant's id is not-found, never forbidden.
  if (read.value.outcome !== 'OK') return { outcome: 'NOT_FOUND' };
  const record = read.value.value;
  // A Company is not a Person; this route does not render one.
  if (record.partyType !== 'PERSON') return { outcome: 'NOT_FOUND' };

  const [rels, workspaceName] = await Promise.all([secondaryRelationships(deps, partyId), workspaceNameOrNull(deps)]);
  const canonicalId = record.reference.state === 'SUPERSEDED' ? record.reference.canonicalPartyId : null;
  const names = await partyNames(deps, [
    ...(rels.state === 'OK' ? otherSideIds(partyId, rels.value) : []),
    ...(canonicalId ? [canonicalId] : []),
  ]);
  // The person's own name is already read: their relationship cards name them too.
  const ownName = record.displayName?.trim();
  if (ownName) names.set(partyId, ownName);
  const context = partyRelationshipContext(partyId, rels.state === 'OK' ? rels.value : null, names, workspaceName);
  const relationships: Secondary<readonly SubjectDisplay[]> =
    rels.state === 'OK'
      ? {
          state: 'OK',
          value: rels.value.map((r) => relationshipSubject(r, names, workspaceName, hrefs.relationship(r.relationshipId))),
        }
      : rels;

  return {
    outcome: 'OK',
    record,
    capabilities: read.value.capabilities,
    subject: partyRecordSubject(record, context),
    context,
    relationships,
    current: canonicalId ? { partyId: canonicalId, name: names.get(canonicalId) ?? null } : null,
  };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export type RelationshipDirectory =
  | { readonly outcome: 'NOT_AUTHORIZED' | 'INVALID_CURSOR' | 'FAILED' }
  | {
      readonly outcome: 'OK';
      readonly subjects: readonly SubjectDisplay[];
      readonly nextCursor: string | null;
      readonly firstPage: boolean;
      readonly capabilities: CrmRelationshipCapabilitiesV1;
      /** False when Party names could not be read: sides then show as "A person" / "A company". */
      readonly namesReadable: boolean;
    };

export const RELATIONSHIPS_PAGE_SIZE = 24;

export async function readRelationshipDirectory(
  deps: CrmSubjectReadDeps,
  opts: { cursor?: string | null; includeVoided: boolean; href: (id: string) => string },
): Promise<RelationshipDirectory> {
  const listed = await attempt(() => deps.relationships({ cursor: opts.cursor ?? null, limit: RELATIONSHIPS_PAGE_SIZE, includeVoided: opts.includeVoided }));
  if (!listed.ok) return { outcome: 'FAILED' };
  const page = listed.value;
  if (page.outcome === 'NOT_AUTHORIZED') return { outcome: 'NOT_AUTHORIZED' };
  if (page.outcome !== 'OK') return { outcome: page.outcome === 'INVALID_CURSOR' ? 'INVALID_CURSOR' : 'FAILED' };
  const ids = page.value.items.flatMap((r) => r.sides.map((s) => crmPartyId(s.party)).filter((id): id is string => id !== null));
  const [names, workspaceName] = await Promise.all([partyNames(deps, ids), workspaceNameOrNull(deps)]);
  return {
    outcome: 'OK',
    subjects: page.value.items.map((r) => relationshipSubject(r, names, workspaceName, opts.href(r.relationshipId))),
    nextCursor: page.value.nextCursor,
    firstPage: !opts.cursor,
    capabilities: page.capabilities,
    namesReadable: ids.length === 0 || names.size > 0,
  };
}

export type RelationshipView =
  | { readonly outcome: 'NOT_FOUND' | 'FAILED' }
  | {
      readonly outcome: 'OK';
      readonly record: CrmRelationshipRecordV1;
      readonly capabilities: CrmRelationshipCapabilitiesV1;
      readonly subject: SubjectDisplay;
      readonly names: ReadonlyMap<string, string>;
      readonly workspaceName: string | null;
    };

export async function readRelationshipView(deps: CrmSubjectReadDeps, relationshipId: string): Promise<RelationshipView> {
  const read = await attempt(() => deps.relationship(relationshipId));
  if (!read.ok) return { outcome: 'FAILED' };
  if (read.value.outcome !== 'OK') return { outcome: 'NOT_FOUND' };
  const record = read.value.value;
  const ids = [
    ...record.sides.map((s) => crmPartyId(s.party)),
    ...record.participants.map((p) => crmPartyId(p.party)),
  ].filter((id): id is string => id !== null);
  const [names, workspaceName] = await Promise.all([partyNames(deps, ids), workspaceNameOrNull(deps)]);
  return {
    outcome: 'OK',
    record,
    capabilities: read.value.capabilities,
    subject: relationshipSubject(record, names, workspaceName, null),
    names,
    workspaceName,
  };
}
