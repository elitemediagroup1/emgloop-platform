// Persistence of the CRM import authority (CRM slice 5). Organization-scoped everywhere; no method
// reads or writes another organization's rows, and none stores a contact value, a name or a note.
//
// Persistence only: `CrmImportConfigService` and `CrmImportService` authorize every act and run
// every CRM write through the governed Party, Contact Point and Opportunity services. This file is
// not a security boundary, and says so.

import type { CrmImportEntry, CrmImportRun, Prisma, PrismaClient } from '@prisma/client';

export type CrmImportDb = PrismaClient | Prisma.TransactionClient;

export interface CrmImportAliasRow {
  readonly id: string;
  readonly aliasKey: string;
  readonly aliasText: string;
  readonly creatorPartyId: string;
}

export interface CrmImportRouteRow {
  readonly id: string;
  readonly routeKey: string;
  readonly routeText: string;
  readonly classification: string;
  readonly targetCompanyPartyId: string | null;
  readonly proposedCompanyName: string | null;
  readonly representedBrandPartyId: string | null;
  readonly representedBrandRouteKey: string | null;
}

export interface CrmImportEntryInput {
  readonly line: number;
  readonly sourceRowKey: string | null;
  readonly rowFingerprint: string | null;
  readonly routeMappingId: string | null;
  readonly routeClassification: string | null;
  readonly creatorAliasId: string | null;
  readonly pursuitKey: string | null;
  readonly outcome: string;
  readonly ambiguityCode: string | null;
  readonly companyAction: string | null;
  readonly personAction: string | null;
  readonly opportunityAction: string | null;
  readonly contactPointActions: readonly { readonly kind: string; readonly classification: string; readonly action: string }[];
}

const ALIAS_SELECT = { id: true, aliasKey: true, aliasText: true, creatorPartyId: true } as const;
const ROUTE_SELECT = {
  id: true,
  routeKey: true,
  routeText: true,
  classification: true,
  targetCompanyPartyId: true,
  proposedCompanyName: true,
  representedBrandPartyId: true,
  representedBrandRouteKey: true,
} as const;

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export class CrmImportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Reviewed mappings ---------------------------------------------------------------------

  activeAliases(organizationId: string, db: CrmImportDb = this.prisma): Promise<CrmImportAliasRow[]> {
    return db.crmImportCreatorAlias.findMany({ where: { organizationId, state: 'ACTIVE' }, select: ALIAS_SELECT, orderBy: { aliasKey: 'asc' } });
  }

  activeRoutes(organizationId: string, db: CrmImportDb = this.prisma): Promise<CrmImportRouteRow[]> {
    return db.crmImportRouteMapping.findMany({ where: { organizationId, state: 'ACTIVE' }, select: ROUTE_SELECT, orderBy: { routeKey: 'asc' } });
  }

  /** Append-only: write a new ACTIVE alias, retiring `replacingId` first when given. */
  async recordAlias(
    organizationId: string,
    input: { aliasKey: string; aliasText: string; creatorPartyId: string; actorUserId: string; replacingId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<CrmImportAliasRow> {
    if (input.replacingId) await this.retire(tx, 'alias', organizationId, input.replacingId, input.actorUserId);
    const row = await tx.crmImportCreatorAlias.create({
      data: { organizationId, aliasKey: input.aliasKey, aliasText: input.aliasText, creatorPartyId: input.creatorPartyId, state: 'ACTIVE', activeKey: input.aliasKey, createdByUserId: input.actorUserId },
      select: ALIAS_SELECT,
    });
    if (input.replacingId) await tx.crmImportCreatorAlias.updateMany({ where: { id: input.replacingId, organizationId }, data: { replacedById: row.id } });
    return row;
  }

  async recordRoute(
    organizationId: string,
    input: Omit<CrmImportRouteRow, 'id'> & { actorUserId: string; replacingId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<CrmImportRouteRow> {
    if (input.replacingId) await this.retire(tx, 'route', organizationId, input.replacingId, input.actorUserId);
    const { actorUserId, replacingId, ...fields } = input;
    const row = await tx.crmImportRouteMapping.create({
      data: { organizationId, ...fields, state: 'ACTIVE', activeKey: fields.routeKey, createdByUserId: actorUserId },
      select: ROUTE_SELECT,
    });
    if (replacingId) await tx.crmImportRouteMapping.updateMany({ where: { id: replacingId, organizationId }, data: { replacedById: row.id } });
    return row;
  }

  private async retire(tx: Prisma.TransactionClient, kind: 'alias' | 'route', organizationId: string, id: string, actorUserId: string): Promise<void> {
    const data = { state: 'RETIRED', activeKey: null, retiredAt: new Date(), retiredByUserId: actorUserId };
    // Guarded on ACTIVE: a concurrent replacement retires it once, and this one then finds nothing.
    const where = { id, organizationId, state: 'ACTIVE' };
    const { count } = kind === 'alias' ? await tx.crmImportCreatorAlias.updateMany({ where, data }) : await tx.crmImportRouteMapping.updateMany({ where, data });
    if (count !== 1) throw new CrmImportConcurrentChange();
  }

  // --- Runs ----------------------------------------------------------------------------------

  createRun(
    organizationId: string,
    input: {
      mode: 'DRY_RUN' | 'APPLY';
      importerVersion: string;
      sourceRef: string;
      sourceSha256: string;
      configFingerprint: string;
      startedByUserId: string;
      approvalId: string | null;
      planDigest: string | null;
      rowCount: number;
      counts: Record<string, number>;
    },
    db: CrmImportDb = this.prisma,
  ): Promise<CrmImportRun> {
    return db.crmImportRun.create({
      data: {
        organizationId,
        mode: input.mode,
        state: 'RUNNING',
        importerVersion: input.importerVersion,
        sourceType: 'CSV',
        sourceRef: input.sourceRef,
        sourceSha256: input.sourceSha256,
        configFingerprint: input.configFingerprint,
        planDigest: input.planDigest,
        rowCount: input.rowCount,
        counts: input.counts as Prisma.InputJsonValue,
        approvalId: input.approvalId,
        // One APPLY at a time per organization: the unique lock is the authority, not a process.
        applyLockKey: input.mode === 'APPLY' ? organizationId : null,
        startedByUserId: input.startedByUserId,
      },
    });
  }

  /** Finish a RUNNING run and release its lock. Guarded on RUNNING: an abandoned run stays abandoned. */
  async completeRun(organizationId: string, runId: string, input: { state: 'SUCCEEDED' | 'FAILED'; failureCodes: string[]; counts?: Record<string, number> }): Promise<boolean> {
    const { count } = await this.prisma.crmImportRun.updateMany({
      where: { id: runId, organizationId, state: 'RUNNING' },
      data: { state: input.state, failureCodes: input.failureCodes, completedAt: new Date(), applyLockKey: null, ...(input.counts ? { counts: input.counts as Prisma.InputJsonValue } : {}) },
    });
    return count === 1;
  }

  /** Release a stuck RUNNING run (its process died). Compare-and-set on RUNNING. */
  async abandonRun(organizationId: string, runId: string, actorUserId: string): Promise<boolean> {
    const { count } = await this.prisma.crmImportRun.updateMany({
      where: { id: runId, organizationId, state: 'RUNNING' },
      data: { state: 'ABANDONED', applyLockKey: null, completedAt: new Date(), abandonedByUserId: actorUserId },
    });
    return count === 1;
  }

  findRun(organizationId: string, runId: string): Promise<CrmImportRun | null> {
    if (!organizationId?.trim() || !runId?.trim()) return Promise.resolve(null);
    return this.prisma.crmImportRun.findFirst({ where: { id: runId, organizationId } });
  }

  listRuns(organizationId: string, limit = 20): Promise<CrmImportRun[]> {
    return this.prisma.crmImportRun.findMany({ where: { organizationId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: Math.min(100, Math.max(1, limit)) });
  }

  /** Whether an APPLY of this approval already succeeded: an approval is executed once. */
  async approvalExecuted(organizationId: string, approvalId: string): Promise<boolean> {
    return (await this.prisma.crmImportRun.count({ where: { organizationId, approvalId, mode: 'APPLY', state: 'SUCCEEDED' } })) > 0;
  }

  // --- Approvals -----------------------------------------------------------------------------

  createApproval(
    organizationId: string,
    input: { dryRunId: string; sourceSha256: string; importerVersion: string; configFingerprint: string; planDigest: string; approvedByUserId: string },
    db: CrmImportDb = this.prisma,
  ) {
    return db.crmImportApproval.create({ data: { organizationId, ...input } });
  }

  findApproval(organizationId: string, approvalId: string) {
    if (!organizationId?.trim() || !approvalId?.trim()) return Promise.resolve(null);
    return this.prisma.crmImportApproval.findFirst({ where: { id: approvalId, organizationId } });
  }

  // --- Entries -------------------------------------------------------------------------------

  async writeEntries(organizationId: string, importRunId: string, entries: readonly CrmImportEntryInput[], db: CrmImportDb = this.prisma): Promise<void> {
    for (let i = 0; i < entries.length; i += 500) {
      await db.crmImportEntry.createMany({
        data: entries.slice(i, i + 500).map((e) => ({
          organizationId,
          importRunId,
          line: e.line,
          sourceRowKey: e.sourceRowKey,
          rowFingerprint: e.rowFingerprint,
          routeMappingId: e.routeMappingId,
          routeClassification: e.routeClassification,
          creatorAliasId: e.creatorAliasId,
          pursuitKey: e.pursuitKey,
          outcome: e.outcome,
          ambiguityCode: e.ambiguityCode,
          companyAction: e.companyAction,
          personAction: e.personAction,
          opportunityAction: e.opportunityAction,
          contactPointActions: e.contactPointActions as unknown as Prisma.InputJsonValue,
        })),
      });
    }
  }

  /** Record the subjects a committed unit produced, on the run's entries for those lines. */
  async recordResults(
    organizationId: string,
    importRunId: string,
    lines: readonly number[],
    results: { companyPartyId?: string; personPartyId?: string; opportunityId?: string; contactPointIds?: readonly string[] },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (lines.length === 0) return;
    const { contactPointIds, ...ids } = results;
    if (Object.keys(ids).length > 0) await tx.crmImportEntry.updateMany({ where: { organizationId, importRunId, line: { in: [...lines] } }, data: ids });
    if (contactPointIds && contactPointIds.length > 0) {
      const rows = await tx.crmImportEntry.findMany({ where: { organizationId, importRunId, line: { in: [...lines] } }, select: { id: true, contactPointIds: true } });
      for (const row of rows) {
        await tx.crmImportEntry.update({ where: { id: row.id }, data: { contactPointIds: [...new Set([...row.contactPointIds, ...contactPointIds])] } });
      }
    }
  }

  async markApplied(organizationId: string, importRunId: string, lines: readonly number[], at: Date): Promise<void> {
    if (lines.length === 0) return;
    await this.prisma.crmImportEntry.updateMany({ where: { organizationId, importRunId, line: { in: [...lines] } }, data: { appliedAt: at } });
  }

  entries(organizationId: string, importRunId: string): Promise<CrmImportEntry[]> {
    return this.prisma.crmImportEntry.findMany({ where: { organizationId, importRunId }, orderBy: { line: 'asc' } });
  }

  /** The latest APPLIED entry per source row key, from any earlier APPLY in this organization. */
  async priorEntries(organizationId: string, rowKeys: readonly string[]): Promise<Map<string, { fingerprint: string | null; outcome: string }>> {
    const out = new Map<string, { fingerprint: string | null; outcome: string }>();
    for (let i = 0; i < rowKeys.length; i += 1000) {
      const rows = await this.prisma.crmImportEntry.findMany({
        where: { organizationId, sourceRowKey: { in: rowKeys.slice(i, i + 1000) as string[] }, appliedAt: { not: null }, run: { mode: 'APPLY' } },
        select: { sourceRowKey: true, rowFingerprint: true, outcome: true, appliedAt: true },
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      });
      for (const r of rows) if (r.sourceRowKey && !out.has(r.sourceRowKey)) out.set(r.sourceRowKey, { fingerprint: r.rowFingerprint, outcome: r.outcome });
    }
    return out;
  }

  // --- Import keys (idempotency) ------------------------------------------------------------

  async importKeys(organizationId: string, db: CrmImportDb = this.prisma): Promise<Map<string, string>> {
    const rows = await db.crmImportKey.findMany({ where: { organizationId }, select: { keyKind: true, keyValue: true, subjectId: true } });
    return new Map(rows.map((r) => [`${r.keyKind}:${r.keyValue}`, r.subjectId]));
  }

  findKey(organizationId: string, keyKind: string, keyValue: string, db: CrmImportDb = this.prisma) {
    return db.crmImportKey.findFirst({ where: { organizationId, keyKind, keyValue }, select: { subjectId: true } });
  }

  /** Claim a key for a subject created in the same transaction. A unique violation means another run got there first. */
  claimKey(
    organizationId: string,
    input: { keyKind: 'COMPANY' | 'PERSON' | 'OPPORTUNITY'; keyValue: string; subjectId: string; importRunId: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.crmImportKey.create({
      data: { organizationId, keyKind: input.keyKind, keyValue: input.keyValue, subjectType: input.keyKind === 'OPPORTUNITY' ? 'CRM_OPPORTUNITY' : 'PARTY', subjectId: input.subjectId, importRunId: input.importRunId },
    });
  }

  // --- Existing pursuits ---------------------------------------------------------------------

  /** Opportunities of these creators with an ACTIVE BRAND among these Companies, by `<creator>|<brand>`. */
  async existingPursuits(organizationId: string, creatorPartyIds: readonly string[], brandPartyIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (creatorPartyIds.length === 0 || brandPartyIds.length === 0) return out;
    const rows = await this.prisma.crmOpportunity.findMany({
      where: {
        organizationId,
        creatorPartyId: { in: [...new Set(creatorPartyIds)] },
        participants: { some: { organizationId, role: 'BRAND', state: 'ACTIVE', partyId: { in: [...new Set(brandPartyIds)] } } },
      },
      select: { id: true, creatorPartyId: true, participants: { where: { organizationId, role: 'BRAND', state: 'ACTIVE' }, select: { partyId: true } } },
    });
    for (const r of rows) {
      for (const p of r.participants) {
        const key = `${r.creatorPartyId}|${p.partyId}`;
        out.set(key, [...(out.get(key) ?? []), r.id]);
      }
    }
    return out;
  }
}

/** A mapping changed between read and write. Nothing was written; the caller re-reads. */
export class CrmImportConcurrentChange extends Error {
  constructor() {
    super('CRM import mapping changed concurrently');
    this.name = 'CrmImportConcurrentChange';
  }
}
