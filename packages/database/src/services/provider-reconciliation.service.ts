// ProviderReconciliationService -- did what the provider held actually arrive?
//
// It does ONE thing: read a bounded provider window covering one complete
// Eastern business day, read Loop's own delivery record over a wider window,
// compare the two IDENTITY SETS, resolve what each population member was
// declared to be on that date, and write a single ProviderReconciliationDay with
// its member facts.
//
// IT NEVER REPAIRS. No IngestionService, no NormalizationEngine, no Interaction,
// no MarketplaceCall, no recovery, no sync, and no write to the observation
// ledger or to a declaration. Discovering that CallGrid holds records Loop is
// missing is EVIDENCE for a later decision and changes nothing on its own --
// exactly the stance certification takes. Folding repair into comparison would
// make it impossible to establish what was missing without also changing it.
//
// IT NEVER INFERS EXPECTATION. Expectation is resolved through PR 2's
// repository, from declarations a person made, and this file contains no rule
// about which campaigns should deliver. The inverse would be catastrophic: a
// campaign that BROKE would un-expect itself the moment it stopped delivering.
//
// IT COMPARES AT INTEGRATION_EVENT, NOT AT THE PROJECTION. `integration_events`
// is where receipt is proven, before normalization and projection semantics
// apply, and its `externalId` IS the provider's identity. August 2026 established
// that the chain below it was identity-lossless for every record Loop received,
// so a difference at this boundary is a delivery fact rather than a projection
// rule. Reconciling at MarketplaceCall would conflate the two permanently.
//
// EVIDENCE BEFORE VERDICT. Truncation, unattributed provider records, local rows
// with no resolvable occurrence and local rows with no identity are all assessed
// BEFORE the counts are read, and any one of them makes the day INCONCLUSIVE.
// The ordering matters for the same reason `certifyDay` tests truncation before
// emptiness: consulting the data first would confidently classify the most
// dangerous case of all.

import type { PrismaClient } from '@prisma/client';
import {
  BUSINESS_TIME_ZONE,
  RECONCILIATION_RULE_VERSION,
  assessReconciliation,
  easternBusinessDayWindow,
  isBusinessDate,
  normalizeExternalIdentity,
  type BindingDimension,
  type BusinessDate,
  type ComparisonIntegrity,
  type ReconciliationCounts,
  type ReconciliationMemberFact,
  type ReconciliationState,
  type ResolvedExpectation,
} from '@emgloop/shared';

import { IntegrationRepository } from '../repositories/integration.repository';
import { ProviderMemberExpectationRepository } from '../repositories/provider-member-expectation.repository';
import {
  INTEGRATION_EVENT_STAGE,
  ProviderReconciliationRepository,
  type ReconciliationDayView,
  type ReconciliationMemberInput,
} from '../repositories/provider-reconciliation.repository';
import { CALLGRID_PROVIDER, CALLS_STREAM } from './provider-observation.service';

/**
 * Page budget for one reconciliation read.
 *
 * THE SAME NUMBER `CERTIFICATION_PAGE_CAP` uses, and deliberately the same rather
 * than a second opinion about how big a day can be: a comparison that read
 * further than certification could report a difference certification never saw.
 * August 5 needed 11 pages.
 */
export const RECONCILIATION_PAGE_CAP = 100;

/**
 * How far either side of the day's UTC interval the LOCAL delivery scan reaches.
 *
 * `integration_events.occurredAt` exists as of PR #180 -- this comment claimed it
 * did not, and went on saying so after the column shipped -- but it is populated
 * only for rows written since, so rows are still selected by `receivedAt` and
 * then filtered by RESOLVED OCCURRENCE in memory. A webhook that arrived late, was retried the
 * next morning, or was imported by a sync days afterwards still belongs to the
 * day it OCCURRED on, and a scan bounded to the day itself would silently
 * classify it as absent. Two days covers retry and same-week reconciliation; it
 * is a scan bound, never a claim about the window.
 */
export const LOCAL_SCAN_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/** Rows per batch when scanning local events. Bounded so a busy window is read in pieces. */
export const LOCAL_SCAN_BATCH_SIZE = 500;

/** The only dimension this version attributes and declares against. */
export const RECONCILIATION_DIMENSION: BindingDimension = 'CAMPAIGN';

/**
 * The payload keys carrying member attribution and its label.
 *
 * `campaignId` is the ONLY attribution id present on every record of the
 * 2026-08-05 provider population -- vendorId, sourceId, buyerId and
 * destinationId were absent on all 974 -- and it is preserved verbatim by both
 * the REST mapper and the webhook template, so the two sides name a member the
 * same way. `campaign` is the provider's display name for it and is used for
 * NOTHING but display.
 */
export const MEMBER_ID_FIELD = 'campaignId';
export const MEMBER_LABEL_FIELDS = ['campaign', 'campaignName'] as const;

// --- The seams ------------------------------------------------------------------
//
// Narrow on purpose. The service is handed the ability to enumerate a provider
// window and the ability to read local delivery rows, and can do nothing else --
// which makes "it cannot ingest, project or recover" a property of the type
// rather than of somebody's care at review time.

/** One provider record, reduced to what a comparison needs. */
export interface ProviderPopulationRecord {
  identity: string | null;
  memberExternalId: string | null;
  label: string | null;
}

/** What one bounded provider read produced. */
export interface ProviderPopulation {
  records: ProviderPopulationRecord[];
  recordsFetched: number;
  pagesFetched: number;
  pageCap: number;
  truncated: boolean;
}

/** The one provider capability this service has. Read-only by type. */
export interface ProviderPopulationReader {
  enumerate(input: {
    organizationId: string;
    apiKey: string;
    apiBaseUrl?: string;
    since: Date;
    until: Date;
    pageCap: number;
  }): Promise<ProviderPopulation>;
}

/** One local delivery row, reduced the same way. */
export interface LocalDeliveryRecord {
  identity: string | null;
  occurredAt: Date | null;
  memberExternalId: string | null;
}

/** The one local capability. A batched SELECT and nothing else. */
export interface LocalDeliveryReader {
  read(input: {
    organizationId: string;
    provider: string;
    /** The OCCURRENCE window. The real question, and the day's exact bounds. */
    since: Date;
    until: Date;
    /**
     * The DELIVERY window, for legacy rows that cannot answer the real question.
     *
     * `integration_events.occurredAt` exists as of PR #180 but is populated only
     * for rows written since. An older row's occurrence lives inside `payload`
     * and cannot be filtered in SQL without duplicating the canonical resolver's
     * field precedence, so those rows are still reached the way they always were
     * -- by delivery time, widened -- and judged in memory.
     */
    legacySince: Date;
    legacyUntil: Date;
  }): Promise<LocalDeliveryRecord[]>;
}

export interface ReconcileDayInput {
  organizationId: string;
  /** The Eastern calendar day to reconcile, 'YYYY-MM-DD'. */
  businessDate: BusinessDate;
  /** Provider credential. Never stored, never logged, never returned. */
  apiKey: string;
  apiBaseUrl?: string;
  /** Injected so the caller owns the clock and a test can pin it. */
  now: Date;
  /** Override the page budget. Lowering it in a test is how truncation is proved. */
  pageCap?: number;
}

/**
 * What one run produced.
 *
 * A REFUSAL IS NOT A VERDICT. `ok: false` means nothing was written, because the
 * comparison's own arithmetic disagreed with itself -- a defect in Loop, not a
 * finding about the data. Every OTHER problem produces a stored INCONCLUSIVE row
 * naming its reason, because "we tried and could not trust the answer" is worth
 * keeping.
 */
export type ReconcileDayResult =
  | { ok: true; day: ReconciliationDayView }
  | { ok: false; reason: 'DIAGNOSTIC_DEFECT'; problems: readonly string[] };

interface MemberAccumulator {
  memberExternalId: string;
  providerCount: number;
  providerOnly: number;
  localCount: number;
  localOnly: number;
  label: string | null;
}

function accumulator(memberExternalId: string): MemberAccumulator {
  return { memberExternalId, providerCount: 0, providerOnly: 0, localCount: 0, localOnly: 0, label: null };
}

/** A member id off a payload, or null. Never a label, never a fabricated stand-in. */
export function memberIdFrom(payload: Record<string, unknown>): string | null {
  return normalizeExternalIdentity(payload[MEMBER_ID_FIELD]);
}

/** The member's display label off a payload, or null. Used for nothing but display. */
export function memberLabelFrom(payload: Record<string, unknown>): string | null {
  for (const key of MEMBER_LABEL_FIELDS) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return null;
}

export class ProviderReconciliationService {
  private readonly reconciliations: ProviderReconciliationRepository;
  private readonly expectations: ProviderMemberExpectationRepository;
  private readonly providerReader: ProviderPopulationReader;
  private readonly localReader: LocalDeliveryReader;

  constructor(
    prisma: PrismaClient,
    deps: {
      reconciliations?: ProviderReconciliationRepository;
      expectations?: ProviderMemberExpectationRepository;
      providerReader?: ProviderPopulationReader;
      localReader?: LocalDeliveryReader;
    } = {},
  ) {
    this.reconciliations = deps.reconciliations ?? new ProviderReconciliationRepository(prisma);
    this.expectations = deps.expectations ?? new ProviderMemberExpectationRepository(prisma);
    this.providerReader = deps.providerReader ?? callGridPopulationReader();
    this.localReader = deps.localReader ?? integrationEventReader(prisma);
  }

  /**
   * Compare one complete Eastern business day and record the outcome.
   *
   * Always writes exactly one row unless the comparison is internally
   * inconsistent, in which case it writes nothing: "we tried and the provider was
   * unreachable" is a fact worth keeping, but "we compared two sets and the
   * totals disagree" is a bug report, and storing it as a reconciliation would
   * assert that a comparison happened.
   */
  async reconcileDay(input: ReconcileDayInput): Promise<ReconcileDayResult> {
    if (!isBusinessDate(input.businessDate)) {
      throw new Error(`Not a business date: ${String(input.businessDate)} (expected YYYY-MM-DD)`);
    }
    // From business-time.ts, the ONE place allowed to decide what an Eastern day
    // is. Deriving it here -- or adding 24 hours to a midnight -- would put
    // reconciliation, certification and measurement on different boundaries twice
    // a year.
    const window = easternBusinessDayWindow(input.businessDate);
    const pageCap = input.pageCap && input.pageCap > 0 ? input.pageCap : RECONCILIATION_PAGE_CAP;
    const scanStart = new Date(window.start.getTime() - LOCAL_SCAN_MARGIN_MS);
    const scanEnd = new Date(window.end.getTime() + LOCAL_SCAN_MARGIN_MS);

    const observedAt = input.now;
    const population = await this.providerReader.enumerate({
      organizationId: input.organizationId,
      apiKey: input.apiKey,
      ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
      since: window.start,
      until: window.end,
      pageCap,
    });
    const local = await this.localReader.read({
      organizationId: input.organizationId,
      provider: CALLGRID_PROVIDER,
      // THE DAY ITSELF, by provider occurrence. A call that HAPPENED on this date
      // belongs to it however long afterwards Loop received it -- which is the
      // whole point: a recovered August call must count on its August day, not on
      // the day somebody ran the recovery.
      since: window.start,
      until: window.end,
      // And the widened DELIVERY window, for rows written before occurrence was
      // a column. They are still found exactly the way they used to be.
      legacySince: scanStart,
      legacyUntil: scanEnd,
    });

    // --- Provider side ----------------------------------------------------------
    // FIRST RECORD WINS for an identity the provider repeated. Which copy is kept
    // does not change the set, and the set is the only thing compared.
    const providerById = new Map<string, ProviderPopulationRecord>();
    const providerDuplicated = new Set<string>();
    for (const record of population.records) {
      if (record.identity === null) continue;
      if (providerById.has(record.identity)) {
        providerDuplicated.add(record.identity);
        continue;
      }
      providerById.set(record.identity, record);
    }

    // --- Local side -------------------------------------------------------------
    // Selected by OCCURRENCE where the row can state it, by delivery time where it
    // cannot, and judged by occurrence either way. The in-memory bound is kept
    // even though the query now applies it: the legacy rows arrive through the
    // delivery window and still have to be ruled in or out, and one place deciding
    // membership is what keeps the two paths agreeing.
    //
    // A row whose occurrence cannot be resolved is counted and never silently
    // dropped: it cannot be ruled out of this date, which is exactly what makes it
    // impeach it.
    let localUnresolvedOccurrence = 0;
    const inWindow: LocalDeliveryRecord[] = [];
    for (const record of local) {
      if (record.occurredAt === null) {
        localUnresolvedOccurrence += 1;
        continue;
      }
      if (record.occurredAt >= window.start && record.occurredAt < window.end) inWindow.push(record);
    }
    let localMissingIdentity = 0;
    const localById = new Map<string, LocalDeliveryRecord>();
    const localDuplicated = new Set<string>();
    for (const record of inWindow) {
      if (record.identity === null) {
        localMissingIdentity += 1;
        continue;
      }
      if (localById.has(record.identity)) localDuplicated.add(record.identity);
      else localById.set(record.identity, record);
    }

    // --- The comparison ---------------------------------------------------------
    const members = new Map<string, MemberAccumulator>();
    const upsertMember = (id: string): MemberAccumulator => {
      const existing = members.get(id);
      if (existing) return existing;
      const fresh = accumulator(id);
      members.set(id, fresh);
      return fresh;
    };

    let providerUnattributed = 0;
    let intersection = 0;
    let providerOnly = 0;
    /** Provider-only identities carrying no member id at all. */
    let providerOnlyUnattributed = 0;
    for (const [identity, record] of providerById) {
      const matched = localById.has(identity);
      if (matched) intersection += 1;
      else providerOnly += 1;

      if (record.memberExternalId === null) {
        providerUnattributed += 1;
        if (!matched) providerOnlyUnattributed += 1;
        continue;
      }
      const member = upsertMember(record.memberExternalId);
      member.providerCount += 1;
      if (!matched) member.providerOnly += 1;
      if (member.label === null && record.label !== null) member.label = record.label;
    }

    // Local attribution is INDEPENDENT -- read off the local payload, never
    // inherited from the provider record it matched. Two sides that disagree
    // about which campaign a call belongs to is a fact worth being able to see,
    // and deriving one from the other would make it invisible.
    let localOnly = 0;
    for (const [identity, record] of localById) {
      const matched = providerById.has(identity);
      if (!matched) localOnly += 1;
      if (record.memberExternalId === null) continue;
      const member = upsertMember(record.memberExternalId);
      member.localCount += 1;
      if (!matched) member.localOnly += 1;
    }

    // --- Expectation ------------------------------------------------------------
    // Resolved for EVERY member, not only the ones carrying absences. A member
    // that delivered completely today still needs its declaration recorded, or a
    // later reader cannot tell a campaign that was expected and arrived from one
    // nobody had ever spoken about.
    const memberInputs: ReconciliationMemberInput[] = [];
    const memberFacts: ReconciliationMemberFact[] = [];
    const split = {
      providerOnlyExpected: 0,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      // Provider-only identities with no member id start here: no declaration can
      // be in force for a member that was never named. `providerUnattributed`
      // states how many there are and forces INCONCLUSIVE, so this bucket never
      // silently absorbs them into a readable verdict.
      providerOnlyUnknownMember: providerOnlyUnattributed,
    };

    for (const member of [...members.values()].sort((a, b) =>
      a.memberExternalId < b.memberExternalId ? -1 : a.memberExternalId > b.memberExternalId ? 1 : 0,
    )) {
      const { resolution, declarationId } = await this.expectations.resolveSourceOn(
        input.organizationId,
        CALLGRID_PROVIDER,
        CALLS_STREAM,
        RECONCILIATION_DIMENSION,
        member.memberExternalId,
        input.businessDate,
      );
      const state: ResolvedExpectation = resolution.state;
      addToSplit(split, state, member.providerOnly);
      memberInputs.push({
        dimension: RECONCILIATION_DIMENSION,
        memberExternalId: member.memberExternalId,
        providerCount: member.providerCount,
        providerOnly: member.providerOnly,
        localCount: member.localCount,
        localOnly: member.localOnly,
        expectationState: state,
        expectationId: declarationId,
        expectationMatches: resolution.matches,
        labelAtObservation: member.label,
      });
      memberFacts.push({
        dimension: RECONCILIATION_DIMENSION,
        memberExternalId: member.memberExternalId,
        providerCount: member.providerCount,
        localCount: member.localCount,
        providerOnly: member.providerOnly,
        expectation: state,
      });
    }

    const counts: ReconciliationCounts = {
      providerUnique: providerById.size,
      providerDuplicateIds: providerDuplicated.size,
      localUnique: localById.size,
      localDuplicateIds: localDuplicated.size,
      intersection,
      providerOnly,
      localOnly,
      ...split,
    };
    const integrity: ComparisonIntegrity = {
      providerTruncated: population.truncated,
      providerUnattributed,
      localUnresolvedOccurrence,
      localMissingIdentity,
    };

    // The PURE assessment. Integrity is weighed before the counts are read, and
    // this service adds no rule of its own on top of it.
    const assessment = assessReconciliation(integrity, counts, memberFacts);
    const state: ReconciliationState = assessment.state;

    const recorded = await this.reconciliations.recordDay(input.organizationId, {
      provider: CALLGRID_PROVIDER,
      stream: CALLS_STREAM,
      businessDate: input.businessDate,
      timezone: BUSINESS_TIME_ZONE,
      windowStart: window.start,
      windowEnd: window.end,
      scanStart,
      scanEnd,
      state,
      ruleVersion: RECONCILIATION_RULE_VERSION,
      localStage: INTEGRATION_EVENT_STAGE,
      counts,
      evidence: {
        providerRecords: population.recordsFetched,
        providerUnattributed,
        localRowsScanned: local.length,
        localInWindow: inWindow.length,
        localUnresolvedOccurrence,
        localMissingIdentity,
        pagesFetched: population.pagesFetched,
        pageCap: population.pageCap,
        truncated: population.truncated,
      },
      members: memberInputs,
      reason: assessment.problems.length > 0 ? assessment.problems.join('; ') : null,
      observedAt,
      reconciledAt: input.now,
    });

    if (!recorded.ok) {
      return { ok: false, reason: 'DIAGNOSTIC_DEFECT', problems: recorded.problems };
    }
    return { ok: true, day: recorded.day };
  }
}

function addToSplit(
  split: {
    providerOnlyExpected: number;
    providerOnlyNotConfigured: number;
    providerOnlyExcluded: number;
    providerOnlyUnknownMember: number;
  },
  state: ResolvedExpectation,
  providerOnly: number,
): void {
  if (providerOnly === 0) return;
  switch (state) {
    case 'EXPECTED':
      split.providerOnlyExpected += providerOnly;
      return;
    case 'NOT_CONFIGURED':
      split.providerOnlyNotConfigured += providerOnly;
      return;
    case 'EXCLUDED':
      split.providerOnlyExcluded += providerOnly;
      return;
    default:
      split.providerOnlyUnknownMember += providerOnly;
  }
}

// --- Default wiring -------------------------------------------------------------
//
// The only place real dependencies are constructed, and it does nothing but
// construct them. Every call either makes is a read.

/**
 * The provider seam, over the SAME `poll()` certification calls.
 *
 * Not a second opinion about what a provider day is: same adapter, same window,
 * same kind of budget, same truncation reporting. The raw payload is read inside
 * this expression and never leaves it -- only an identity, a member id and a
 * label do, so no caller-number, recording URL or transcript can reach a stored
 * row or a log line.
 */
export function callGridPopulationReader(): ProviderPopulationReader {
  return {
    async enumerate(input) {
      const providers = await import('@emgloop/providers');
      const provider = providers.getCallGridProvider();
      const page = await provider.poll(
        {
          organizationId: input.organizationId,
          credentials: { apiKey: input.apiKey },
          config: input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {},
        },
        { since: input.since, until: input.until, maxPages: input.pageCap },
      );
      const records: ProviderPopulationRecord[] = page.events.map((event) => {
        const payload =
          event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        return {
          identity: normalizeExternalIdentity(event.externalId),
          memberExternalId: memberIdFrom(payload),
          label: memberLabelFrom(payload),
        };
      });
      return {
        records,
        recordsFetched: page.recordsFetched ?? page.events.length,
        pagesFetched: page.pagesFetched ?? 0,
        pageCap: page.pageCap ?? input.pageCap,
        truncated: page.truncated === true,
      };
    },
  };
}

/**
 * The local seam: a batched, organization-scoped SELECT over integration_events.
 *
 * SELECTED BY OCCURRENCE, NOT BY DELIVERY. Until PR #180 there was no occurrence
 * column, so the only way to reach a day's rows was to scan a widened DELIVERY
 * window and filter in memory. That silently excluded any row received far from
 * when it happened -- which is exactly what a recovered call is. A recovery would
 * have written 9,000 correct rows and reconciliation would have gone on reporting
 * them missing.
 *
 * Occurrence for a LEGACY row still comes from the CANONICAL resolver rather than
 * a hand-written JSON expression, so local and provider occurrence semantics stay
 * identical by construction. A SQL filter over the payload would have duplicated
 * the resolver's field precedence and the two would drift -- the previous audit's
 * query already got this wrong once, looking for `UTCUnixTimeMs` when the stored
 * webhook payloads carry `occurredAtUnix`.
 */
export function integrationEventReader(prisma: PrismaClient): LocalDeliveryReader {
  const integrations = new IntegrationRepository(prisma);
  return {
    async read(input) {
      const providers = await import('@emgloop/providers');
      const resolveOccurrence = providers.resolveCallOccurrence;
      const out: LocalDeliveryRecord[] = [];
      let afterId: string | undefined;
      for (;;) {
        const batch = await integrations.listEventsForOccurrenceWindow(input.organizationId, {
          provider: input.provider,
          since: input.since,
          until: input.until,
          legacySince: input.legacySince,
          legacyUntil: input.legacyUntil,
          batchSize: LOCAL_SCAN_BATCH_SIZE,
          ...(afterId ? { afterId } : {}),
        });
        if (batch.length === 0) break;
        for (const row of batch) {
          const payload =
            row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
              ? (row.payload as Record<string, unknown>)
              : {};
          out.push({
            identity: normalizeExternalIdentity(row.externalId),
            // THE STORED COLUMN WINS WHERE IT EXISTS. It was written FROM this same
            // resolver, at ingestion, so today the two agree -- and preferring the
            // column means a later change to the resolver cannot retroactively
            // reclassify a row that was already judged. Only a legacy row, whose
            // column is null, is resolved from the payload here.
            occurredAt: row.occurredAt ?? resolveOccurrence(payload).at,
            memberExternalId: memberIdFrom(payload),
          });
        }
        const last = batch[batch.length - 1];
        if (!last) break;
        afterId = last.id;
        if (batch.length < LOCAL_SCAN_BATCH_SIZE) break;
      }
      return out;
    },
  };
}
