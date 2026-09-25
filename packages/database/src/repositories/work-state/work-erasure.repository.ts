// ERASING ONE PERSON'S WORK STATE.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §21.2 and §21.3 (row 11),
// approved as initial product policy (Matt, 2026-09-17, D13): when a membership is ended,
// "All `work_*` rows deleted; audit of the acts remains" -- immediately
// (`WORK_TERMINATION_GRACE_DAYS` is 0).
//
// WHY THIS EXISTS. The record assumed the composite foreign key to the membership would do
// this for free, by cascade. It never did: ending a membership is a SOFT change (the row is
// kept and marked), so the cascade never fires, and everything Loop derived from a departed
// person's mailbox and calendar stayed in the database. This is the delete the policy
// promised, performed explicitly, in the caller's transaction.
//
// WHAT IT TOUCHES. Every per-person work table, scoped by the principal and nothing else -- and,
// since Loop Intelligence PR A (2026-09-24), the person's domain-intelligence digests
// (`intelligence_digests`), which are governed by the same retention policy (§21.3,
// INTELLIGENCE_DIGESTS) and go when the membership ends like everything else they derived.
// The organization's retention overrides are policy, not a person's data, and stay. Audit
// rows are governed separately and are untouched.

import type { Prisma, PrismaClient } from '@prisma/client';

import { workScope, type WorkPrincipal } from './work-principal';
import { PRIVATE_SITUATION_SOURCE } from '@emgloop/shared';

/** Every per-person work table this erases, by its table name. */
export const ERASED_WORK_TABLES = Object.freeze([
  'work_item_observations',
  'work_items',
  'work_feedback',
  'work_briefs',
  'work_drafts',
  'work_messages',
  'work_threads',
  'work_correspondents',
  'work_events',
  'work_documents',
  'work_sync_runs',
  'work_source_cursors',
  'employee_work_preferences',
  'intelligence_digests',
  // Loop Intelligence PR 2 (2026-09-26): the person's own entity links and refresh requests. Their
  // ORGANIZATION rows name nobody and are not this person's to erase.
  'entity_links',
  'intelligence_refresh_queue',
  // Loop Intelligence Phase F: the person's private situations -- the Cases their scope row names, which
  // takes the scope row, the Case's log and its evidence with it (cascade).
  'case_private_scopes',
  'situation_candidates',
] as const);
export type ErasedWorkTable = (typeof ERASED_WORK_TABLES)[number];

/** How many rows each table lost. Counts only; never a row. */
export type WorkErasure = Readonly<Record<ErasedWorkTable, number>>;

export class WorkErasureRepository {
  constructor(private readonly db: PrismaClient | Prisma.TransactionClient) {}

  /**
   * Delete everything Loop holds about this one person's work, in the order the foreign keys
   * need (an item's observations before the item). Run it inside the transaction that ends the
   * membership, so there is no moment where the person is gone and their work state is not.
   */
  async eraseAll(
    principal: WorkPrincipal,
    // False ONLY when `intelligenceDigestsPresent` said the table is not migrated yet (there is then
    // nothing to delete). Defaults to deleting, so a caller that forgets fails loudly, never leaks.
    // Each false ONLY when the matching probe said the table is not migrated yet (nothing to delete).
    options: { readonly intelligenceDigests?: boolean; readonly intelligenceFabric?: { readonly entityLinks: boolean; readonly refreshQueue: boolean; readonly privateSituations?: boolean } } = {},
  ): Promise<WorkErasure> {
    const where = workScope(principal);
    const db = this.db;
    const counts = {} as Record<ErasedWorkTable, number>;
    counts.work_item_observations = (await db.workItemObservation.deleteMany({ where })).count;
    counts.work_items = (await db.workItem.deleteMany({ where })).count;
    counts.work_feedback = (await db.workFeedback.deleteMany({ where })).count;
    counts.work_briefs = (await db.workBrief.deleteMany({ where })).count;
    counts.work_drafts = (await db.workDraft.deleteMany({ where })).count;
    counts.work_messages = (await db.workMessage.deleteMany({ where })).count;
    counts.work_threads = (await db.workThread.deleteMany({ where })).count;
    counts.work_correspondents = (await db.workCorrespondent.deleteMany({ where })).count;
    counts.work_events = (await db.workEvent.deleteMany({ where })).count;
    counts.work_documents = (await db.workDocument.deleteMany({ where })).count;
    counts.work_sync_runs = (await db.workSyncRun.deleteMany({ where })).count;
    counts.work_source_cursors = (await db.workSourceCursor.deleteMany({ where })).count;
    counts.employee_work_preferences = (await db.employeeWorkPreferences.deleteMany({ where })).count;
    counts.intelligence_digests = options.intelligenceDigests === false ? 0 : (await db.intelligenceDigest.deleteMany({ where })).count;
    // `where` names the user, so only PRINCIPAL rows match: an ORGANIZATION row's userId is null.
    const fabric = options.intelligenceFabric ?? { entityLinks: true, refreshQueue: true };
    counts.entity_links = fabric.entityLinks ? (await db.entityLink.deleteMany({ where })).count : 0;
    counts.intelligence_refresh_queue = fabric.refreshQueue ? (await db.intelligenceRefreshRequest.deleteMany({ where })).count : 0;
    counts.case_private_scopes = fabric.privateSituations === false ? 0 : (await db.operationalPriority.deleteMany({ where: { organizationId: principal.organizationId, sourceSystem: PRIVATE_SITUATION_SOURCE, privateScope: { is: { userId: principal.userId } } } })).count;
    // `where` names the user, so only the person's own candidates match: the organization's have no userId.
    counts.situation_candidates = fabric.privateSituations === false ? 0 : (await db.situationCandidate.deleteMany({ where })).count;
    return Object.freeze(counts);
  }
}
