// What the Headlines workspace reads, and what it refuses to conclude.
//
// TWO AUTHORITIES, READ SEPARATELY, COMBINED NOWHERE HERE. The Headline record
// (open or set aside, with a basis) and the Case opened from it (its lane, its
// outcome, when it closed) are each read through the service that owns them.
// Where a Headline STANDS is `headlineSituation()` in `@emgloop/shared`, a pure
// projection the surface derives at render time; this file never stores or
// caches an answer to that question, because a stored answer would be a
// Headline lifecycle, and the Headline contract forbids one by design.
//
// ONE READ, ONE AUTHORITY, for the morning. `CaseWorkspaceService.attention()`
// already composes the governed attention state from every active objective's
// readiness verdict and the Headlines. This file does not re-derive any of that;
// it loads it, and it turns a thrown read into a NAMED FAILURE rather than an
// empty page.
//
// THE ORGANIZATION COMES FROM THE SIGNED SESSION, always. Nothing here accepts an
// organization id from a caller, a URL or a form, and the services below resolve
// every row within the organization they are given.
//
// A FAILED READ IS NOT AN EMPTY ONE. Every loader returns a discriminated result
// rather than a nullable view, so a surface literally cannot render the success
// branch on a failure. That shape is the enforcement: an `AttentionView | null`
// would let `?? []` turn an outage into a calm morning, and somebody eventually
// writes that.
//
// NOTHING HERE WRITES. Every export is a read; the only writes on the Headlines
// surfaces are forms posting to guarded server actions.

import {
  CaseBriefService,
  CaseWorkCoordinationService,
  CaseWorkspaceService,
  HeadlineInvestigationService,
  prisma,
  repositories,
} from '@emgloop/database';
import type { AttentionView, HeadlineCaseLifecycle } from '@emgloop/database';
import type { CaseBriefView, CaseCoordinationView, HeadlineView } from '@emgloop/shared';

/**
 * A read that either produced intelligence or could not.
 *
 * NO THIRD BRANCH, AND NO NULLABLE SUCCESS. "Loop looked and found nothing" is
 * inside `ok: true` as a governed attention state; "Loop could not look" is
 * `ok: false`. Those are different facts and the type keeps them apart at every
 * call site.
 */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; what: string };

async function attempt<T>(what: string, read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    // DELIBERATELY SWALLOWS THE DETAIL. An error message can carry row ids,
    // table names and other tenants' identifiers; the surface needs to know a
    // read failed, not what the database said about it.
    return { ok: false, what };
  }
}

/**
 * The governed attention state, plus the Headlines behind it. `dismissed: false` reads only the
 * Headlines nobody has dismissed (Loop Home asks for that); the Headlines surface reads them all.
 */
export function loadAttention(organizationId: string, now: Date = new Date(), options: { readonly dismissed?: boolean } = {}) {
  return attempt<AttentionView>("today's headlines", () =>
    new CaseWorkspaceService(prisma).attention(organizationId, now, options),
  );
}

/** One Headline, for the investigation surface. */
export function loadHeadline(organizationId: string, headlineId: string) {
  return attempt<HeadlineView | null>('this headline', () =>
    repositories.headlines.get(organizationId, headlineId),
  );
}

/**
 * Whether this Headline is already under investigation.
 *
 * READ THROUGH THE AUTHORITATIVE LINEAGE, not a convenience column. A Case's
 * identity IS `investigationRecurrenceKey(headlineId)`, so the service resolves
 * it the same way a repeated Investigate press does -- which is why pressing
 * twice converges instead of opening a second investigation.
 *
 * THIS READ CREATES NOTHING. It is the same guarantee the service documents:
 * rendering a Headline, expanding it, or opening its evidence writes nothing
 * anywhere.
 */
export function loadExistingCase(organizationId: string, headlineId: string) {
  return attempt<{ caseId: string; humanAuthorizationRecorded: boolean } | null>(
    'the investigation for this headline',
    () => new HeadlineInvestigationService(prisma).findCaseForHeadline(organizationId, headlineId),
  );
}

/** The Case brief, for the surfaces that show what an investigation established. */
export function loadBrief(organizationId: string, caseId: string) {
  return attempt<CaseBriefView | null>('this investigation', () =>
    new CaseBriefService(prisma).get(organizationId, caseId),
  );
}

/**
 * Every Headline this organization holds -- current and historical -- optionally
 * for one objective.
 *
 * `dismissed` IS DELIBERATELY NOT PASSED, so set-aside Headlines are read with
 * the rest: the workspace is the one place all of a Headline's history lives,
 * and a read that dropped the dismissed ones would be an archive by omission.
 * The objective filter is the repository's own option, not a filter applied
 * here; a cross-organization objective id matches nothing.
 */
export function loadHeadlinesForWorkspace(
  organizationId: string,
  options: { readonly performanceObjectiveId?: string } = {},
) {
  return attempt<readonly HeadlineView[]>('the headlines for this objective', () =>
    repositories.headlines.list(organizationId, {
      take: 200,
      ...(options.performanceObjectiveId
        ? { performanceObjectiveId: options.performanceObjectiveId }
        : {}),
    }),
  );
}

/**
 * Where the investigations behind a list of Headlines stand, in one query.
 *
 * THE SECOND AUTHORITY, BATCHED. Each Headline's Case is resolved through the
 * same identity `loadExistingCase` uses, so a list and a detail page can never
 * disagree about which thread a Headline opened. A Headline that never opened
 * one is absent from the map; a Headline in another organization resolves to
 * nothing. The lane, outcome and close time are the Case's own projection
 * columns, carried and never re-derived.
 *
 * THIS READ CREATES NOTHING.
 */
export function loadCasesForHeadlines(organizationId: string, headlineIds: readonly string[]) {
  return attempt<ReadonlyMap<string, HeadlineCaseLifecycle>>(
    'the investigations behind these headlines',
    () => new HeadlineInvestigationService(prisma).findCasesForHeadlines(organizationId, headlineIds),
  );
}

/** One objective's identity and title, for naming a filtered list. Cross-org is null. */
export function loadObjective(organizationId: string, objectiveId: string) {
  return attempt<{ id: string; title: string } | null>('this objective', async () => {
    const objective = await repositories.performanceObjectives.get(organizationId, objectiveId);
    return objective ? { id: objective.id, title: objective.title } : null;
  });
}

/**
 * What a Case asked for, and where that work stands -- read from Work OS through
 * the same coordination read the Case Workspace composes, and owned by Work OS.
 *
 * READ-ONLY, AND THE HEADLINE SURFACE DOES NOT CREATE WORK. There is no path
 * from a Headline or a Case to a new work item in this build; this shows what a
 * Case already references and links to the Case, which is where the work is
 * read in full.
 */
export function loadCoordination(organizationId: string, caseId: string, now: Date = new Date()) {
  return attempt<CaseCoordinationView | null>('the work behind this investigation', () =>
    new CaseWorkCoordinationService(prisma).get(organizationId, caseId, now),
  );
}
