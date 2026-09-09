// What the morning surface reads, and what it refuses to conclude.
//
// ONE READ, ONE AUTHORITY. `CaseWorkspaceService.attention()` already composes
// the governed attention state from every active objective's readiness verdict
// and the open Headlines. This file does not re-derive any of that; it loads it,
// and it turns a thrown read into a NAMED FAILURE rather than an empty page.
//
// THE ORGANIZATION COMES FROM THE SIGNED SESSION, always. Nothing here accepts an
// organization id from a caller, a URL or a form, and the services below resolve
// every row within the organization they are given.
//
// A FAILED READ IS NOT AN EMPTY ONE. `loadAttention` returns a discriminated
// result rather than a nullable view, so a surface literally cannot render the
// success branch on a failure. That shape is the enforcement: an `AttentionView |
// null` would let `?? []` turn an outage into a calm morning, and somebody
// eventually writes that.

import {
  CaseBriefService,
  CaseWorkspaceService,
  HeadlineInvestigationService,
  prisma,
  repositories,
} from '@emgloop/database';
import type { AttentionView } from '@emgloop/database';
import type { CaseBriefView, HeadlineView } from '@emgloop/shared';

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

/** The governed attention state, plus the Headlines behind it. */
export function loadAttention(organizationId: string, now: Date = new Date()) {
  return attempt<AttentionView>("today's headlines", () =>
    new CaseWorkspaceService(prisma).attention(organizationId, now),
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
