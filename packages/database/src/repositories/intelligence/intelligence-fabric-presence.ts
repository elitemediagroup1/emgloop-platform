// Whether the Loop Intelligence PR 2 (fabric) migrations have reached this database. 2026-09-26.
//
// WHY THIS EXISTS. Netlify deploys `main` on every merge; a migration reaches production only when a
// human dispatches it. In between, this code knows columns and tables the database does not have. A read
// that names a missing column fails (P2022), and a failed statement aborts a whole Postgres transaction,
// so the answer must be known BEFORE a transaction starts and before a select names the column.
//
// Each probe asks one thing, outside any transaction. A missing table or column (P2021 / P2022) reads as
// absent; any other error is thrown, so nothing is skipped on a guess. A PRESENT answer is cached for the
// life of the process (a migration is never un-applied); an ABSENT answer is re-asked after a minute, so
// a long-running worker notices the migration without a restart.

import type { PrismaClient } from '@prisma/client';

import { absentUntilMigrated } from '../../creator/until-migrated';

const ABSENT_RECHECK_MS = 60_000;

type Probe = 'digestEntityRefs' | 'entityLinks' | 'refreshQueue' | 'privateSituations';
// Per client: two clients may point at two databases (a test does exactly that), and one database's
// answer must never be read as the other's.
let known = new WeakMap<object, Map<Probe, { present: boolean; at: number }>>();

async function probe(client: object, name: Probe, delegate: unknown, ask: () => Promise<unknown>): Promise<boolean> {
  // A client generated before these models existed has no delegate for them: that is "not migrated".
  if (!delegate) return false;
  let answers = known.get(client);
  if (!answers) known.set(client, (answers = new Map()));
  const cached = answers.get(name);
  if (cached && (cached.present || Date.now() - cached.at < ABSENT_RECHECK_MS)) return cached.present;
  const present = (await absentUntilMigrated(ask().then(() => true))) === true;
  answers.set(name, { present, at: Date.now() });
  return present;
}

/** Test seam: forget what was learned (e.g. after migrating a database mid-test). */
export function forgetIntelligenceFabricPresence(): void {
  known = new WeakMap();
}

/** 20261006000000_intelligence_org_digests: ORGANIZATION digests, per-scope uniqueness, "entityRefs". */
export function digestEntityRefsPresent(prisma: PrismaClient): Promise<boolean> {
  return probe(prisma, 'digestEntityRefs', prisma.intelligenceDigest, () => prisma.intelligenceDigest.findFirst({ select: { entityRefs: true } }));
}

/** 20261006000001_entity_links. */
export function entityLinksPresent(prisma: PrismaClient): Promise<boolean> {
  return probe(prisma, 'entityLinks', prisma.entityLink, () => prisma.entityLink.findFirst({ select: { id: true } }));
}

/** 20261006000002_intelligence_refresh_queue. */
export function refreshQueuePresent(prisma: PrismaClient): Promise<boolean> {
  return probe(prisma, 'refreshQueue', prisma.intelligenceRefreshRequest, () => prisma.intelligenceRefreshRequest.findFirst({ select: { id: true } }));
}

/** 20261008000000_case_private_scopes (Loop Intelligence Phase F). */
export function privateSituationsPresent(prisma: PrismaClient): Promise<boolean> {
  return probe(prisma, 'privateSituations', prisma.casePrivateScope, () => prisma.casePrivateScope.findFirst({ select: { id: true } }));
}

/** What offboarding erasure needs to know, per table, before its transaction starts. */
export interface IntelligenceFabricPresence {
  readonly entityLinks: boolean;
  readonly refreshQueue: boolean;
  readonly privateSituations: boolean;
}

export async function intelligenceFabricPresent(prisma: PrismaClient): Promise<IntelligenceFabricPresence> {
  const [links, queue, situations] = await Promise.all([entityLinksPresent(prisma), refreshQueuePresent(prisma), privateSituationsPresent(prisma)]);
  return { entityLinks: links, refreshQueue: queue, privateSituations: situations };
}
