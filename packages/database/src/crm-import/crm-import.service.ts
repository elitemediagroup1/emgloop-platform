// The governed CRM outreach importer (CRM slice 5): validate, dry run, approve, apply.
//
// A COORDINATOR, NEVER A SECOND CRM AUTHORITY. Every CRM write goes through the governed services
// -- `PartyService` (create, establish MANUAL), `CrmContactPointService.add` (basis IMPORTED),
// `CrmOpportunityService` (create, addParticipant) -- each with its own authorization, validation,
// Party Reference check, audit row and outbox event. This service only plans, records provenance,
// and composes those acts into atomic units with the caller-transaction variants.
//
// THE SEQUENCE, AND WHAT EACH STEP PROVES:
//   1. DRY RUN (EMPLOYEE+): parse, look up, plan. Writes a run and its entries -- ids, codes and a
//      keyed row fingerprint -- and NO CRM row. Identical source + configuration -> identical plan.
//   2. APPROVE (OWNER/ADMIN): binds one successful dry run's source SHA-256, importer version,
//      configuration fingerprint and plan digest.
//   3. APPLY (OWNER/ADMIN): claims the approval -- CONSUMED THE MOMENT A RUN CLAIMS IT, whatever that
//      run's outcome (a UNIQUE key in the database) -- re-plans, and refuses unless all four still
//      match the approval exactly;
//      takes the organization's APPLY lock (a unique key in the database, not a process); executes
//      Company units, then Person units, then pursuit units, each in ONE transaction; a unit that
//      cannot complete rolls back whole. PRODUCTION APPLY IS NOT COMMISSIONED: it is refused.
//
// IDEMPOTENT BY CONSTRUCTION. Every created subject is claimed under a deterministic import key in
// the same transaction that creates it (unique per organization). A retried, resumed or concurrent
// unit finds the key and reuses the subject, or loses the race and rolls back; a Contact Point or
// Participant already present is the governed service's DUPLICATE, which is a no-op here. A row
// fully applied and unchanged is ALREADY_IMPORTED_UNCHANGED; a changed row is never silently
// re-applied (SOURCE_ROW_CHANGED). After an interrupted APPLY, a new dry run and approval resume
// exactly the remaining work.
//
// PRIVACY. Nothing here logs. Provenance holds hashes, keys, codes and subject ids; values exist in
// memory only, long enough to be handed to the Contact Point authority.

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CRM_IMPORT_VERSION,
  crmContactPointSourceRefValid,
  crmImportKey,
  crmImportPersonEligible,
  isCrmImportRouteClassification,
  normalizeCrmContactPointValue,
  parseCrmImportCsv,
  validateCrmImportStageMapping,
  type CrmContactPointKind,
  type CrmImportSourceRow,
  type CrmImportStageMappingEntry,
  type PartyReferenceResolution,
} from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { CrmContactPointRepository, crmContactPointValueHash } from '../repositories/crm-contact-point.repository';
import { identifierKeyFingerprint, keyedDigest } from '../repositories/cognitive/hashing';
import { PartyService } from '../services/party.service';
import { CrmContactPointService } from '../services/crm-contact-point.service';
import { CrmOpportunityService } from '../services/crm-opportunity.service';
import { crmImportPermits, type CrmImportActor } from './crm-import-access';
import { CrmImportRepository, isUniqueViolation, type CrmImportEntryInput } from './crm-import.repository';
import {
  planCrmImport,
  type CrmImportAliasView,
  type CrmImportCompanyView,
  type CrmImportMatchView,
  type CrmImportPlan,
  type CrmImportPlanRowInput,
  type CrmImportPlannedCompany,
  type CrmImportPlannedPerson,
  type CrmImportPlannedPursuit,
  type CrmImportRouteView,
} from './crm-import-plan';

/** Where an APPLY may run. Only a local or test database, until the production path is commissioned (PR B). */
export type CrmImportExecutionTarget = 'LOCAL_TEST' | 'PRODUCTION';

export interface CrmImportSource {
  /** The canonical CSV text. */
  readonly csvText: string;
  /** Opaque, contact-free provenance of where the file came from (`local`, later an object key). */
  readonly sourceRef: string;
}

export interface CrmImportInvalidRow {
  readonly line: number;
  readonly sourceRowKey: string | null;
  readonly violations: readonly string[];
}

export interface CrmImportPrepared {
  readonly sourceSha256: string;
  readonly importerVersion: typeof CRM_IMPORT_VERSION;
  /** One-way fingerprint of the identifier key this plan matched with (never the key). */
  readonly keyFingerprint: string;
  readonly configFingerprint: string;
  readonly planDigest: string;
  readonly plan: CrmImportPlan;
  /** The parsed rows, in memory only, for the operator's protected review artifact. */
  readonly rows: readonly CrmImportSourceRow[];
  readonly invalid: readonly CrmImportInvalidRow[];
  readonly counts: Readonly<Record<string, number>>;
}

export type CrmImportPrepareResult =
  | { readonly outcome: 'OK'; readonly prepared: CrmImportPrepared }
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'SOURCE_INVALID'; readonly problem: string; readonly column?: string; readonly position?: number }
  | { readonly outcome: 'STAGE_MAPPING_INVALID'; readonly violations: readonly { at: string; code: string }[] }
  | { readonly outcome: 'SOURCE_REF_INVALID' }
  /**
   * The organization's Contact Points were hashed under a different key than this process holds, so
   * exact matching could not find them and the plan would propose duplicates. Refused, never guessed.
   */
  | { readonly outcome: 'HASH_KEY_MISMATCH'; readonly keyFingerprint: string; readonly mismatchedContactPoints: number };

export type CrmImportApplyResult =
  | { readonly outcome: 'APPLIED' | 'APPLIED_WITH_FAILURES'; readonly runId: string; readonly counts: Readonly<Record<string, number>>; readonly failureCodes: readonly string[] }
  | { readonly outcome: 'NOT_AUTHORIZED' | 'PRODUCTION_APPLY_NOT_COMMISSIONED' | 'TARGET_REFUSED' | 'APPROVAL_NOT_FOUND' | 'DRY_RUN_NOT_SUCCEEDED' | 'APPROVAL_ALREADY_EXECUTED' | 'APPLY_IN_PROGRESS' }
  | { readonly outcome: 'APPROVAL_MISMATCH'; readonly mismatched: readonly ('SOURCE' | 'IMPORTER_VERSION' | 'CONFIGURATION' | 'PLAN')[] }
  | Exclude<CrmImportPrepareResult, { outcome: 'OK' }>;

export interface CrmImportServiceDeps {
  imports?: CrmImportRepository;
  references?: Pick<PartyReferenceRepository, 'resolveMany'>;
  iam?: Pick<IamRepository, 'canEach'>;
  parties?: PartyService;
  contactPoints?: CrmContactPointService;
  opportunities?: CrmOpportunityService;
  /** Whether this process's database may be written by an APPLY. Defaults to: a local database, not production. */
  applyTargetGuard?: () => boolean;
  clock?: () => Date;
}

type Tx = Prisma.TransactionClient;

const UNIT_TIMEOUT_MS = 60_000;
const SOURCE_REF_PREFIX = `${CRM_IMPORT_VERSION}:`;

/** A unit the governed services refused: its transaction rolls back whole. */
class UnitRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'UnitRefused';
  }
}

export class CrmImportService {
  private readonly imports: CrmImportRepository;
  private readonly references: Pick<PartyReferenceRepository, 'resolveMany'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly parties: PartyService;
  private readonly contactPoints: CrmContactPointService;
  private readonly opportunities: CrmOpportunityService;
  private readonly applyTargetGuard: () => boolean;
  private readonly clock: () => Date;
  private readonly contactPointRows: Pick<CrmContactPointRepository, 'hashKeyFingerprints'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmImportServiceDeps = {},
  ) {
    this.imports = deps.imports ?? new CrmImportRepository(prisma);
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.parties = deps.parties ?? new PartyService(prisma);
    this.contactPoints = deps.contactPoints ?? new CrmContactPointService(prisma);
    this.opportunities = deps.opportunities ?? new CrmOpportunityService(prisma);
    this.applyTargetGuard = deps.applyTargetGuard ?? localDatabaseOnly;
    this.clock = deps.clock ?? (() => new Date());
    this.contactPointRows = new CrmContactPointRepository(prisma);
  }

  // --- Dry run ---------------------------------------------------------------------------------

  /** Plan the source and record the run and its entries. Writes no CRM row. */
  async dryRun(
    actor: CrmImportActor,
    source: CrmImportSource,
    stageMapping: readonly CrmImportStageMappingEntry[],
  ): Promise<{ outcome: 'OK'; runId: string; prepared: CrmImportPrepared } | Exclude<CrmImportPrepareResult, { outcome: 'OK' }>> {
    if (!(await crmImportPermits(this.prisma, this.iam, actor, 'DRY_RUN'))) return { outcome: 'NOT_AUTHORIZED' };
    const prepared = await this.prepare(actor, source, stageMapping);
    if (prepared.outcome !== 'OK') return prepared;
    const p = prepared.prepared;
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await this.imports.createRun(
        actor.organizationId,
        { mode: 'DRY_RUN', importerVersion: p.importerVersion, sourceRef: source.sourceRef, sourceSha256: p.sourceSha256, configFingerprint: p.configFingerprint, startedByUserId: actor.userId, approvalId: null, planDigest: p.planDigest, rowCount: p.rows.length + p.invalid.length, counts: { ...p.counts } },
        tx,
      );
      await this.imports.writeEntries(actor.organizationId, created.id, entriesOf(p), tx);
      return created;
    });
    await this.imports.completeRun(actor.organizationId, run.id, { state: 'SUCCEEDED', failureCodes: [] });
    return { outcome: 'OK', runId: run.id, prepared: p };
  }

  // --- Approval --------------------------------------------------------------------------------

  /** Approve one successful dry run for APPLY: binds its source, importer version, configuration and plan. */
  async approve(actor: CrmImportActor, dryRunId: string): Promise<{ outcome: 'APPROVED'; approvalId: string } | { outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'DRY_RUN_NOT_SUCCEEDED' | 'IMPORTER_VERSION_CHANGED' | 'ALREADY_APPROVED' }> {
    if (!(await crmImportPermits(this.prisma, this.iam, actor, 'APPROVE_APPLY'))) return { outcome: 'NOT_AUTHORIZED' };
    const run = await this.imports.findRun(actor.organizationId, dryRunId);
    if (!run || run.mode !== 'DRY_RUN') return { outcome: 'NOT_FOUND' };
    if (run.state !== 'SUCCEEDED' || !run.planDigest) return { outcome: 'DRY_RUN_NOT_SUCCEEDED' };
    // A plan made under another importer version is never reinterpreted under this one.
    if (run.importerVersion !== CRM_IMPORT_VERSION) return { outcome: 'IMPORTER_VERSION_CHANGED' };
    try {
      const approval = await this.imports.createApproval(actor.organizationId, {
        dryRunId: run.id,
        sourceSha256: run.sourceSha256,
        importerVersion: run.importerVersion,
        configFingerprint: run.configFingerprint,
        planDigest: run.planDigest,
        approvedByUserId: actor.userId,
      });
      return { outcome: 'APPROVED', approvalId: approval.id };
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'ALREADY_APPROVED' };
      throw err;
    }
  }

  // --- Apply -----------------------------------------------------------------------------------

  async apply(
    actor: CrmImportActor,
    input: { source: CrmImportSource; stageMapping: readonly CrmImportStageMappingEntry[]; approvalId: string; executionTarget: CrmImportExecutionTarget },
  ): Promise<CrmImportApplyResult> {
    if (!(await crmImportPermits(this.prisma, this.iam, actor, 'APPLY'))) return { outcome: 'NOT_AUTHORIZED' };
    // FAIL CLOSED. The production path (private source, OIDC, approvals in production) is PR B.
    if (input.executionTarget !== 'LOCAL_TEST') return { outcome: 'PRODUCTION_APPLY_NOT_COMMISSIONED' };
    if (!this.applyTargetGuard()) return { outcome: 'TARGET_REFUSED' };

    const org = actor.organizationId;
    const approval = await this.imports.findApproval(org, input.approvalId);
    if (!approval) return { outcome: 'APPROVAL_NOT_FOUND' };
    // CONSUMED WHEN CLAIMED. Any APPLY run that ever owned this approval -- succeeded, failed or
    // abandoned -- has used it up. Recovery is a new dry run and a new approval, never this one.
    if (await this.imports.approvalClaimed(org, approval.id)) return { outcome: 'APPROVAL_ALREADY_EXECUTED' };
    const dryRun = await this.imports.findRun(org, approval.dryRunId);
    if (!dryRun || dryRun.state !== 'SUCCEEDED') return { outcome: 'DRY_RUN_NOT_SUCCEEDED' };

    const prepared = await this.prepare(actor, input.source, input.stageMapping);
    if (prepared.outcome !== 'OK') return prepared;
    const p = prepared.prepared;
    const mismatched: ('SOURCE' | 'IMPORTER_VERSION' | 'CONFIGURATION' | 'PLAN')[] = [];
    if (p.sourceSha256 !== approval.sourceSha256) mismatched.push('SOURCE');
    if (p.importerVersion !== approval.importerVersion) mismatched.push('IMPORTER_VERSION');
    if (p.configFingerprint !== approval.configFingerprint) mismatched.push('CONFIGURATION');
    if (p.planDigest !== approval.planDigest) mismatched.push('PLAN');
    if (mismatched.length > 0) return { outcome: 'APPROVAL_MISMATCH', mismatched };

    // Inserting the APPLY run IS the claim: `approvalId` is UNIQUE, so of two concurrent claims of one
    // approval exactly one inserts. The organization's APPLY lock is a second unique key on the same row.
    let runId: string;
    try {
      const run = await this.imports.createRun(org, {
        mode: 'APPLY',
        importerVersion: p.importerVersion,
        sourceRef: input.source.sourceRef,
        sourceSha256: p.sourceSha256,
        configFingerprint: p.configFingerprint,
        startedByUserId: actor.userId,
        approvalId: approval.id,
        planDigest: p.planDigest,
        rowCount: p.rows.length + p.invalid.length,
        counts: { ...p.counts },
      });
      runId = run.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Which unique key refused is not trusted from the error: whichever constraint Postgres checks
        // first is not part of the contract. Ask the one question that decides the outcome.
        if (await this.imports.approvalClaimed(org, approval.id)) return { outcome: 'APPROVAL_ALREADY_EXECUTED' };
        return { outcome: 'APPLY_IN_PROGRESS' };
      }
      throw err;
    }

    await this.imports.writeEntries(org, runId, entriesOf(p));
    const result = await this.execute(actor, runId, p);
    const counts = { ...p.counts, ...result.counts };
    await this.imports.markApplied(org, runId, result.appliedLines, this.clock());
    await this.imports.completeRun(org, runId, { state: result.failureCodes.length === 0 ? 'SUCCEEDED' : 'FAILED', failureCodes: result.failureCodes, counts });
    return { outcome: result.failureCodes.length === 0 ? 'APPLIED' : 'APPLIED_WITH_FAILURES', runId, counts, failureCodes: result.failureCodes };
  }

  /**
   * Release an APPLY whose process died. OWNER/ADMIN. The units it committed stand. Its approval stays
   * consumed: the remaining work needs a fresh dry run and a new approval.
   */
  async abandon(actor: CrmImportActor, runId: string): Promise<{ outcome: 'ABANDONED' | 'NOT_AUTHORIZED' | 'NOT_RUNNING' }> {
    if (!(await crmImportPermits(this.prisma, this.iam, actor, 'APPLY'))) return { outcome: 'NOT_AUTHORIZED' };
    return { outcome: (await this.imports.abandonRun(actor.organizationId, runId, actor.userId)) ? 'ABANDONED' : 'NOT_RUNNING' };
  }

  // --- Planning --------------------------------------------------------------------------------

  /** Parse, look everything up, and plan. Reads only; writes nothing. */
  async prepare(actor: CrmImportActor, source: CrmImportSource, stageMapping: readonly CrmImportStageMappingEntry[]): Promise<CrmImportPrepareResult> {
    if (!(await crmImportPermits(this.prisma, this.iam, actor, 'DRY_RUN'))) return { outcome: 'NOT_AUTHORIZED' };
    if (!crmContactPointSourceRefValid(source.sourceRef)) return { outcome: 'SOURCE_REF_INVALID' };
    const stageViolations = stageMapping.flatMap((e, i) => validateCrmImportStageMapping(e).map((code) => ({ at: `stageMapping[${i}]`, code })));
    const statusKeys = stageMapping.map((e) => crmImportKey(e.sourceStatus));
    statusKeys.forEach((k, i) => {
      if (statusKeys.indexOf(k) !== i) stageViolations.push({ at: `stageMapping[${i}]`, code: 'KEY_COLLISION' });
    });
    if (stageViolations.length > 0) return { outcome: 'STAGE_MAPPING_INVALID', violations: stageViolations };

    const parsed = parseCrmImportCsv(source.csvText);
    if (!parsed.ok) return { outcome: 'SOURCE_INVALID', problem: parsed.problem, ...(parsed.column ? { column: parsed.column } : {}), ...(parsed.position ? { position: parsed.position } : {}) };
    const org = actor.organizationId;

    // Exact matching compares keyed hashes: this process must hold the key the existing Contact Points
    // were written under, or every match would silently miss and the plan would propose duplicates.
    const keyFingerprint = identifierKeyFingerprint();
    const keyed = await this.contactPointRows.hashKeyFingerprints(org);
    const mismatched = keyed.filter((k) => k.fingerprint !== keyFingerprint).reduce((n, k) => n + k.count, 0);
    if (mismatched > 0) return { outcome: 'HASH_KEY_MISMATCH', keyFingerprint, mismatchedContactPoints: mismatched };
    const now = this.clock();

    // Rows whose last-contacted date lies in the future are refused, not clamped.
    const invalid: CrmImportInvalidRow[] = parsed.invalid.map((r) => ({ line: r.line, sourceRowKey: r.sourceRowKey, violations: r.violations }));
    const rows = parsed.rows.filter((r) => {
      if (r.sourceLastContactedAt && Date.parse(r.sourceLastContactedAt) > now.getTime()) {
        invalid.push({ line: r.line, sourceRowKey: r.sourceRowKey, violations: ['LAST_CONTACTED_AT_IN_FUTURE'] });
        return false;
      }
      return true;
    });

    const inputs: CrmImportPlanRowInput[] = rows.map((row) => rowInput(org, row));

    // The reviewed mappings, and every Party they name, through the Party Reference contract.
    const [aliasRows, routeRows, importKeys] = await Promise.all([this.imports.activeAliases(org), this.imports.activeRoutes(org), this.imports.importKeys(org)]);
    const importedCompanyIds = [...importKeys].filter(([k]) => k.startsWith('COMPANY:')).map(([, id]) => id);
    const partyIds = [
      ...aliasRows.map((a) => a.creatorPartyId),
      ...routeRows.flatMap((r) => [r.targetCompanyPartyId, r.representedBrandPartyId].filter((id): id is string => Boolean(id))),
      ...importedCompanyIds,
    ];
    const [resolutions, names] = await Promise.all([this.references.resolveMany(org, partyIds), this.partyNames(org, partyIds)]);
    const view = (partyId: string, type: 'PERSON' | 'COMPANY'): CrmImportCompanyView => ({
      partyId,
      name: names.get(partyId) ?? null,
      referenceable: referenceable(resolutions.get(partyId), type),
    });
    const aliases = new Map<string, CrmImportAliasView>(
      aliasRows.map((a) => {
        const v = view(a.creatorPartyId, 'PERSON');
        return [a.aliasKey, { mappingId: a.id, creatorPartyId: a.creatorPartyId, creatorName: v.name, referenceable: v.referenceable }];
      }),
    );
    const routes = new Map<string, CrmImportRouteView>(
      routeRows
        .filter((r) => isCrmImportRouteClassification(r.classification))
        .map((r) => [
          r.routeKey,
          {
            mappingId: r.id,
            classification: r.classification as CrmImportRouteView['classification'],
            targetCompany: r.targetCompanyPartyId ? view(r.targetCompanyPartyId, 'COMPANY') : null,
            proposedCompanyName: r.proposedCompanyName,
            representedBrand: r.representedBrandPartyId ? view(r.representedBrandPartyId, 'COMPANY') : null,
            representedBrandRouteKey: r.representedBrandRouteKey,
          },
        ]),
    );
    const importedCompanies = new Map(importedCompanyIds.map((id) => [id, view(id, 'COMPANY')]));

    // Exact Contact Point matches, through the Contact Point authority, once per (kind, value, type).
    const matches = new Map<string, CrmImportMatchView>();
    for (const input of inputs) {
      const partyType = crmImportPersonEligible(input.row) ? 'PERSON' : 'COMPANY';
      for (const v of input.values) {
        const key = `${v.kind}:${v.hash}:${partyType}`;
        if (matches.has(key)) continue;
        const m = await this.contactPoints.match(actor, { kind: v.kind, value: v.normalized, partyType });
        if (m.outcome === 'NOT_AUTHORIZED') return { outcome: 'NOT_AUTHORIZED' };
        matches.set(key, m.outcome === 'MATCH' ? { outcome: 'MATCH', partyId: m.partyId } : { outcome: m.outcome === 'INVALID' ? 'INVALID' : m.outcome });
      }
    }

    // Opportunities that already exist for a creator x brand, other than ones an import created.
    const importedOpportunityIds = new Set([...importKeys].filter(([k]) => k.startsWith('OPPORTUNITY:')).map(([, id]) => id));
    const brandIds = [...routes.values()].flatMap((r) => [r.targetCompany?.partyId, r.representedBrand?.partyId].filter((id): id is string => Boolean(id)));
    const pursuits = await this.imports.existingPursuits(org, aliasRows.map((a) => a.creatorPartyId), [...brandIds, ...importedCompanyIds]);
    const existingPursuits = new Map([...pursuits].map(([k, ids]) => [k, ids.filter((id) => !importedOpportunityIds.has(id)).length]));

    const priorEntries = await this.imports.priorEntries(org, rows.map((r) => r.sourceRowKey));
    const stageMap = new Map(stageMapping.map((e) => [crmImportKey(e.sourceStatus), e]));

    const plan = planCrmImport(inputs, { aliases, routes, stageMapping: stageMap, importKeys, importedCompanies, matches, priorEntries, existingPursuits });
    const counts: Record<string, number> = { ...plan.counts, invalidRows: invalid.length };
    if (invalid.length > 0) counts['outcome.INVALID_ROW'] = invalid.length;

    return {
      outcome: 'OK',
      prepared: {
        sourceSha256: sha256(source.csvText),
        importerVersion: CRM_IMPORT_VERSION,
        keyFingerprint,
        configFingerprint: configFingerprint(aliasRows, routeRows, stageMapping),
        planDigest: planDigest(plan, invalid),
        plan,
        rows,
        invalid: invalid.sort((a, b) => a.line - b.line),
        counts,
      },
    };
  }

  // --- Execution -------------------------------------------------------------------------------

  private async execute(actor: CrmImportActor, runId: string, p: CrmImportPrepared): Promise<{ counts: Record<string, number>; failureCodes: string[]; appliedLines: number[] }> {
    const org = actor.organizationId;
    const counts: Record<string, number> = {};
    const failures = new Set<string>();
    const inc = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
    const values = valuesByHash(p.rows, org);
    const firstRowKey = new Map(p.plan.rows.map((r) => [r.line, r.sourceRowKey]));
    const lastContacted = lastContactedByHash(p.rows, org);
    const companyIds = new Map<string, string>();
    const personIds = new Map<string, string>();
    const done = new Set<string>();

    const unit = async (name: string, run: (tx: Tx) => Promise<void>): Promise<boolean> => {
      try {
        await this.prisma.$transaction(run, { timeout: UNIT_TIMEOUT_MS, maxWait: UNIT_TIMEOUT_MS });
        done.add(name);
        return true;
      } catch (err) {
        if (err instanceof UnitRefused) {
          failures.add(err.code);
          inc(`applied.failed.${err.code}`);
          return false;
        }
        if (isUniqueViolation(err)) {
          // Another run claimed the same subject first; this unit rolled back whole and re-plans next time.
          failures.add('CLAIMED_CONCURRENTLY');
          inc('applied.failed.CLAIMED_CONCURRENTLY');
          return false;
        }
        throw err;
      }
    };

    const addContacts = async (tx: Tx, partyId: string, unitContacts: CrmImportPlannedCompany['contacts'], lines: readonly number[]) => {
      const ids: string[] = [];
      for (const c of unitContacts) {
        const normalized = values.get(`${c.kind}:${c.hash}`);
        if (!normalized) throw new UnitRefused('CONTACT_VALUE_UNAVAILABLE');
        const sourceLine = p.plan.rows.find((r) => lines.includes(r.line) && r.contacts.some((x) => x.kind === c.kind && x.hash === c.hash))?.line;
        const sourceRowKey = sourceLine !== undefined ? firstRowKey.get(sourceLine) : undefined;
        const r = await this.contactPoints.add(
          actor,
          {
            partyId,
            kind: c.kind,
            classification: c.classification,
            value: normalized,
            basis: 'IMPORTED',
            sourceRef: `${SOURCE_REF_PREFIX}${sourceRowKey ?? 'unknown'}`,
            lastHumanContactAt: lastContacted.get(`${c.kind}:${c.hash}`) ?? null,
          },
          { tx },
        );
        if (r.outcome === 'RECORDED') {
          ids.push(r.value.id);
          inc(`applied.contactPoint.${c.classification}`);
        } else if (r.outcome !== 'DUPLICATE') throw new UnitRefused(`CONTACT_POINT_${r.outcome}`);
      }
      return ids;
    };

    // 1. Companies (and the Contact Points that belong on them), each one atomic unit.
    for (const c of p.plan.companies) {
      await unit(`company:${c.key}`, async (tx) => {
        let partyId = c.partyId;
        if (c.action === 'PROPOSED') {
          const claimed = await this.imports.findKey(org, 'COMPANY', `route:${c.routeKey}`, tx);
          if (claimed) partyId = claimed.subjectId;
          else {
            partyId = await this.createParty(actor, 'COMPANY', c.name!, tx);
            await this.imports.claimKey(org, { keyKind: 'COMPANY', keyValue: `route:${c.routeKey}`, subjectId: partyId, importRunId: runId }, tx);
            inc('applied.company.created');
          }
        }
        const contactIds = await addContacts(tx, partyId!, c.contacts, c.lines);
        await this.imports.recordResults(org, runId, c.lines, { companyPartyId: partyId!, contactPointIds: contactIds }, tx);
        companyIds.set(c.key, partyId!);
      });
    }

    // 2. People (and their INDIVIDUAL Contact Points), each one atomic unit.
    for (const person of p.plan.persons) {
      await unit(`person:${person.key}`, async (tx) => {
        let partyId = person.partyId;
        if (person.action === 'PROPOSED') {
          const claimed = await this.imports.findKey(org, 'PERSON', person.key, tx);
          if (claimed) partyId = claimed.subjectId;
          else {
            partyId = await this.createParty(actor, 'PERSON', person.name, tx);
            await this.imports.claimKey(org, { keyKind: 'PERSON', keyValue: person.key, subjectId: partyId, importRunId: runId }, tx);
            inc('applied.person.created');
          }
        }
        const contactIds = await addContacts(tx, partyId!, person.contacts, person.lines);
        await this.imports.recordResults(org, runId, person.lines, { personPartyId: partyId!, contactPointIds: contactIds }, tx);
        personIds.set(person.key, partyId!);
      });
    }

    // 3. Pursuits: one Opportunity per creator x brand, with its BRAND and PRIMARY_CONTACTs, atomically.
    for (const pursuit of p.plan.pursuits) {
      if (pursuit.action === 'BLOCKED') continue;
      const brandPartyId = companyIds.get(pursuit.brandKey) ?? (pursuit.brandKey.startsWith('party:') ? pursuit.brandKey.slice('party:'.length) : null);
      const contactIds = pursuit.primaryContactKeys.map((k) => personIds.get(k) ?? p.plan.persons.find((x) => x.key === k)?.partyId ?? null);
      if (!brandPartyId || !done.has(`company:${pursuit.brandKey}`) || contactIds.some((id) => !id)) {
        failures.add('DEPENDENCY_NOT_APPLIED');
        inc('applied.failed.DEPENDENCY_NOT_APPLIED');
        continue;
      }
      await unit(`pursuit:${pursuit.key}`, async (tx) => {
        const keyValue = `${pursuit.creatorPartyId}|${brandPartyId}`;
        let opportunityId = pursuit.opportunityId ?? (await this.imports.findKey(org, 'OPPORTUNITY', keyValue, tx))?.subjectId ?? null;
        if (!opportunityId) {
          opportunityId = await this.createOpportunity(actor, pursuit, tx);
          await this.imports.claimKey(org, { keyKind: 'OPPORTUNITY', keyValue, subjectId: opportunityId, importRunId: runId }, tx);
          inc('applied.opportunity.created');
        }
        await this.addParticipant(actor, opportunityId, brandPartyId, 'BRAND', tx, inc);
        for (const id of contactIds) await this.addParticipant(actor, opportunityId, id!, 'PRIMARY_CONTACT', tx, inc);
        await this.imports.recordResults(org, runId, pursuit.lines, { opportunityId }, tx);
      });
    }

    // A row counts as applied when every unit it needed committed.
    const pursuitByKey = new Map(p.plan.pursuits.map((x) => [x.key, x]));
    const appliedLines = p.plan.rows
      .filter((r) => r.subjectsApplicable || r.outcome === 'EXCLUDED_BY_STATUS')
      .filter((r) => {
        if (r.outcome === 'EXCLUDED_BY_STATUS') return true;
        if (r.companyKey && !done.has(`company:${r.companyKey}`)) return false;
        if (r.personKey && p.plan.persons.some((x) => x.key === r.personKey) && !done.has(`person:${r.personKey}`)) return false;
        const pursuit = r.pursuitKey ? pursuitByKey.get(r.pursuitKey) : undefined;
        if (pursuit && pursuit.action !== 'BLOCKED' && !done.has(`pursuit:${pursuit.key}`)) return false;
        return true;
      })
      .map((r) => r.line);
    return { counts, failureCodes: [...failures].sort(), appliedLines };
  }

  /** Create and establish (MANUAL, the operator's act) a Party in the unit's transaction. */
  private async createParty(actor: CrmImportActor, partyType: 'COMPANY' | 'PERSON', name: string, tx: Tx): Promise<string> {
    const created = await this.parties.create(actor.organizationId, actor.userId, { partyType, displayName: name }, { tx });
    if (created.outcome !== 'RECORDED') throw new UnitRefused(`PARTY_CREATE_${created.outcome}`);
    const established = await this.parties.establish(actor.organizationId, actor.userId, created.party.id, 'MANUAL', { tx });
    if (established.outcome !== 'RECORDED') throw new UnitRefused(`PARTY_ESTABLISH_${established.outcome}`);
    return created.party.id;
  }

  private async createOpportunity(actor: CrmImportActor, pursuit: CrmImportPlannedPursuit, tx: Tx): Promise<string> {
    const r = await this.opportunities.create(
      actor,
      // Decision R: no Relationship. Decision I: no owner. Nothing creator-visible.
      { title: pursuit.title!, category: pursuit.category!, stage: pursuit.stage!, creatorPartyId: pursuit.creatorPartyId, relationshipId: null },
      { tx },
    );
    if (r.outcome !== 'RECORDED') throw new UnitRefused(`OPPORTUNITY_${r.outcome}`);
    return r.value.id;
  }

  private async addParticipant(
    actor: CrmImportActor,
    opportunityId: string,
    partyId: string,
    role: 'BRAND' | 'PRIMARY_CONTACT',
    tx: Tx,
    inc: (k: string) => void,
  ): Promise<void> {
    const r = await this.opportunities.addParticipant(actor, { opportunityId, partyId, role }, { tx });
    if (r.outcome === 'RECORDED') inc(`applied.participant.${role}`);
    else if (r.outcome !== 'DUPLICATE') throw new UnitRefused(`PARTICIPANT_${r.outcome}`);
  }

  private async partyNames(organizationId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.cognitiveIdentity.findMany({ where: { organizationId, id: { in: unique } }, select: { id: true, displayName: true } });
    return new Map(rows.flatMap((r) => (r.displayName?.trim() ? [[r.id, r.displayName.trim()] as const] : [])));
  }
}

// --- Pure helpers ------------------------------------------------------------------------------

const ROW_FINGERPRINT_NAMESPACE = 'crm.import.v1.row';
const PERSON_KEY_NAMESPACE = 'crm.import.v1.person';

function rowInput(organizationId: string, row: CrmImportSourceRow): CrmImportPlanRowInput {
  const values: CrmImportPlanRowInput['values'][number][] = [];
  const invalidValueKinds: CrmContactPointKind[] = [];
  for (const [kind, raw] of [['EMAIL', row.email], ['PHONE', row.phone]] as const) {
    if (!raw) continue;
    const n = normalizeCrmContactPointValue(kind, raw);
    if (!n.ok) invalidValueKinds.push(kind);
    else values.push({ kind, normalized: n.value, hash: crmContactPointValueHash(organizationId, kind, n.value) });
  }
  let personKey: string | null = null;
  if (crmImportPersonEligible(row)) {
    const first = values.find((v) => v.kind === 'EMAIL') ?? values.find((v) => v.kind === 'PHONE');
    personKey = first ? `${first.kind.toLowerCase()}:${keyedDigest(organizationId, `${PERSON_KEY_NAMESPACE}.${first.kind}`, first.normalized)}` : `row:${row.sourceRowKey}`;
  }
  return { row, fingerprint: rowFingerprint(organizationId, row), values, invalidValueKinds, personKey };
}

/** Keyed, so a fingerprint cannot be reversed by guessing a row's contents. Every column, in a fixed order. */
export function rowFingerprint(organizationId: string, row: CrmImportSourceRow): string {
  const canonical = JSON.stringify([
    row.sourceRowKey,
    row.creatorAlias,
    row.routeKey,
    row.sourceStatus,
    row.routeName,
    row.brandName,
    row.contactName,
    row.contactNameVerified,
    row.contactKind,
    row.contactTitle,
    row.email,
    row.phone,
    row.sourceNotes,
    row.sourceLastContactedAt,
  ]);
  return keyedDigest(organizationId, ROW_FINGERPRINT_NAMESPACE, canonical);
}

function valuesByHash(rows: readonly CrmImportSourceRow[], organizationId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) for (const v of rowInput(organizationId, row).values) out.set(`${v.kind}:${v.hash}`, v.normalized);
  return out;
}

/** The latest recorded human contact per value, across every row that carries it. */
function lastContactedByHash(rows: readonly CrmImportSourceRow[], organizationId: string): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const row of rows) {
    if (!row.sourceLastContactedAt) continue;
    const at = new Date(row.sourceLastContactedAt);
    for (const v of rowInput(organizationId, row).values) {
      const k = `${v.kind}:${v.hash}`;
      const prev = out.get(k);
      if (!prev || at > prev) out.set(k, at);
    }
  }
  return out;
}

function referenceable(resolution: PartyReferenceResolution | undefined, type: 'PERSON' | 'COMPANY'): boolean {
  return resolution?.state === 'ESTABLISHED' && !resolution.archived && resolution.partyType === type;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The reviewed configuration a plan used, by value: active aliases, active routes, the stage mapping. */
export function configFingerprint(
  aliases: readonly { aliasKey: string; creatorPartyId: string }[],
  routes: readonly { routeKey: string; classification: string; targetCompanyPartyId: string | null; proposedCompanyName: string | null; representedBrandPartyId: string | null; representedBrandRouteKey: string | null }[],
  stageMapping: readonly CrmImportStageMappingEntry[],
): string {
  return sha256(
    JSON.stringify({
      version: CRM_IMPORT_VERSION,
      aliases: [...aliases].map((a) => [a.aliasKey, a.creatorPartyId]).sort(),
      routes: [...routes]
        .map((r) => [r.routeKey, r.classification, r.targetCompanyPartyId, r.proposedCompanyName, r.representedBrandPartyId, r.representedBrandRouteKey])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      stageMapping: [...stageMapping]
        .map((e) => [crmImportKey(e.sourceStatus), e.action, e.category ?? null, e.stage?.trim() ?? null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }),
  );
}

/** What the plan intends, hashed. Equal plans have equal digests; any difference is a mismatch. */
export function planDigest(plan: CrmImportPlan, invalid: readonly CrmImportInvalidRow[]): string {
  return sha256(
    JSON.stringify({
      rows: plan.rows.map((r) => [r.line, r.sourceRowKey, r.fingerprint, r.outcome, r.companyKey, r.companyAction, r.personKey, r.personAction, r.pursuitKey, r.opportunityAction, r.contacts.map((c) => [c.kind, c.classification, c.action, c.targetKey, c.hash])]),
      invalid: invalid.map((r) => [r.line, r.sourceRowKey, r.violations]),
      companies: plan.companies.map((c) => [c.key, c.action, c.partyId, c.name, c.contacts.map((x) => [x.kind, x.classification, x.hash])]),
      persons: plan.persons.map((p) => [p.key, p.action, p.partyId, p.name, p.contacts.map((x) => [x.kind, x.classification, x.hash])]),
      pursuits: plan.pursuits.map((p) => [p.key, p.action, p.title, p.category, p.stage, p.opportunityId, p.primaryContactKeys, p.blockedBy]),
    }),
  );
}

function entriesOf(p: CrmImportPrepared): CrmImportEntryInput[] {
  return [
    ...p.plan.rows.map(
      (r): CrmImportEntryInput => ({
        line: r.line,
        sourceRowKey: r.sourceRowKey,
        rowFingerprint: r.fingerprint,
        routeMappingId: r.routeMappingId,
        routeClassification: r.routeClassification,
        creatorAliasId: r.creatorAliasId,
        pursuitKey: r.pursuitKey,
        outcome: r.outcome,
        ambiguityCode: r.ambiguityCode,
        companyAction: r.companyAction,
        personAction: r.personAction,
        opportunityAction: r.opportunityAction,
        // Kind, classification and action only: never a value, never its hash.
        contactPointActions: r.contacts.map((c) => ({ kind: c.kind, classification: c.classification, action: c.action })),
      }),
    ),
    ...p.invalid.map(
      (r): CrmImportEntryInput => ({
        line: r.line,
        sourceRowKey: r.sourceRowKey,
        rowFingerprint: null,
        routeMappingId: null,
        routeClassification: null,
        creatorAliasId: null,
        pursuitKey: null,
        outcome: 'INVALID_ROW',
        ambiguityCode: r.violations.join(',').slice(0, 200),
        companyAction: null,
        personAction: null,
        opportunityAction: null,
        contactPointActions: [],
      }),
    ),
  ].sort((a, b) => a.line - b.line);
}

/** The default APPLY target guard: a local database, and not a production runtime. */
function localDatabaseOnly(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const url = process.env.DATABASE_URL ?? '';
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}
