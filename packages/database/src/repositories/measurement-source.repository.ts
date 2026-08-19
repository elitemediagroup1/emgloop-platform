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
  | 'INVALID_METRIC'
  /** A source is already registered under this key and IS something else -- a
      different kind, provider or stream. Re-pointing an existing key would
      silently change what every authority naming it means. */
  | 'SOURCE_IDENTITY_CONFLICT'
  /** The source already declares this metric with a DIFFERENT definition id.
      Overwriting it would silently redefine what a stored measurement measured. */
  | 'METRIC_DEFINITION_CONFLICT';

/** What registering did, or what it would do. */
export type RegisterSourceOutcome =
  /** The source did not exist. It and its metrics were written. */
  | 'CREATED'
  /** The source existed and gained at least one metric it did not have. */
  | 'ADDED_METRIC'
  /** Everything asked for is already recorded, identically. Nothing written. */
  | 'ALREADY_EQUIVALENT';

export type RegisterSourceResult =
  | {
      ok: true;
      source: MeasurementSourceDefinition;
      outcome: RegisterSourceOutcome;
      /** The metrics this call added, in input order. Empty on ALREADY_EQUIVALENT. */
      addedMetrics: readonly MeasureMetric[];
    }
  | { ok: false; reason: RegisterSourceRejection; problems: readonly string[] };

/** What registering WOULD do, decided by the same function the write uses. */
export interface RegisterSourcePreview {
  outcome: RegisterSourceOutcome | 'BLOCKED';
  /** The source as it stands today, or null when this key is unregistered. */
  existing: MeasurementSourceDefinition | null;
  /** The metrics the write would add. Empty when it would add none. */
  wouldAddMetrics: readonly MeasureMetric[];
  /** Set only when BLOCKED, from the same closed list `registerSource` uses. */
  reason: RegisterSourceRejection | null;
  problems: readonly string[];
}

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

// --- Correcting a mistyped definition ---------------------------------------------

export interface CorrectDefinitionInput {
  /** The key of a source THIS organization has registered. */
  sourceKey: string;
  /** The measure whose definition is being corrected. Never changed itself. */
  metric: MeasureMetric;
  /** The definition id the source should have declared. */
  measureDefinitionId: string;
  /** Why, in plain language. Required, and recorded in the run log. */
  reason: string;
}

/** Why a correction did not happen. Each is a state, not a failure of nerve. */
export type CorrectDefinitionRejection =
  | 'INVALID_REQUEST'
  | 'SOURCE_NOT_FOUND'
  | 'METRIC_NOT_FOUND'
  | 'ALREADY_EQUIVALENT'
  /** An authority names this source for this measure. See `correctMeasureDefinition`. */
  | 'BLOCKED_AUTHORITY_EXISTS';

export type CorrectDefinitionResult =
  | {
      ok: true;
      sourceKey: string;
      metric: MeasureMetric;
      /** What the row said before. Kept so the run log can show both. */
      from: string;
      to: string;
      authorityCount: 0;
    }
  | {
      ok: false;
      reason: CorrectDefinitionRejection;
      problems: readonly string[];
      currentDefinitionId: string | null;
      authorityCount: number;
    };

export interface CorrectDefinitionPreview {
  outcome: 'WOULD_CORRECT' | CorrectDefinitionRejection;
  currentDefinitionId: string | null;
  requestedDefinitionId: string;
  /** How many authorities name this source for this measure. Non-zero blocks. */
  authorityCount: number;
  problems: readonly string[];
}

/** The three facts a correction turns on. */
export interface CorrectionState {
  sourceId: string | null;
  metricRowId: string | null;
  currentDefinitionId: string | null;
  authorityCount: number;
}

export type CorrectDefinitionDecision =
  | { kind: 'CORRECT'; from: string; to: string }
  | { kind: CorrectDefinitionRejection; problems: string[] };

/**
 * Whether a definition may be corrected, decided in ONE place.
 *
 * ORDER IS DELIBERATE. Existence first, because an operator who mistyped the
 * source key needs to hear that rather than a guess about authority. Then the
 * no-op, because restating what the row already says is not a correction and
 * must not consume the one-time window. Then the authority guard LAST, so the
 * blocked message can name what the row currently says -- the operator's next
 * question is always "then what is in there?"
 */
export function decideMeasureDefinitionCorrection(
  state: CorrectionState,
  requestedDefinitionId: string,
): CorrectDefinitionDecision {
  if (state.sourceId === null) {
    return { kind: 'SOURCE_NOT_FOUND', problems: ['no source is registered under that key for this organization'] };
  }
  if (state.metricRowId === null || state.currentDefinitionId === null) {
    return { kind: 'METRIC_NOT_FOUND', problems: ['that source does not declare this measure'] };
  }
  if (state.currentDefinitionId === requestedDefinitionId) {
    return { kind: 'ALREADY_EQUIVALENT', problems: ['the source already declares exactly this definition'] };
  }
  if (state.authorityCount > 0) {
    return {
      kind: 'BLOCKED_AUTHORITY_EXISTS',
      problems: [
        `${state.authorityCount} authority declaration(s) name this source for this measure, so it may already have been measured from`,
        `the definition stays "${state.currentDefinitionId}"; register a NEW source rather than redefining a measure a published number may rest on`,
      ],
    };
  }
  return { kind: 'CORRECT', from: state.currentDefinitionId, to: requestedDefinitionId };
}

function correctionProblems(
  input: CorrectDefinitionInput,
): { reason: 'INVALID_REQUEST'; problems: string[] } | null {
  const problems: string[] = [];
  if (typeof input.sourceKey !== 'string' || input.sourceKey.trim() === '') {
    problems.push('sourceKey is required');
  }
  if (!isMeasureMetric(input.metric)) {
    problems.push(`${String(input.metric)} is not a measure`);
  }
  if (typeof input.measureDefinitionId !== 'string' || input.measureDefinitionId.trim() === '') {
    // The same refusal the database CHECK makes, reached before a write is
    // attempted: blanking a definition would leave the metric supported and
    // unusable, which `sourceSupports` treats as not supported at all.
    problems.push('measureDefinitionId is required and cannot be blank');
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    problems.push('a correction must say why, in plain language');
  }
  return problems.length > 0 ? { reason: 'INVALID_REQUEST', problems } : null;
}

/** What `$transaction` hands a callback. Narrowed to what corrections use. */
type TransactionClient = Pick<
  PrismaClient,
  'measurementSource' | 'measurementSourceMetric' | 'measureSourceAuthority'
>;

/** What declaring WOULD do, decided by the same functions the write uses. */
export interface AuthorityDeclarationPreview {
  outcome: 'WOULD_CREATE' | 'WOULD_SUPERSEDE' | 'ALREADY_EQUIVALENT' | 'BLOCKED';
  /** The authority in force on `effectiveFrom` today, or null when none is. */
  effectiveNow: AuthorityDeclarationView | null;
  /** The authority the write would END at the new start date, when there is one. */
  supersedes: AuthorityDeclarationView | null;
  /** Set only when BLOCKED, from the same closed list `declareAuthority` uses. */
  reason: DeclareAuthorityRejection | null;
  problems: readonly string[];
  /** The source key that would be recorded. Absent when BLOCKED. */
  sourceKey?: string;
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

/**
 * What registering this source would do, given what is already stored.
 *
 * THE DECISION IS MADE HERE AND NOWHERE ELSE. `registerSource` asks it inside a
 * transaction and `previewSourceRegistration` asks it without one, so an
 * operator asking "what would this do" and the write that follows can never
 * disagree. Working it out twice is how a dry run eventually reassures somebody
 * about a write that then does something else -- and it is the parallel system
 * CLAUDE.md names first.
 *
 * ADDITIVE, AND REFUSES RATHER THAN OVERWRITES. Both refusals exist because this
 * table is named by authority declarations that outlive it:
 *
 * A source's KIND, PROVIDER and STREAM are what it IS. Re-pointing an existing
 * key at a different stream would silently change the meaning of every authority
 * naming that key, including ones already used to publish a number. `displayName`
 * is deliberately NOT part of that test -- it is for a person reading a screen,
 * never identity, so renaming stays free.
 *
 * A metric's DEFINITION ID is what the source means by that measure. Overwriting
 * it would silently redefine what a stored measurement measured, and would break
 * the one rule that lets two sources ever be combined: that they declare the SAME
 * definition. So a conflicting definition is refused and a person resolves it.
 *
 * METRICS NOT NAMED ARE LEFT ALONE. Withdrawing one is a separate, deliberate act
 * -- never a side effect of registering a different metric.
 */
export type SourceRegistrationDecision =
  | { kind: 'CREATE' }
  | { kind: 'ADD_METRIC'; add: MeasureMetric[] }
  | { kind: 'EQUIVALENT' }
  | { kind: 'BLOCKED'; reason: RegisterSourceRejection; problems: string[] };

export function decideSourceRegistration(
  existing: { kind: string; provider: string | null; stream: string | null } | null,
  existingMetrics: ReadonlyMap<string, string>,
  input: { kind: MeasurementSourceKind; provider: string | null; stream: string | null; metrics: readonly SourceMetricInput[] },
): SourceRegistrationDecision {
  if (existing === null) return { kind: 'CREATE' };

  const problems: string[] = [];
  if (existing.kind !== input.kind) {
    problems.push(`the registered source is ${existing.kind}, not ${input.kind}`);
  }
  if ((existing.provider ?? null) !== input.provider) {
    problems.push('the registered source names a different provider');
  }
  if ((existing.stream ?? null) !== input.stream) {
    problems.push('the registered source names a different stream');
  }
  if (problems.length > 0) return { kind: 'BLOCKED', reason: 'SOURCE_IDENTITY_CONFLICT', problems };

  const add: MeasureMetric[] = [];
  const conflicts: string[] = [];
  for (const m of input.metrics) {
    const stored = existingMetrics.get(m.metric);
    const wanted = m.measureDefinitionId.trim();
    if (stored === undefined) {
      add.push(m.metric);
      continue;
    }
    if (stored !== wanted) {
      conflicts.push(`${m.metric} is already defined as "${stored}" on this source`);
    }
  }
  if (conflicts.length > 0) {
    return { kind: 'BLOCKED', reason: 'METRIC_DEFINITION_CONFLICT', problems: conflicts };
  }
  if (add.length > 0) return { kind: 'ADD_METRIC', add };
  return { kind: 'EQUIVALENT' };
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
   * Register a source this organization is willing to believe, or add a measure
   * to one already registered.
   *
   * ADDITIVE AND REFUSING, NEVER OVERWRITING. This method originally REPLACED a
   * source's metric set on every call, on the reasoning that a withdrawn metric
   * must stop being supported rather than linger. That reasoning was sound for a
   * whole-set declaration and became a hazard the moment a caller existed: the
   * operations bridge registers ONE metric per dispatch, deliberately, so a
   * replace would have silently deleted every OTHER metric the source declared —
   * and a metric row is not protected by the ON DELETE RESTRICT that guards the
   * source itself, so authorities naming it would have started failing the gate
   * with no write anybody performed on them.
   *
   * So: metrics not named are left alone, a metric already declared identically
   * is a no-op, and a metric already declared DIFFERENTLY is refused rather than
   * redefined. Withdrawing a metric is now a separate deliberate act, which is
   * what it always should have been. See `decideSourceRegistration` for why each
   * refusal exists.
   *
   * Withdrawing a metric does NOT retract any authority that named it. The gate
   * refuses such a measure with MEASURE_NOT_SUPPORTED_BY_SOURCE, visibly, rather
   * than this method silently invalidating somebody's declaration.
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

    const written = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.measurementSource.findFirst({ where: { organizationId, key } });
      const stored = existing
        ? await tx.measurementSourceMetric.findMany({
            where: { organizationId, measurementSourceId: existing.id },
          })
        : [];
      const decision = decideSourceRegistration(
        existing,
        new Map(stored.map((m) => [m.metric, m.measureDefinitionId])),
        { kind: input.kind, provider, stream, metrics: input.metrics },
      );
      // Returned with the same shape as the success path so the caller reads one
      // union rather than narrowing two.
      if (decision.kind === 'BLOCKED') {
        return { decision, id: '', added: [] as MeasureMetric[] } as const;
      }

      // A RENAME IS NOT A CONFLICT, so it is applied on any non-blocked write.
      // Identity was already proven equal above; only the label can differ.
      const id = existing
        ? (
            await tx.measurementSource.update({
              where: { id: existing.id },
              data: { displayName: input.displayName.trim() },
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

      // ADDITIVE. Only metrics the source does not already declare are written,
      // and a metric it declares identically is left exactly as it was -- so
      // re-running a registration cannot move an existing row's `updatedAt` and
      // make an untouched definition look freshly decided.
      const toAdd =
        decision.kind === 'CREATE'
          ? input.metrics
          : decision.kind === 'ADD_METRIC'
            ? input.metrics.filter((m) => decision.add.includes(m.metric))
            : [];
      for (const m of toAdd) {
        await tx.measurementSourceMetric.create({
          data: {
            measurementSourceId: id,
            organizationId,
            metric: m.metric,
            measureDefinitionId: m.measureDefinitionId.trim(),
          },
        });
      }
      return { decision, id, added: toAdd.map((m) => m.metric) } as const;
    });

    if (written.decision.kind === 'BLOCKED') {
      return {
        ok: false,
        reason: written.decision.reason,
        problems: written.decision.problems,
      };
    }

    const stored = await this.findSource(organizationId, key);
    if (!stored) {
      return {
        ok: false,
        reason: 'INVALID_SOURCE',
        problems: [`the source ${written.id} could not be read back within its organization`],
      };
    }
    const outcome: RegisterSourceOutcome =
      written.decision.kind === 'CREATE'
        ? 'CREATED'
        : written.decision.kind === 'ADD_METRIC'
          ? 'ADDED_METRIC'
          : 'ALREADY_EQUIVALENT';
    return { ok: true, source: stored, outcome, addedMetrics: written.added };
  }

  /**
   * What `registerSource` would do, without doing it.
   *
   * IT DOES NOT CALL THE WRITE. A dry run that invoked a mutating method would
   * be a write with a comment on it. It reads the same two rows the write reads
   * and asks the same decision function, so a preview reporting ADDED_METRIC
   * cannot be followed by a write that refuses.
   */
  async previewSourceRegistration(
    organizationId: string,
    input: RegisterSourceInput,
  ): Promise<RegisterSourcePreview> {
    const shape = sourceProblems(input);
    if (shape) {
      return {
        outcome: 'BLOCKED',
        existing: null,
        wouldAddMetrics: [],
        reason: shape.reason,
        problems: shape.problems,
      };
    }
    const key = input.key.trim();
    const provider = input.kind === 'PROVIDER_STREAM' ? (input.provider?.trim() ?? null) : null;
    const stream = input.kind === 'PROVIDER_STREAM' ? (input.stream?.trim() ?? null) : null;

    const row = await this.prisma.measurementSource.findFirst({ where: { organizationId, key } });
    const storedMetrics = row
      ? await this.prisma.measurementSourceMetric.findMany({
          where: { organizationId, measurementSourceId: row.id },
        })
      : [];
    const existing = row
      ? toSourceDefinition({
          ...row,
          metrics: storedMetrics.map((m) => ({
            metric: m.metric,
            measureDefinitionId: m.measureDefinitionId,
          })),
        })
      : null;

    const decision = decideSourceRegistration(
      row,
      new Map(storedMetrics.map((m) => [m.metric, m.measureDefinitionId])),
      { kind: input.kind, provider, stream, metrics: input.metrics },
    );
    if (decision.kind === 'BLOCKED') {
      return {
        outcome: 'BLOCKED',
        existing,
        wouldAddMetrics: [],
        reason: decision.reason,
        problems: decision.problems,
      };
    }
    return {
      outcome:
        decision.kind === 'CREATE'
          ? 'CREATED'
          : decision.kind === 'ADD_METRIC'
            ? 'ADDED_METRIC'
            : 'ALREADY_EQUIVALENT',
      existing,
      wouldAddMetrics:
        decision.kind === 'CREATE'
          ? input.metrics.map((m) => m.metric)
          : decision.kind === 'ADD_METRIC'
            ? decision.add
            : [],
      reason: null,
      problems: [],
    };
  }

  /** One registered source in the contract's shape, or null when absent/unreadable. */
  async findSource(organizationId: string, key: string): Promise<MeasurementSourceDefinition | null> {
    const row = await this.prisma.measurementSource.findFirst({ where: { organizationId, key } });
    if (!row) return null;
    const metrics = await this.metricsFor(organizationId, [row.id]);
    return toSourceDefinition({ ...row, metrics: metrics.get(row.id) ?? [] });
  }

  // --- Correcting a definition that was mistyped -----------------------------------

  /**
   * Correct the definition id on a metric a source already declares.
   *
   * WHY THIS EXISTS AT ALL, GIVEN REGISTRATION REFUSES TO OVERWRITE. Registration
   * refuses a differing definition id because overwriting one silently redefines
   * what a stored measurement measured. That refusal is right, and it has one
   * consequence nobody wanted: a definition id typed wrongly on the first
   * registration is unfixable through the registration path forever. This is the
   * narrow, guarded exception, and it is a CORRECTION -- one column, one row --
   * never a second way to register.
   *
   * THE SAFETY CONDITION IS NOT REFERENTIAL, WHICH IS EXACTLY WHY IT NEEDS A
   * GUARD. Nothing in the database references a metric ROW: `MeasureSourceAuthority`
   * names the SOURCE through a composite foreign key and carries `metric` as a
   * plain string column, and `measureDefinitionId` is stored in exactly one place
   * and copied nowhere. So Postgres would accept this update at any time, under
   * any circumstances, and report nothing wrong. The danger is entirely semantic,
   * and a semantic danger the database cannot see is one the repository must
   * refuse itself.
   *
   * SO: CORRECTION IS SAFE ONLY WHILE NO AUTHORITY NAMES THIS SOURCE FOR THIS
   * MEASURE.
   *
   * Before any authority exists, no measurement can have been computed from this
   * source at all -- the gate resolves MISSING and withholds -- so no published
   * number depends on the old string, and correcting it changes the meaning of
   * nothing.
   *
   * Once an authority exists, the source can be measured from, and the definition
   * id becomes load-bearing in two directions at once: it says what a stored
   * measurement measured, and it decides whether this source may ever be combined
   * with another. Changing it then would retroactively redefine a published
   * number and silently start or stop two sources agreeing -- with no write to
   * the authority, no write to the Headline, and nothing in either to show it
   * happened. That is refused, and the operator declares a NEW source instead.
   */
  async correctMeasureDefinition(
    organizationId: string,
    input: CorrectDefinitionInput,
  ): Promise<CorrectDefinitionResult> {
    const shape = correctionProblems(input);
    if (shape) {
      return {
        ok: false,
        reason: shape.reason,
        problems: shape.problems,
        currentDefinitionId: null,
        authorityCount: 0,
      };
    }

    const sourceKey = input.sourceKey.trim();
    const newDefinitionId = input.measureDefinitionId.trim();

    return this.prisma.$transaction(async (tx) => {
      // THE AUTHORITY CHECK IS RE-ASKED INSIDE THE TRANSACTION, not carried over
      // from the preview. There is no database constraint behind this invariant,
      // so the narrowest possible window between deciding and writing is the only
      // protection there is. See the note on the residual race below.
      const state = await this.readCorrectionState(tx, organizationId, sourceKey, input.metric);
      const decision = decideMeasureDefinitionCorrection(state, newDefinitionId);

      if (decision.kind !== 'CORRECT') {
        return {
          ok: false as const,
          reason: decision.kind,
          problems: decision.problems,
          currentDefinitionId: decision.kind === 'ALREADY_EQUIVALENT' ? newDefinitionId : (state.currentDefinitionId ?? null),
          authorityCount: state.authorityCount,
        };
      }

      // ONE COLUMN, ON ONE ROW, RESOLVED WITHIN THE ORGANIZATION. The row is
      // addressed by its own id -- already proven to belong to this tenant's
      // source by the scoped read above -- and nothing else about it is touched:
      // not the metric, not the source it belongs to, not the source's key, kind,
      // provider or stream.
      await tx.measurementSourceMetric.update({
        where: { id: state.metricRowId! },
        data: { measureDefinitionId: newDefinitionId },
      });

      return {
        ok: true as const,
        sourceKey,
        metric: input.metric,
        from: decision.from,
        to: decision.to,
        authorityCount: 0,
      };
    });
  }

  /**
   * What correcting a definition WOULD do, without doing it.
   *
   * It reads the same three things the write reads and asks the SAME decision
   * function, so a preview reporting WOULD_CORRECT cannot be followed by a write
   * that refuses -- except in the one case that matters and cannot be designed
   * away: an authority declared between the two calls. The write re-asks inside
   * its transaction precisely so that case is caught there rather than assumed
   * away here.
   */
  async previewMeasureDefinitionCorrection(
    organizationId: string,
    input: CorrectDefinitionInput,
  ): Promise<CorrectDefinitionPreview> {
    const shape = correctionProblems(input);
    if (shape) {
      return {
        outcome: shape.reason,
        currentDefinitionId: null,
        requestedDefinitionId: input.measureDefinitionId?.trim() ?? '',
        authorityCount: 0,
        problems: shape.problems,
      };
    }
    const sourceKey = input.sourceKey.trim();
    const requested = input.measureDefinitionId.trim();
    const state = await this.readCorrectionState(this.prisma, organizationId, sourceKey, input.metric);
    const decision = decideMeasureDefinitionCorrection(state, requested);

    return {
      outcome: decision.kind === 'CORRECT' ? 'WOULD_CORRECT' : decision.kind,
      currentDefinitionId: state.currentDefinitionId ?? null,
      requestedDefinitionId: requested,
      authorityCount: state.authorityCount,
      problems: decision.kind === 'CORRECT' ? [] : decision.problems,
    };
  }

  /**
   * The three facts a correction turns on, read within the organization.
   *
   * Takes the client so the write can ask it inside its transaction and the
   * preview outside one, without two versions of the query existing.
   */
  private async readCorrectionState(
    client: PrismaClient | TransactionClient,
    organizationId: string,
    sourceKey: string,
    metric: MeasureMetric,
  ): Promise<CorrectionState> {
    const source = await client.measurementSource.findFirst({
      where: { organizationId, key: sourceKey },
      select: { id: true },
    });
    if (!source) {
      return { sourceId: null, metricRowId: null, currentDefinitionId: null, authorityCount: 0 };
    }
    const row = await client.measurementSourceMetric.findFirst({
      where: { organizationId, measurementSourceId: source.id, metric },
      select: { id: true, measureDefinitionId: true },
    });
    // COUNTED EVEN WHEN THE METRIC ROW IS ABSENT. An authority naming a source
    // for a measure the source no longer declares is a state worth reporting
    // rather than hiding behind METRIC_NOT_FOUND.
    const authorityCount = await client.measureSourceAuthority.count({
      where: { organizationId, measurementSourceId: source.id, metric },
    });
    return {
      sourceId: source.id,
      metricRowId: row?.id ?? null,
      currentDefinitionId: row?.measureDefinitionId ?? null,
      authorityCount,
    };
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
  /**
   * Everything that must be true before an authority may be written, resolved
   * once and shared by the write and the preview.
   *
   * IT EXISTS SO A DRY RUN CANNOT DISAGREE WITH THE WRITE. Every refusal an
   * operator can hit before the effective-dating decision — a malformed
   * declaration, a missing reason, a source this organization has not
   * registered, a source that declares no definition for the measure — is
   * decided here, in one place, and both paths get the same answer.
   */
  private async prepareDeclaration(
    organizationId: string,
    input: DeclareAuthorityInput,
  ): Promise<
    | {
        ok: true;
        candidate: MeasureSourceAuthorityDeclaration;
        source: MeasurementSource;
        sourceKey: string;
        memberExternalId: string;
        reason: string;
      }
    | { ok: false; reason: DeclareAuthorityRejection; problems: readonly string[] }
  > {
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
    return { ok: true, candidate, source, sourceKey, memberExternalId, reason };
  }

  /**
   * What `declareAuthority` would do, without doing it.
   *
   * IT DOES NOT CALL THE WRITE, and it does not open a transaction. It asks
   * `prepareDeclaration` for every precondition and `decideEffectiveDatedWrite`
   * for the effective-dating decision — the same two the write asks — so a
   * preview reporting WOULD_SUPERSEDE cannot be followed by a write that
   * refuses. The one case where they legitimately differ is a declaration that
   * lands between the two calls, which is why the database's EXCLUDE constraint
   * is the decision and this is advice.
   */
  async previewAuthorityDeclaration(
    organizationId: string,
    input: DeclareAuthorityInput,
  ): Promise<AuthorityDeclarationPreview> {
    const prepared = await this.prepareDeclaration(organizationId, input);
    if (!prepared.ok) {
      return {
        outcome: 'BLOCKED',
        effectiveNow: null,
        supersedes: null,
        reason: prepared.reason,
        problems: prepared.problems,
      };
    }
    const { candidate, source, sourceKey } = prepared;

    const rows = await this.loadRows(
      organizationId,
      candidate.dimension,
      candidate.memberExternalId,
      candidate.metric,
    );
    const keys = await this.sourceKeysById(organizationId);
    const view = (row: MeasureSourceAuthority): AuthorityDeclarationView | null => {
      const key = keys.get(row.measurementSourceId);
      if (!key) return null;
      const declaration = toAuthorityDeclaration(row, key);
      return declaration ? toAuthorityView(row, declaration) : null;
    };

    const decision = decideEffectiveDatedWrite(
      rows,
      candidate,
      (row) => ({
        effectiveFrom: columnToBusinessDate(row.effectiveFrom),
        effectiveTo: row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo),
      }),
      (row) => row.measurementSourceId === source.id,
    );

    // What is in force ON the requested start date, whatever the decision was.
    // An operator deciding whether to write needs to see what the record already
    // says, not only what would change.
    const inForce =
      rows.find((row) => {
        const from = columnToBusinessDate(row.effectiveFrom);
        const to = row.effectiveTo === null ? null : columnToBusinessDate(row.effectiveTo);
        return candidate.effectiveFrom >= from && (to === null || candidate.effectiveFrom < to);
      }) ?? null;

    if (decision.kind === 'BLOCKED') {
      return {
        outcome: 'BLOCKED',
        effectiveNow: inForce ? view(inForce) : null,
        supersedes: null,
        reason: 'OVERLAPS_EXISTING',
        problems: decision.problems.map((p) => `${p} for this member and measure`),
      };
    }
    if (decision.kind === 'EQUIVALENT') {
      return {
        outcome: 'ALREADY_EQUIVALENT',
        effectiveNow: view(decision.row),
        supersedes: null,
        reason: null,
        problems: [],
        sourceKey,
      };
    }
    return {
      outcome: decision.predecessor ? 'WOULD_SUPERSEDE' : 'WOULD_CREATE',
      effectiveNow: inForce ? view(inForce) : null,
      supersedes: decision.predecessor ? view(decision.predecessor) : null,
      reason: null,
      problems: [],
      sourceKey,
    };
  }

  async declareAuthority(
    organizationId: string,
    input: DeclareAuthorityInput,
  ): Promise<DeclareAuthorityResult> {
    const prepared = await this.prepareDeclaration(organizationId, input);
    if (!prepared.ok) return prepared;
    const { candidate, source, sourceKey, memberExternalId, reason } = prepared;

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
