// MeasurementSourceRepository -- Commercial Intelligence Stage 3 correctness.
//
// Persistence for "whose number is this". It stores which sources an
// organization is willing to believe, which measures each may be believed about,
// and which one is authoritative for a given member and measure over a given
// period. It never reads a provider, never reads a call, never computes a
// measurement, and never decides what an authority MEANS -- that rule is pure and
// lives in @emgloop/shared.
//
// A SOURCE CONTAINING A FIELD DOES NOT MAKE IT AUTHORITATIVE FOR THAT FIELD, and
// this file is where that discipline has to hold, because it is the only place a
// write could happen. There is no method here that takes a call, a revenue
// figure, a webhook configuration, an import result or a reconciliation verdict.
// On 2026-08-05 every one of the 974 records the provider held carried
// `converted=false` -- present, not absent -- so a conversion rate computed from
// them would have returned 0% at full coverage and stated a business falsehood as
// a measured fact. Authority is declared by a person or it does not exist.
//
// HISTORY IS NEVER REWRITTEN. Changing which source is authoritative is a NEW
// declaration from a new date; the row it succeeds has exactly one column written
// -- `effectiveTo` -- and keeps its source, reason and author. Re-running last
// month's comparison must resolve the authority that was in force last month,
// or a stored Headline silently changes meaning when a configuration changes.
//
// THE GRAIN IS (member, metric, date), which is the pure contract's grain rather
// than a choice made here. Provider and stream are deliberately absent from the
// authority key: the member is the subject and the source is the answer, so
// keying on provider would ask which source is authoritative for one provider's
// version of a campaign -- not a question anyone has. The source itself carries
// provider and stream, because a polled stream's availability is proven by
// observing that stream.
//
// TENANT-FIRST, AND THE DATABASE HOLDS IT. `organizationId` is the first argument
// of every method, and an authority names its source through a COMPOSITE foreign
// key over (id, organizationId) -- so a declaration cannot name a source another
// organization registered. PR 3 could not do this for its expectation link (a
// nullable column, and a composite SET NULL is syntax Prisma cannot express) and
// enforced ownership in the repository instead; here both columns are required,
// so the database can hold it.
//
// BUSINESS DATES ARE STRINGS AT THE BOUNDARY, DATES IN THE COLUMN, exactly as
// ProviderObservationRepository established.

import type { PrismaClient, MeasureSourceAuthority, MeasurementSource } from '@prisma/client';
import {
  MEASUREMENT_SOURCE_KINDS,
  authorityDeclarationProblems,
  decideEffectiveDatedWrite,
  isBindingDimension,
  isMeasureMetric,
  resolveAuthority,
  type AuthorityResolution,
  type BindingDimension,
  type BusinessDate,
  type MeasureMetric,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementSourceDefinition,
  type MeasurementSourceKind,
} from '@emgloop/shared';

import { businessDateToColumn, columnToBusinessDate } from './provider-observation.repository';

/** Whether a stored string names a source kind. Fails closed. */
export function isMeasurementSourceKind(value: unknown): value is MeasurementSourceKind {
  return typeof value === 'string' && (MEASUREMENT_SOURCE_KINDS as readonly string[]).includes(value);
}

// --- Registering a source ---------------------------------------------------------

/** One measure a source may be believed about, and what it means by it. */
export interface SourceMetricInput {
  metric: MeasureMetric;
  /** What this source means by the metric. Two sources may only be combined when
      they declare the SAME definition, so this is never a display string. */
  measureDefinitionId: string;
}

export interface RegisterSourceInput {
  /** The stable handle an authority declaration names. */
  key: string;
  kind: MeasurementSourceKind;
  displayName: string;
  /** Required for PROVIDER_STREAM, forbidden otherwise. */
  provider?: string | null;
  stream?: string | null;
  /** The measures this source may be authoritative for. Never all by default. */
  metrics: readonly SourceMetricInput[];
}

export type RegisterSourceRejection =
  /** Unknown kind, blank key or display name, or a stream pairing the kind forbids. */
  | 'INVALID_SOURCE'
  /** A metric outside MEASURE_METRICS, a blank definition id, or the same metric twice. */
  | 'INVALID_METRIC';

export type RegisterSourceResult =
  | { ok: true; source: MeasurementSourceDefinition; created: boolean }
  | { ok: false; reason: RegisterSourceRejection; problems: readonly string[] };

// --- Declaring authority ----------------------------------------------------------

export interface DeclareAuthorityInput {
  dimension: BindingDimension;
  memberExternalId: string;
  metric: MeasureMetric;
  /** The key of a source THIS organization has registered. */
  sourceKey: string;
  /** Why, in plain language. Required: an unexplained authority is a place to hide. */
  reason: string;
  /** INCLUSIVE. The first business date this authority speaks for. */
  effectiveFrom: BusinessDate;
  /** EXCLUSIVE. Omit or pass null for open-ended. */
  effectiveTo?: BusinessDate | null;
  /** Who decided. Null when no human actor is resolvable -- never a stand-in. */
  declaredByUserId?: string | null;
}

export type DeclareAuthorityRejection =
  /** The declaration is not well formed: unknown dimension or metric, blank member. */
  | 'INVALID_DECLARATION'
  /** No plain-language reason was given. */
  | 'REASON_REQUIRED'
  /** No source with that key is registered to this organization. */
  | 'SOURCE_NOT_REGISTERED'
  /** The named source does not declare a definition for this metric, so it cannot
      be believed about it. `sourceSupports` would refuse it at the gate anyway;
      refusing here means an operator finds out at declaration time. */
  | 'SOURCE_DOES_NOT_SUPPORT_METRIC'
  /** An authority already in force would be overwritten rather than succeeded. */
  | 'OVERLAPS_EXISTING';

/** A stored authority, as a caller sees it. */
export interface AuthorityDeclarationView extends MeasureSourceAuthorityDeclaration {
  id: string;
  reason: string;
  declaredByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeclareAuthorityResult =
  | {
      ok: true;
      declaration: AuthorityDeclarationView;
      /** The authority this one ended, or null when it started a fresh history. */
      supersededId: string | null;
      /** True when an identical authority was already in force and nothing was
          written. Re-stating what the record already says is not a change. */
      unchanged: boolean;
    }
  | { ok: false; reason: DeclareAuthorityRejection; problems: readonly string[] };

/** Everything `assessReadiness` needs about sources and authority, in its shapes. */
export interface AuthorityReadinessFacts {
  sources: MeasurementSourceDefinition[];
  authorities: MeasureSourceAuthorityDeclaration[];
}

type SourceRow = MeasurementSource & {
  metrics: Array<{ metric: string; measureDefinitionId: string }>;
};

/**
 * A stored source as the pure contract's definition, or null when it cannot be read.
 *
 * FAILS CLOSED ON A VOCABULARY IT DOES NOT RECOGNISE. Kind and metric are TEXT so
 * the vocabularies can widen without production DDL, which means a row can
 * outlive the build that wrote it. Such a row is not interpreted: the source is
 * omitted, and the gate then refuses every measure that named it rather than
 * guessing what it meant. A metric row whose name is unreadable is dropped from
 * an otherwise readable source, which is the same refusal at a finer grain.
 */
function toSourceDefinition(row: SourceRow): MeasurementSourceDefinition | null {
  if (!isMeasurementSourceKind(row.kind)) return null;
  const supportedMetrics: MeasureMetric[] = [];
  const measureDefinitionIds: Partial<Record<MeasureMetric, string>> = {};
  for (const m of row.metrics) {
    if (!isMeasureMetric(m.metric)) continue;
    if (typeof m.measureDefinitionId !== 'string' || m.measureDefinitionId.trim() === '') continue;
    supportedMetrics.push(m.metric);
    measureDefinitionIds[m.metric] = m.measureDefinitionId;
  }
  return {
    key: row.key,
    kind: row.kind,
    displayName: row.displayName,
    supportedMetrics,
    measureDefinitionIds,
    provider: row.provider,
    stream: row.stream,
  };
}

/** A stored authority as the pure contract's declaration, or null when unreadable. */
function toAuthorityDeclaration(
  row: MeasureSourceAuthority,
  sourceKey: string,
): MeasureSourceAuthorityDeclaration | null {
  if (!isBindingDimension(row.memberDimension)) return null;
  if (!isMeasureMetric(row.metric)) return null;
  return {
    dimension: row.memberDimension,
    memberExternalId: row.memberExternalId,
    metric: row.metric,
    sourceKey,
    effectiveFrom: columnToBusinessDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
  };
}

function toAuthorityView(
  row: MeasureSourceAuthority,
  declaration: MeasureSourceAuthorityDeclaration,
): AuthorityDeclarationView {
  return {
    ...declaration,
    id: row.id,
    reason: row.reason,
    declaredByUserId: row.declaredByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sourceProblems(input: RegisterSourceInput): { reason: RegisterSourceRejection; problems: string[] } | null {
  const problems: string[] = [];
  if (!isMeasurementSourceKind(input.kind)) {
    problems.push(`kind must be one of ${MEASUREMENT_SOURCE_KINDS.join(' | ')}`);
  }
  if (typeof input.key !== 'string' || input.key.trim() === '') {
    problems.push('key is required -- it is the handle an authority declaration names');
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim() === '') {
    problems.push('displayName is required');
  }
  // THE PAIRING IS MECHANICAL, NOT TIDY. The kind selects how availability is
  // proven: a polled stream proves it by having been observed and reconciled,
  // which requires naming the stream, and a report that arrives has no stream to
  // observe. The migration enforces the same rule as a CHECK.
  const hasStream = !!input.provider?.trim() && !!input.stream?.trim();
  const hasNeither = !input.provider?.trim() && !input.stream?.trim();
  if (input.kind === 'PROVIDER_STREAM' && !hasStream) {
    problems.push('PROVIDER_STREAM requires both provider and stream');
  }
  if (input.kind !== 'PROVIDER_STREAM' && !hasNeither) {
    problems.push(`provider and stream are only meaningful on PROVIDER_STREAM, not ${input.kind}`);
  }
  if (problems.length > 0) return { reason: 'INVALID_SOURCE', problems };

  const metricProblems: string[] = [];
  const seen = new Set<string>();
  for (const m of input.metrics) {
    if (!isMeasureMetric(m.metric)) {
      metricProblems.push(`${String(m.metric)} is not a measure`);
      continue;
    }
    if (seen.has(m.metric)) metricProblems.push(`${m.metric} is declared twice`);
    seen.add(m.metric);
    if (typeof m.measureDefinitionId !== 'string' || m.measureDefinitionId.trim() === '') {
      metricProblems.push(`${m.metric} needs a measure definition id -- a supported metric without one is not usable`);
    }
  }
  if (metricProblems.length > 0) return { reason: 'INVALID_METRIC', problems: metricProblems };
  return null;
}

export class MeasurementSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Sources --------------------------------------------------------------------

  /**
   * Register a source this organization is willing to believe, or restate one.
   *
   * IDEMPOTENT ON THE SOURCE'S IDENTITY. Re-registering the same key updates its
   * descriptive fields and REPLACES its metric set, so a metric withdrawn from a
   * source stops being supported rather than lingering. That is a write about
   * capability, not about history: which measures a source CAN supply is a
   * present-tense fact, unlike which source is authoritative, which is dated.
   *
   * Withdrawing a metric does NOT retract any authority that named it. The gate
   * refuses such a measure with MEASURE_NOT_SUPPORTED_BY_SOURCE, visibly, rather
   * than this method silently deleting somebody's declaration.
   */
  async registerSource(
    organizationId: string,
    input: RegisterSourceInput,
  ): Promise<RegisterSourceResult> {
    const problems = sourceProblems(input);
    if (problems) return { ok: false, reason: problems.reason, problems: problems.problems };

    const key = input.key.trim();
    const provider = input.kind === 'PROVIDER_STREAM' ? (input.provider?.trim() ?? null) : null;
    const stream = input.kind === 'PROVIDER_STREAM' ? (input.stream?.trim() ?? null) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.measurementSource.findFirst({
        where: { organizationId, key },
        select: { id: true },
      });
      const id = existing
        ? (
            await tx.measurementSource.update({
              where: { id: existing.id },
              data: { kind: input.kind, displayName: input.displayName.trim(), provider, stream },
            })
          ).id
        : (
            await tx.measurementSource.create({
              data: {
                organizationId,
                key,
                kind: input.kind,
                displayName: input.displayName.trim(),
                provider,
                stream,
              },
            })
          ).id;

      // REPLACE, DO NOT MERGE. A metric withdrawn from a source must stop being
      // supported; merging would leave it looking current forever.
      await tx.measurementSourceMetric.deleteMany({ where: { organizationId, measurementSourceId: id } });
      for (const m of input.metrics) {
        await tx.measurementSourceMetric.create({
          data: {
            measurementSourceId: id,
            organizationId,
            metric: m.metric,
            measureDefinitionId: m.measureDefinitionId.trim(),
          },
        });
      }
      return { id, created: !existing };
    });

    const stored = await this.findSource(organizationId, key);
    if (!stored) {
      return {
        ok: false,
        reason: 'INVALID_SOURCE',
        problems: [`the source ${created.id} could not be read back within its organization`],
      };
    }
    return { ok: true, source: stored, created: created.created };
  }

  /** One registered source in the contract's shape, or null when absent/unreadable. */
  async findSource(organizationId: string, key: string): Promise<MeasurementSourceDefinition | null> {
    const row = await this.prisma.measurementSource.findFirst({ where: { organizationId, key } });
    if (!row) return null;
    const metrics = await this.metricsFor(organizationId, [row.id]);
    return toSourceDefinition({ ...row, metrics: metrics.get(row.id) ?? [] });
  }

  /**
   * Every source this organization has registered, in the contract's shape.
   *
   * SOURCES WHOSE STORED KIND CANNOT BE READ ARE OMITTED, not defaulted. The gate
   * then refuses every measure whose authority named them, which is the correct
   * failure -- a source Loop cannot describe is one it must not believe.
   */
  async listSources(organizationId: string): Promise<MeasurementSourceDefinition[]> {
    const rows = await this.prisma.measurementSource.findMany({
      where: { organizationId },
      orderBy: { key: 'asc' },
    });
    if (rows.length === 0) return [];
    const metrics = await this.metricsFor(organizationId, rows.map((r) => r.id));
    const out: MeasurementSourceDefinition[] = [];
    for (const row of rows) {
      const definition = toSourceDefinition({ ...row, metrics: metrics.get(row.id) ?? [] });
      if (definition) out.push(definition);
    }
    return out;
  }

  // --- Authority ------------------------------------------------------------------

  /**
   * Declare which source is authoritative for one member and measure, from a date.
   *
   * PRESERVES HISTORY BY CONSTRUCTION, exactly as the expectation repository
   * does: an authority already in force that STARTS EARLIER is ended at the new
   * one's start date -- one column, written once -- and everything it said about
   * the dates it covered stays as it was. An authority that starts on or after the
   * new one is NOT touched; swallowing a future statement somebody recorded would
   * be the overwrite this table exists to prevent.
   *
   * REFUSES A SOURCE THAT CANNOT SUPPLY THE MEASURE. `sourceSupports` would refuse
   * it at the gate anyway; refusing here means the operator learns at declaration
   * time rather than the next time a measurement silently withholds.
   */
  async declareAuthority(
    organizationId: string,
    input: DeclareAuthorityInput,
  ): Promise<DeclareAuthorityResult> {
    const memberExternalId = input.memberExternalId?.trim() ?? '';
    const reason = input.reason?.trim() ?? '';
    const sourceKey = input.sourceKey?.trim() ?? '';

    const candidate: MeasureSourceAuthorityDeclaration = {
      dimension: input.dimension,
      memberExternalId,
      metric: input.metric,
      sourceKey,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    };

    // SHAPE FIRST, and the rule is the pure one, so the persisted rows and the
    // contract that reads them cannot drift on what is well formed.
    const problems = authorityDeclarationProblems(candidate);
    if (!isBindingDimension(input.dimension)) {
      problems.push(`${String(input.dimension)} is not a population dimension`);
    }
    if (problems.length > 0) return { ok: false, reason: 'INVALID_DECLARATION', problems };
    if (reason === '') {
      return {
        ok: false,
        reason: 'REASON_REQUIRED',
        problems: ['an authority must say why, in plain language'],
      };
    }

    // THE SOURCE IS RESOLVED WITHIN THE ORGANIZATION. A cross-tenant key is simply
    // absent -- not-found rather than forbidden -- and the composite foreign key
    // is the backstop if this check were ever bypassed.
    const source = await this.prisma.measurementSource.findFirst({
      where: { organizationId, key: sourceKey },
    });
    if (!source) {
      return {
        ok: false,
        reason: 'SOURCE_NOT_REGISTERED',
        problems: [`no source is registered under that key for this organization`],
      };
    }
    const sourceMetrics = await this.metricsFor(organizationId, [source.id]);
    const definition = toSourceDefinition({ ...source, metrics: sourceMetrics.get(source.id) ?? [] });
    if (!definition || !definition.supportedMetrics.includes(input.metric)) {
      return {
        ok: false,
        reason: 'SOURCE_DOES_NOT_SUPPORT_METRIC',
        problems: [`${sourceKey} declares no definition for ${input.metric}`],
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.measureSourceAuthority.findMany({
          where: {
            organizationId,
            memberDimension: candidate.dimension,
            memberExternalId,
            metric: candidate.metric,
          },
          orderBy: { effectiveFrom: 'asc' },
        });

        // THE SAME OVERLAP REASONING THE EXPECTATION TABLE USES, from the same
        // pure function. What "already says the same thing" means stays here,
        // because only this table knows its statement is the source.
        const decision = decideEffectiveDatedWrite(
          rows,
          candidate,
          (row) => ({
            effectiveFrom: columnToBusinessDate(row.effectiveFrom),
            effectiveTo: row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
          }),
          (row) => row.measurementSourceId === source.id,
        );

        if (decision.kind === 'EQUIVALENT') {
          const declaration = toAuthorityDeclaration(decision.row, sourceKey)!;
          return {
            ok: true as const,
            declaration: toAuthorityView(decision.row, declaration),
            supersededId: null,
            unchanged: true,
          };
        }
        if (decision.kind === 'BLOCKED') {
          return {
            ok: false as const,
            reason: 'OVERLAPS_EXISTING' as const,
            problems: decision.problems.map((p) => `${p} for this member and measure`),
          };
        }

        const predecessor = decision.predecessor;
        if (predecessor) {
          // ONE COLUMN. The source, reason and author of what was authoritative
          // before this date are never touched.
          await tx.measureSourceAuthority.update({
            where: { id: predecessor.id },
            data: { effectiveTo: businessDateToColumn(candidate.effectiveFrom) },
          });
        }

        const row = await tx.measureSourceAuthority.create({
          data: {
            organizationId,
            memberDimension: candidate.dimension,
            memberExternalId,
            metric: candidate.metric,
            measurementSourceId: source.id,
            reason,
            effectiveFrom: businessDateToColumn(candidate.effectiveFrom),
            effectiveTo:
              candidate.effectiveTo === null ? null : businessDateToColumn(candidate.effectiveTo),
            declaredByUserId: input.declaredByUserId ?? null,
          },
        });
        return {
          ok: true as const,
          declaration: toAuthorityView(row, toAuthorityDeclaration(row, sourceKey)!),
          supersededId: predecessor?.id ?? null,
          unchanged: false,
        };
      });
    } catch (error) {
      // The backstop firing means two declarations raced. Reporting it as the
      // overlap it is beats a 500 the caller cannot act on.
      if (isOverlapViolation(error)) {
        return {
          ok: false,
          reason: 'OVERLAPS_EXISTING',
          problems: ['another authority for this member and measure was recorded concurrently'],
        };
      }
      throw error;
    }
  }

  /**
   * Which source was authoritative for one member and measure on one date.
   *
   * RETURNS THE PR 1 VOCABULARY, JUDGED BY THE PR 1 RULE. This method resolves
   * nothing itself: it hands the stored declarations to `resolveAuthority` and
   * returns what that says, so the persisted answer and the pure answer cannot
   * diverge. No declaration is MISSING -- never "assume the provider", which is
   * precisely the assumption that made a conversion rate computable from fields
   * nobody had said were authoritative. More than one is CONFLICT, never a
   * precedence puzzle.
   */
  async resolveAuthorityOn(
    organizationId: string,
    dimension: BindingDimension,
    memberExternalId: string,
    metric: MeasureMetric,
    on: BusinessDate,
  ): Promise<AuthorityResolution> {
    const { declarations, unreadableOnDate } = await this.readDeclarations(
      organizationId,
      dimension,
      memberExternalId,
      metric,
      on,
    );
    const resolution = resolveAuthority(declarations, dimension, memberExternalId, metric, on);
    // Rows whose stored vocabulary cannot be read AND which cover the date asked
    // about are not interpreted, and not ignored either: dropping one could turn
    // a two-way conflict into a confident answer.
    if (unreadableOnDate > 0) {
      return { outcome: 'CONFLICT', sourceKey: null, matches: resolution.matches + unreadableOnDate };
    }
    return resolution;
  }

  /** Every authority ever declared for one member and measure, oldest first. */
  async authoritiesFor(
    organizationId: string,
    dimension: BindingDimension,
    memberExternalId: string,
    metric: MeasureMetric,
  ): Promise<AuthorityDeclarationView[]> {
    const rows = await this.loadRows(organizationId, dimension, memberExternalId, metric);
    const keys = await this.sourceKeysById(organizationId);
    const out: AuthorityDeclarationView[] = [];
    for (const row of rows) {
      const key = keys.get(row.measurementSourceId);
      if (!key) continue;
      const declaration = toAuthorityDeclaration(row, key);
      if (declaration) out.push(toAuthorityView(row, declaration));
    }
    return out;
  }

  /**
   * Everything `assessReadiness` needs about sources and authority, in ITS shapes.
   *
   * THE WHOLE POINT OF THIS METHOD IS THAT THERE IS NO SECOND READINESS ENGINE.
   * It returns `MeasurementSourceDefinition[]` and
   * `MeasureSourceAuthorityDeclaration[]` -- the exact arrays `ReadinessInput`
   * already declares -- so persisted authority reaches the gate as data rather
   * than as a parallel judgement. Nothing here decides whether a measure is
   * ready, and nothing here may ever begin to.
   *
   * Every authority ever declared for the requested members is returned, not only
   * the ones in force today: the gate resolves per business date, and a window
   * that spans a change of authority needs both sides of it.
   */
  async readinessFacts(
    organizationId: string,
    members: readonly { dimension: BindingDimension; memberExternalId: string }[],
    metric: MeasureMetric,
  ): Promise<AuthorityReadinessFacts> {
    const sources = await this.listSources(organizationId);
    if (members.length === 0) return { sources, authorities: [] };

    const keys = await this.sourceKeysById(organizationId);
    const rows = await this.prisma.measureSourceAuthority.findMany({
      where: {
        organizationId,
        metric,
        OR: members.map((m) => ({
          memberDimension: m.dimension,
          memberExternalId: m.memberExternalId,
        })),
      },
      orderBy: { effectiveFrom: 'asc' },
    });
    const authorities: MeasureSourceAuthorityDeclaration[] = [];
    for (const row of rows) {
      const key = keys.get(row.measurementSourceId);
      if (!key) continue;
      const declaration = toAuthorityDeclaration(row, key);
      if (declaration) authorities.push(declaration);
    }
    return { sources, authorities };
  }

  // --- Internals --------------------------------------------------------------------

  private async loadRows(
    organizationId: string,
    dimension: BindingDimension,
    memberExternalId: string,
    metric: MeasureMetric,
  ): Promise<MeasureSourceAuthority[]> {
    return this.prisma.measureSourceAuthority.findMany({
      where: { organizationId, memberDimension: dimension, memberExternalId, metric },
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  /**
   * The metric rows for a set of sources, keyed by source id.
   *
   * TWO SCOPED READS RATHER THAN A RELATION INCLUDE. The metric table carries its
   * own `organizationId`, so this read states the tenant itself instead of
   * inheriting one implicitly through a join -- the same stance
   * `memberFactsForDates` takes in the reconciliation repository.
   */
  private async metricsFor(
    organizationId: string,
    sourceIds: readonly string[],
  ): Promise<Map<string, Array<{ metric: string; measureDefinitionId: string }>>> {
    const out = new Map<string, Array<{ metric: string; measureDefinitionId: string }>>();
    if (sourceIds.length === 0) return out;
    const rows = await this.prisma.measurementSourceMetric.findMany({
      where: { organizationId, measurementSourceId: { in: [...sourceIds] } },
      orderBy: { metric: 'asc' },
    });
    for (const row of rows) {
      const list = out.get(row.measurementSourceId) ?? [];
      list.push({ metric: row.metric, measureDefinitionId: row.measureDefinitionId });
      out.set(row.measurementSourceId, list);
    }
    return out;
  }

  private async sourceKeysById(organizationId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.measurementSource.findMany({
      where: { organizationId },
      select: { id: true, key: true },
    });
    return new Map(rows.map((r) => [r.id, r.key]));
  }

  private async readDeclarations(
    organizationId: string,
    dimension: BindingDimension,
    memberExternalId: string,
    metric: MeasureMetric,
    on: BusinessDate,
  ): Promise<{ declarations: MeasureSourceAuthorityDeclaration[]; unreadableOnDate: number }> {
    const rows = await this.loadRows(organizationId, dimension, memberExternalId, metric);
    const keys = await this.sourceKeysById(organizationId);
    const declarations: MeasureSourceAuthorityDeclaration[] = [];
    let unreadableOnDate = 0;
    for (const row of rows) {
      const key = keys.get(row.measurementSourceId);
      const declaration = key ? toAuthorityDeclaration(row, key) : null;
      if (declaration) declarations.push(declaration);
      else if (rawRangeCovers(row, on)) unreadableOnDate += 1;
    }
    return { declarations, unreadableOnDate };
  }
}

/** Whether an UNREADABLE row's raw range covers a date. Deliberately not the pure
    rule: the point is to count a row that cannot be parsed into one. */
function rawRangeCovers(row: MeasureSourceAuthority, on: BusinessDate): boolean {
  const from = columnToBusinessDate(row.effectiveFrom);
  const to = row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo);
  if (on < from) return false;
  return to === null || on < to;
}

/** Whether a Prisma error is the exclusion constraint firing. */
function isOverlapViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === '23P01' || code === 'P2010') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('measure_source_authorities_no_overlap');
}
