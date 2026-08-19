// Stage 3 production bootstrap — a ONE-TIME OPERATIONS BRIDGE, not product architecture.
//
// WHAT IT IS
//
// A way to apply an EXPLICITLY WRITTEN configuration plan — several member
// expectations and several source authorities — in one human-dispatched run,
// for the initial production setup only. The per-declaration workflows
// (`Declare Member Expectations`, `Declare Measure Source Authority`) proved
// each mechanism one row at a time and remain the long-term correction and
// maintenance tools. This exists so the first configuration of a tenant is not
// two dozen hand-filled GitHub forms, each an opportunity to mistype a campaign
// id.
//
// WHY MULTI-MEMBER IS ALLOWED HERE AND NOWHERE ELSE
//
// The single-declaration runners refuse batch mode because a declaration is a
// human statement and a batch would collapse several statements into one act.
// That objection is about INFERENCE, not about arity. Here every statement is
// separately and explicitly present in the plan the human wrote and dispatched:
// nothing is derived from traffic, nothing is derived from a sibling entry,
// every entry gets its own preview line, its own result line and its own index
// in the run record, and processing is sequential. The plan IS the set of human
// statements; this file only carries them to the repositories that decide them.
//
// THE RUNNER CLASSIFIES NOTHING. It never decides whether a campaign is
// EXPECTED, NOT_CONFIGURED or EXCLUDED, which source is authoritative, which
// measure a source owns, or which date anything takes effect from. It reads no
// calls, no revenue, no webhook configuration, no reconciliation verdict and no
// import. It holds no provider credential and cannot acquire one. A value that
// is not in the plan does not exist to this file.
//
// IT DECIDES NOTHING THE REPOSITORIES ALREADY DECIDE. The vocabularies, the
// EXCLUDED-needs-a-reason pairing, the half-open effective range, whether a
// source is registered, whether that source declares a definition for the
// measure, overlap refusal, supersession and idempotency all live in
// `@emgloop/shared` and the two repositories. The per-entry validation below is
// literally the two shipped runners' own `validateRequest` functions, imported
// rather than re-typed, so a value this file accepts cannot be one the
// repository then rejects. The only reasoning that is NEW here is about the
// plan as a whole — see `planConflicts`.
//
// FULL-PLAN PREFLIGHT, THEN SEQUENTIAL GUARDED WRITES. Every entry is previewed
// before any entry is written, and one blocked preview stops the entire run with
// zero writes. That prevents the predictable half-bootstrap where entry 8 is
// malformed and entries 1-7 are already live. It is NOT a transaction: see
// §CONCURRENCY below.
//
// USAGE
//
//   npm run bootstrap:stage3 -- --plan-file plan.json [--declarer-email a@b.c] [--dry-run]
//   npm run bootstrap:stage3 -- --plan-json '{"organizationSlug":"...", ...}' --dry-run
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import type { BusinessDate } from '@emgloop/shared';
import type { DeclarationPreview, DeclareResult } from '@emgloop/database';
import type {
  AuthorityDeclarationPreview,
  DeclareAuthorityInput,
  DeclareAuthorityResult,
} from '@emgloop/database';

// THE SHIPPED BRIDGES ARE THE SOURCE OF TRUTH FOR A SINGLE DECLARATION.
// Importing their validation, their declarer resolution, their refused
// organization statuses and their fixed provider/stream/dimension scope is the
// whole point: a second copy of any of them would be the parallel system that
// eventually disagrees with the one an operator already trusts. Importing these
// modules starts nothing — each guards its own `main()` on an anchored match
// against its own filename.
import {
  DIMENSION as EXPECTATION_DIMENSION,
  PROVIDER,
  REFUSED_ORGANIZATION_STATUSES,
  STREAM,
  resolveDeclarer,
  validateRequest as validateExpectationRequest,
  type DeclarationWriter,
  type DeclareInput,
  type MemberDirectory,
  type OrganizationLookup,
} from './declare-member-expectations';
import {
  validateRequest as validateAuthorityRequest,
  type AuthorityWriter,
} from './declare-measure-source-authority';

// --- The seams this file is tested through ------------------------------------
//
// Exactly the five capabilities §SAFETY BOUNDARY permits: organization and
// member reads, expectation preview/read/write, authority preview/read/write.
// There is no observation, reconciliation, certification, registration,
// correction, ingestion, measurement or provider seam, and no way to add one
// without changing this interface in a diff a reviewer reads.

export interface RunDeps {
  expectations: DeclarationWriter;
  authorities: AuthorityWriter;
  organizations: OrganizationLookup;
  directory: MemberDirectory;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface RunRequest {
  /** The plan, verbatim, as the human wrote it. Never assembled by this file. */
  planJson: string;
  /** Optional. Blank means the rows record no human actor, which is legitimate. */
  declarerEmail: string | null;
  dryRun: boolean;
}

// --- The plan -----------------------------------------------------------------

export interface PlanExpectation {
  campaignId: string;
  state: string;
  basis: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  exclusionReason: string | null;
}

export interface PlanAuthority {
  dimension: string;
  memberExternalId: string;
  metric: string;
  sourceKey: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface BootstrapPlan {
  organizationSlug: string;
  expectations: PlanExpectation[];
  authorities: PlanAuthority[];
}

const EXPECTATION_KEYS = [
  'campaignId',
  'state',
  'basis',
  'reason',
  'effectiveFrom',
  'effectiveTo',
  'exclusionReason',
] as const;

const AUTHORITY_KEYS = [
  'dimension',
  'memberExternalId',
  'metric',
  'sourceKey',
  'reason',
  'effectiveFrom',
  'effectiveTo',
] as const;

const PLAN_KEYS = ['organizationSlug', 'expectations', 'authorities'] as const;

/**
 * Read the plan, and refuse anything that is not exactly a plan.
 *
 * UNKNOWN KEYS ARE REFUSED, NOT IGNORED. A plan is hand-written under time
 * pressure at a production console; `"exclusion_reason"` instead of
 * `"exclusionReason"` would otherwise read as "no exclusion reason supplied" and
 * declare something the author did not mean. There is no field here whose
 * absence is safer than a refusal.
 *
 * NOTHING IS DEFAULTED EXCEPT AN EXPLICIT ABSENCE OF AN END DATE. `effectiveTo`
 * and `exclusionReason` may be omitted or null, which the repositories already
 * define as open-ended and none. Every other field must be present and a string.
 */
export function parsePlan(raw: string): { ok: true; plan: BootstrapPlan } | { ok: false; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown';
    return { ok: false, problems: [`the plan is not valid JSON: ${detail}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: ['the plan must be a JSON object'] };
  }

  const problems: string[] = [];
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PLAN_KEYS as readonly string[]).includes(key)) {
      problems.push(`the plan carries an unrecognised field "${key}"`);
    }
  }

  const slug = typeof record.organizationSlug === 'string' ? record.organizationSlug.trim() : '';
  if (slug === '') problems.push('organizationSlug is required');

  const readString = (value: unknown, label: string, optional: boolean): string | null => {
    if (value === undefined || value === null) {
      if (!optional) problems.push(`${label} is required`);
      return null;
    }
    if (typeof value !== 'string') {
      problems.push(`${label} must be a string`);
      return null;
    }
    return value;
  };

  const expectations: PlanExpectation[] = [];
  const authorities: PlanAuthority[] = [];

  const section = (value: unknown, label: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      problems.push(`${label} must be an array when present`);
      return [];
    }
    return value;
  };

  section(record.expectations, 'expectations').forEach((entry, i) => {
    const label = `EXPECTATION[${i + 1}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${label} must be a JSON object`);
      return;
    }
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!(EXPECTATION_KEYS as readonly string[]).includes(key)) {
        problems.push(`${label} carries an unrecognised field "${key}"`);
      }
    }
    expectations.push({
      campaignId: readString(row.campaignId, `${label}.campaignId`, false) ?? '',
      state: readString(row.state, `${label}.state`, false) ?? '',
      basis: readString(row.basis, `${label}.basis`, false) ?? '',
      reason: readString(row.reason, `${label}.reason`, false) ?? '',
      effectiveFrom: readString(row.effectiveFrom, `${label}.effectiveFrom`, false) ?? '',
      effectiveTo: readString(row.effectiveTo, `${label}.effectiveTo`, true),
      exclusionReason: readString(row.exclusionReason, `${label}.exclusionReason`, true),
    });
  });

  section(record.authorities, 'authorities').forEach((entry, i) => {
    const label = `AUTHORITY[${i + 1}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${label} must be a JSON object`);
      return;
    }
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!(AUTHORITY_KEYS as readonly string[]).includes(key)) {
        problems.push(`${label} carries an unrecognised field "${key}"`);
      }
    }
    authorities.push({
      dimension: readString(row.dimension, `${label}.dimension`, false) ?? '',
      memberExternalId: readString(row.memberExternalId, `${label}.memberExternalId`, false) ?? '',
      metric: readString(row.metric, `${label}.metric`, false) ?? '',
      sourceKey: readString(row.sourceKey, `${label}.sourceKey`, false) ?? '',
      reason: readString(row.reason, `${label}.reason`, false) ?? '',
      effectiveFrom: readString(row.effectiveFrom, `${label}.effectiveFrom`, false) ?? '',
      effectiveTo: readString(row.effectiveTo, `${label}.effectiveTo`, true),
    });
  });

  if (problems.length === 0 && expectations.length === 0 && authorities.length === 0) {
    // An empty plan is not a safe no-op: it is almost certainly a plan that was
    // pasted wrong, and reporting SUCCESS over it would be a lie about what the
    // dispatcher achieved.
    problems.push('the plan declares nothing: it carries neither an expectation nor an authority');
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, plan: { organizationSlug: slug, expectations, authorities } };
}

// --- Per-entry validation, borrowed whole from the single-declaration bridges ---

/** Problems with each entry, judged by the shipped runners' own validators. */
export function entryProblems(plan: BootstrapPlan): string[] {
  const problems: string[] = [];

  plan.expectations.forEach((entry, i) => {
    const validated = validateExpectationRequest({
      organizationSlug: plan.organizationSlug,
      memberExternalId: entry.campaignId,
      state: entry.state,
      exclusionReason: entry.exclusionReason,
      basis: entry.basis,
      reason: entry.reason,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      declarerEmail: null,
      dryRun: true,
    });
    if (!validated.ok) {
      for (const problem of validated.problems) problems.push(`EXPECTATION[${i + 1}]: ${problem}`);
    }
  });

  plan.authorities.forEach((entry, i) => {
    const validated = validateAuthorityRequest({
      organizationSlug: plan.organizationSlug,
      dimension: entry.dimension,
      memberExternalId: entry.memberExternalId,
      metric: entry.metric,
      sourceKey: entry.sourceKey,
      reason: entry.reason,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      declarerEmail: null,
      dryRun: true,
    });
    if (!validated.ok) {
      for (const problem of validated.problems) problems.push(`AUTHORITY[${i + 1}]: ${problem}`);
    }
  });

  return problems;
}

// --- The one thing this file reasons about that nothing else does --------------

interface Range {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Half-open [from, to). Two open-ended ranges always overlap. */
function rangesOverlap(a: Range, b: Range): boolean {
  const aEnd = a.effectiveTo;
  const bEnd = b.effectiveTo;
  return (bEnd === null || a.effectiveFrom < bEnd) && (aEnd === null || b.effectiveFrom < aEnd);
}

/**
 * Contradictions WITHIN the plan.
 *
 * WHY THIS IS NOT THE REPOSITORY'S JOB. Each preview is asked against the
 * database AS IT IS. It cannot see a sibling entry that has not been written
 * yet, so two entries about the same member would both preview cleanly and then
 * mean something the operator never previewed — a plan whose second entry
 * silently supersedes its first, reviewed as though neither did.
 *
 * SO TWO ENTRIES ABOUT THE SAME SUBJECT ARE REFUSED, WHATEVER THEIR DATES.
 * Identical ones are a paste error. Overlapping ones contradict each other
 * outright. Adjacent, non-overlapping ones are a legitimate declaration and its
 * successor — and are still refused here, because a preflight that cannot see
 * the first write cannot honestly report what the second one would do. Dispatch
 * the successor through `Declare Member Expectations` or `Declare Measure Source
 * Authority` afterwards, which is what those workflows are for.
 */
export function planConflicts(plan: BootstrapPlan): string[] {
  const problems: string[] = [];

  const compare = <T extends Range>(
    entries: readonly T[],
    label: string,
    keyOf: (entry: T) => string,
    identical: (a: T, b: T) => boolean,
    contradictionWord: string,
  ): void => {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (keyOf(a) !== keyOf(b)) continue;
        const pair = `${label}[${i + 1}] and ${label}[${j + 1}]`;
        if (identical(a, b)) {
          problems.push(`${pair} are the same declaration stated twice`);
        } else if (rangesOverlap(a, b)) {
          problems.push(`${pair} are ${contradictionWord} over the same effective range`);
        } else {
          problems.push(
            `${pair} speak about the same subject over different periods; ` +
              'a plan is previewed against the record as it stands and cannot see its own earlier write, ' +
              'so declare the successor through the single-declaration workflow instead',
          );
        }
      }
    }
  };

  compare(
    plan.expectations,
    'EXPECTATION',
    (e) => e.campaignId.trim(),
    (a, b) =>
      a.state === b.state &&
      a.basis === b.basis &&
      (a.exclusionReason ?? null) === (b.exclusionReason ?? null) &&
      a.reason.trim() === b.reason.trim() &&
      a.effectiveFrom === b.effectiveFrom &&
      a.effectiveTo === b.effectiveTo,
    'contradictory',
  );

  compare(
    plan.authorities,
    'AUTHORITY',
    (a) => `${a.dimension}|${a.memberExternalId.trim()}|${a.metric}`,
    (a, b) =>
      a.sourceKey.trim() === b.sourceKey.trim() &&
      a.reason.trim() === b.reason.trim() &&
      a.effectiveFrom === b.effectiveFrom &&
      a.effectiveTo === b.effectiveTo,
    'conflicting',
  );

  return problems;
}

// --- Outcomes -----------------------------------------------------------------

export type Disposition = 'CREATE' | 'SUPERSEDE' | 'EQUIVALENT' | 'BLOCKED';

export interface EntryReport {
  /** EXPECTATION[1], AUTHORITY[2]. Deterministic and stable across a re-run. */
  label: string;
  disposition: Disposition;
  wrote: boolean;
  readBack: 'CONFIRMED' | 'MISSING' | 'NOT_ATTEMPTED';
  id: string | null;
  supersededId: string | null;
}

export type OverallResult =
  | 'READY_TO_APPLY'
  | 'APPLIED'
  | 'PARTIALLY_APPLIED'
  | 'BLOCKED'
  | 'FAILED_PRECONDITION';

export interface RunResult {
  overall: OverallResult;
  dryRun: boolean;
  writtenCount: number;
  equivalentCount: number;
  supersededCount: number;
  /** The label of the entry that stopped the run, or null. */
  failedIndex: string | null;
  entries: readonly EntryReport[];
  problems: readonly string[];
}

// --- The run ------------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function expectationDisposition(preview: DeclarationPreview): Disposition {
  if (preview.outcome === 'BLOCKED') return 'BLOCKED';
  if (preview.outcome === 'ALREADY_EQUIVALENT') return 'EQUIVALENT';
  return preview.supersedes === null ? 'CREATE' : 'SUPERSEDE';
}

function authorityDisposition(preview: AuthorityDeclarationPreview): Disposition {
  if (preview.outcome === 'BLOCKED') return 'BLOCKED';
  if (preview.outcome === 'ALREADY_EQUIVALENT') return 'EQUIVALENT';
  return preview.outcome === 'WOULD_SUPERSEDE' ? 'SUPERSEDE' : 'CREATE';
}

interface PlannedExpectation {
  label: string;
  input: DeclareInput;
  preview: DeclarationPreview;
  disposition: Disposition;
}

interface PlannedAuthority {
  label: string;
  input: DeclareAuthorityInput;
  preview: AuthorityDeclarationPreview;
  disposition: Disposition;
}

function count(entries: readonly { disposition: Disposition }[], of: Disposition): number {
  return entries.filter((e) => e.disposition === of).length;
}

/**
 * Apply a written plan, or say what applying it would do.
 *
 * THE PREFLIGHT IS THE WHOLE RUN, TWICE. Every entry is previewed through the
 * repository that owns it before any entry is written, and the previews are the
 * same functions the writes use, so what is printed is what would happen. A
 * single BLOCKED preview ends the run with nothing written — which is the only
 * defensible answer, because a half-applied configuration is harder to reason
 * about than an unapplied one.
 */
export async function runBootstrap(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const refuse = (problems: readonly string[]): RunResult => {
    for (const problem of problems) {
      deps.log(line({ event: 'PRECONDITION_FAILED', reason: problem }));
    }
    deps.log(line({ event: 'RUN_COMPLETE', WRITTEN: false, OVERALL_RESULT: 'BLOCKED' }));
    return {
      overall: 'FAILED_PRECONDITION',
      dryRun: request.dryRun,
      writtenCount: 0,
      equivalentCount: 0,
      supersededCount: 0,
      failedIndex: null,
      entries: [],
      problems,
    };
  };

  const parsed = parsePlan(request.planJson);
  if (!parsed.ok) return refuse(parsed.problems);
  const plan = parsed.plan;

  // THE WHOLE PLAN IS JUDGED BEFORE ANYTHING IS RESOLVED. Entry 8 being
  // malformed must stop entry 1, and it costs nothing to find that out before a
  // production connection is used.
  const shapeProblems = [...entryProblems(plan), ...planConflicts(plan)];
  if (shapeProblems.length > 0) return refuse(shapeProblems);

  const organization = await deps.organizations.findBySlug(plan.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned.
    return refuse([`No organization with slug "${plan.organizationSlug}".`]);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse([`Organization "${organization.slug}" is ${organization.status}.`]);
  }

  // Resolved ONCE for the run, through the shipped bridge's own resolver: an
  // email that matches nobody or more than one member fails the whole run
  // closed, and no user id can be supplied from outside because no input carries
  // one. The address is never echoed.
  const declarer = await resolveDeclarer(deps.directory, organization.id, request.declarerEmail);
  if (!declarer.ok) return refuse([declarer.problem]);

  deps.log(
    line({
      event: 'BOOTSTRAP_START',
      organization: organization.slug,
      expectations: plan.expectations.length,
      authorities: plan.authorities.length,
      declarer: declarer.userId === null ? 'none' : 'resolved',
      dryRun: request.dryRun,
    }),
  );

  // --- Preflight: preview everything, write nothing ---------------------------

  const plannedExpectations: PlannedExpectation[] = [];
  for (const [i, entry] of plan.expectations.entries()) {
    const label = `EXPECTATION[${i + 1}]`;
    const input: DeclareInput = {
      provider: PROVIDER,
      stream: STREAM,
      dimension: EXPECTATION_DIMENSION,
      memberExternalId: entry.campaignId.trim(),
      state: entry.state as DeclareInput['state'],
      exclusionReason: (entry.exclusionReason?.trim() || null) as DeclareInput['exclusionReason'],
      basis: entry.basis as DeclareInput['basis'],
      reason: entry.reason.trim(),
      effectiveFrom: entry.effectiveFrom as BusinessDate,
      effectiveTo: (entry.effectiveTo?.trim() || null) as BusinessDate | null,
      declaredByUserId: declarer.userId,
    };
    const preview = await deps.expectations.previewDeclaration(organization.id, input);
    const disposition = expectationDisposition(preview);
    plannedExpectations.push({ label, input, preview, disposition });
    deps.log(
      line({
        entry: label,
        type: 'EXPECTATION',
        campaign: input.memberExternalId,
        state: input.state,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        wouldBe: disposition,
        existingId: preview.effectiveNow?.id ?? null,
        supersedes: preview.supersedes?.id ?? null,
        reason: preview.reason,
      }),
    );
    for (const problem of preview.problems) {
      deps.log(line({ entry: label, event: 'PREFLIGHT_PROBLEM', detail: problem }));
    }
  }

  const plannedAuthorities: PlannedAuthority[] = [];
  for (const [i, entry] of plan.authorities.entries()) {
    const label = `AUTHORITY[${i + 1}]`;
    const input: DeclareAuthorityInput = {
      dimension: entry.dimension as DeclareAuthorityInput['dimension'],
      memberExternalId: entry.memberExternalId.trim(),
      metric: entry.metric as DeclareAuthorityInput['metric'],
      sourceKey: entry.sourceKey.trim(),
      reason: entry.reason.trim(),
      effectiveFrom: entry.effectiveFrom as BusinessDate,
      effectiveTo: (entry.effectiveTo?.trim() || null) as BusinessDate | null,
      declaredByUserId: declarer.userId,
    };
    // The repository proves here — not this file — that the source is registered
    // to THIS organization and declares a definition for THIS measure. Both
    // refusals arrive as a BLOCKED preview with a named reason.
    const preview = await deps.authorities.previewAuthorityDeclaration(organization.id, input);
    const disposition = authorityDisposition(preview);
    plannedAuthorities.push({ label, input, preview, disposition });
    deps.log(
      line({
        entry: label,
        type: 'AUTHORITY',
        dimension: input.dimension,
        member: input.memberExternalId,
        metric: input.metric,
        sourceKey: input.sourceKey,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        wouldBe: disposition,
        existingId: preview.effectiveNow?.id ?? null,
        supersedes: preview.supersedes?.id ?? null,
        reason: preview.reason,
      }),
    );
    for (const problem of preview.problems) {
      deps.log(line({ entry: label, event: 'PREFLIGHT_PROBLEM', detail: problem }));
    }
  }

  const blocked = [...plannedExpectations, ...plannedAuthorities].filter((p) => p.disposition === 'BLOCKED');

  deps.log(
    line({
      event: 'PLAN_SUMMARY',
      EXPECTATIONS_REQUESTED: plannedExpectations.length,
      EXPECTATIONS_CREATE: count(plannedExpectations, 'CREATE'),
      EXPECTATIONS_EQUIVALENT: count(plannedExpectations, 'EQUIVALENT'),
      EXPECTATIONS_SUPERSEDE: count(plannedExpectations, 'SUPERSEDE'),
      EXPECTATIONS_BLOCKED: count(plannedExpectations, 'BLOCKED'),
      AUTHORITIES_REQUESTED: plannedAuthorities.length,
      AUTHORITIES_CREATE: count(plannedAuthorities, 'CREATE'),
      AUTHORITIES_EQUIVALENT: count(plannedAuthorities, 'EQUIVALENT'),
      AUTHORITIES_SUPERSEDE: count(plannedAuthorities, 'SUPERSEDE'),
      AUTHORITIES_BLOCKED: count(plannedAuthorities, 'BLOCKED'),
    }),
  );

  const previewReports = (): EntryReport[] =>
    [...plannedExpectations, ...plannedAuthorities].map((p) => ({
      label: p.label,
      disposition: p.disposition,
      wrote: false,
      readBack: 'NOT_ATTEMPTED' as const,
      id: p.preview.effectiveNow?.id ?? null,
      supersededId: p.preview.supersedes?.id ?? null,
    }));

  if (blocked.length > 0) {
    // ONE BLOCKED ENTRY STOPS EVERY ENTRY. Applying the clean ones would leave
    // production in a state nobody wrote down and nobody previewed.
    for (const b of blocked) {
      deps.log(line({ entry: b.label, event: 'ENTRY_BLOCKED', reason: b.preview.reason }));
    }
    deps.log(
      line({
        event: 'RUN_COMPLETE',
        WRITTEN: false,
        BLOCKED_ENTRIES: blocked.map((b) => b.label).join(','),
        OVERALL_RESULT: 'BLOCKED',
      }),
    );
    return {
      overall: 'BLOCKED',
      dryRun: request.dryRun,
      writtenCount: 0,
      equivalentCount: 0,
      supersededCount: 0,
      failedIndex: blocked[0]!.label,
      entries: previewReports(),
      problems: blocked.flatMap((b) => b.preview.problems),
    };
  }

  if (request.dryRun) {
    // NOTHING IS WRITTEN, and neither mutating method is called at all — a dry
    // run that invoked one would be a write with a comment on it.
    deps.log(line({ event: 'RUN_COMPLETE', WRITTEN: false, OVERALL_RESULT: 'READY_TO_APPLY' }));
    return {
      overall: 'READY_TO_APPLY',
      dryRun: true,
      writtenCount: 0,
      equivalentCount:
        count(plannedExpectations, 'EQUIVALENT') + count(plannedAuthorities, 'EQUIVALENT'),
      supersededCount: 0,
      failedIndex: null,
      entries: previewReports(),
      problems: [],
    };
  }

  // --- Sequential guarded writes ----------------------------------------------
  //
  // A CLEAN PREFLIGHT IS NOT PERMISSION TO SKIP A CHECK. Every entry, including
  // one previewed as EQUIVALENT, goes through the repository's own write method,
  // which re-asks the whole question inside its own transaction. That is what
  // makes a declaration landing between the preview and the write safe: the
  // database's EXCLUDE constraint decides, not the printout above.

  const reports: EntryReport[] = [];
  let written = 0;
  let equivalent = 0;
  let superseded = 0;

  const stop = (label: string, problems: readonly string[]): RunResult => {
    const remaining =
      plannedExpectations.length + plannedAuthorities.length - reports.length;
    for (const problem of problems) {
      deps.log(line({ entry: label, event: 'WRITE_PROBLEM', detail: problem }));
    }
    deps.log(
      line({
        event: 'RUN_COMPLETE',
        WRITTEN_COUNT: written,
        EQUIVALENT_COUNT: equivalent,
        SUPERSEDED_COUNT: superseded,
        FAILED_INDEX: label,
        NOT_ATTEMPTED: remaining,
        OVERALL_RESULT: 'PARTIALLY_APPLIED',
      }),
    );
    return {
      overall: 'PARTIALLY_APPLIED',
      dryRun: false,
      writtenCount: written,
      equivalentCount: equivalent,
      supersededCount: superseded,
      failedIndex: label,
      entries: reports,
      problems,
    };
  };

  for (const planned of plannedExpectations) {
    const result: DeclareResult = await deps.expectations.declare(organization.id, planned.input);
    if (!result.ok) {
      // Reachable only when a declaration landed between the preflight and here.
      reports.push({
        label: planned.label,
        disposition: 'BLOCKED',
        wrote: false,
        readBack: 'NOT_ATTEMPTED',
        id: null,
        supersededId: null,
      });
      return stop(planned.label, result.problems);
    }

    // READ BACK FROM THE REPOSITORY, not from the write's own return value. A
    // write that reported success over a table that does not agree is exactly
    // the case worth catching, and it costs one read.
    const history = await deps.expectations.declarationsFor(
      organization.id,
      PROVIDER,
      STREAM,
      EXPECTATION_DIMENSION,
      planned.input.memberExternalId,
    );
    const stored = history.find((d) => d.id === result.declaration.id) ?? null;
    if (result.unchanged) equivalent += 1;
    else written += 1;
    if (result.supersededId !== null) superseded += 1;

    deps.log(
      line({
        entry: planned.label,
        event: 'ENTRY_RESULT',
        type: 'EXPECTATION',
        campaign: planned.input.memberExternalId,
        result: result.unchanged ? 'ALREADY_EQUIVALENT' : 'CREATED',
        written: !result.unchanged,
        supersededId: result.supersededId,
        readBack: stored === null ? 'MISSING' : 'CONFIRMED',
        expectationId: stored?.id ?? null,
        effectiveFrom: stored?.effectiveFrom ?? null,
        effectiveTo: stored?.effectiveTo ?? null,
      }),
    );
    reports.push({
      label: planned.label,
      disposition: result.unchanged ? 'EQUIVALENT' : result.supersededId === null ? 'CREATE' : 'SUPERSEDE',
      wrote: !result.unchanged,
      readBack: stored === null ? 'MISSING' : 'CONFIRMED',
      id: stored?.id ?? null,
      supersededId: result.supersededId,
    });
    if (stored === null) {
      return stop(planned.label, ['the declaration was reported written but could not be read back']);
    }
  }

  for (const planned of plannedAuthorities) {
    const result: DeclareAuthorityResult = await deps.authorities.declareAuthority(
      organization.id,
      planned.input,
    );
    if (!result.ok) {
      reports.push({
        label: planned.label,
        disposition: 'BLOCKED',
        wrote: false,
        readBack: 'NOT_ATTEMPTED',
        id: null,
        supersededId: null,
      });
      return stop(planned.label, result.problems);
    }

    const history = await deps.authorities.authoritiesFor(
      organization.id,
      planned.input.dimension,
      planned.input.memberExternalId,
      planned.input.metric,
    );
    const stored = history.find((d) => d.id === result.declaration.id) ?? null;
    if (result.unchanged) equivalent += 1;
    else written += 1;
    if (result.supersededId !== null) superseded += 1;

    deps.log(
      line({
        entry: planned.label,
        event: 'ENTRY_RESULT',
        type: 'AUTHORITY',
        member: planned.input.memberExternalId,
        metric: planned.input.metric,
        result: result.unchanged ? 'ALREADY_EQUIVALENT' : 'CREATED',
        written: !result.unchanged,
        supersededId: result.supersededId,
        readBack: stored === null ? 'MISSING' : 'CONFIRMED',
        authorityId: stored?.id ?? null,
        sourceKey: stored?.sourceKey ?? null,
        effectiveFrom: stored?.effectiveFrom ?? null,
        effectiveTo: stored?.effectiveTo ?? null,
      }),
    );
    reports.push({
      label: planned.label,
      disposition: result.unchanged ? 'EQUIVALENT' : result.supersededId === null ? 'CREATE' : 'SUPERSEDE',
      wrote: !result.unchanged,
      readBack: stored === null ? 'MISSING' : 'CONFIRMED',
      id: stored?.id ?? null,
      supersededId: result.supersededId,
    });
    if (stored === null) {
      return stop(planned.label, ['the authority was reported written but could not be read back']);
    }
  }

  deps.log(
    line({
      event: 'RUN_COMPLETE',
      WRITTEN_COUNT: written,
      EQUIVALENT_COUNT: equivalent,
      SUPERSEDED_COUNT: superseded,
      FAILED_INDEX: null,
      OVERALL_RESULT: 'APPLIED',
    }),
  );
  return {
    overall: 'APPLIED',
    dryRun: false,
    writtenCount: written,
    equivalentCount: equivalent,
    supersededCount: superseded,
    failedIndex: null,
    entries: reports,
    problems: [],
  };
}

// --- Input plumbing -----------------------------------------------------------

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // NO PROVIDER CREDENTIAL. Configuration is declared and never read from
  // traffic, so this runner has no reason to hold one and deliberately does not.
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (!databaseUrl) return { ok: false, missing: ['DATABASE_URL'] };
  return { ok: true };
}

export interface ParsedArgs {
  planJson: string | null;
  planFile: string | null;
  declarerEmail: string | null;
  dryRun: boolean;
}

/**
 * Minimal flag parsing. Deliberately not a CLI framework.
 *
 * `dry_run` DEFAULTS TO TRUE IN THE WORKFLOW, and the flag here is the explicit
 * opt-in to a dry run. The workflow appends `--dry-run` unless a human set
 * `dry_run: false`, which is the same shape every other operations bridge uses.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag.startsWith('--')) {
      flags.set(flag, argv[i + 1] ?? '');
      i += 1;
    }
  }
  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const v = flags.get(n);
      if (v !== undefined && v.trim() !== '') return v;
    }
    return null;
  };
  return {
    planJson: pick('--plan-json'),
    planFile: pick('--plan-file'),
    declarerEmail: pick('--declarer-email'),
    dryRun,
  };
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over four injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed,
// and it does nothing but construct them.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));

  if (args.planJson === null && args.planFile === null) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--plan-json or --plan-file is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  let planJson: string;
  if (args.planFile !== null) {
    const { readFileSync } = await import('node:fs');
    try {
      planJson = readFileSync(args.planFile, 'utf8');
    } catch {
      // The path is not echoed: it was supplied by the operator.
      log(line({ event: 'PRECONDITION_FAILED', reason: 'the plan file could not be read' }));
      return 2;
    }
  } else {
    planJson = args.planJson!;
  }

  // Imported here rather than at module scope so the pure orchestration above
  // can be tested without a database client existing.
  const { prisma, repositories } = await import('@emgloop/database');

  try {
    const result = await runBootstrap(
      { planJson, declarerEmail: args.declarerEmail, dryRun: args.dryRun },
      {
        expectations: repositories.memberExpectations,
        authorities: repositories.measurementSources,
        organizations: repositories.organizations,
        directory: repositories.iam,
        log,
      },
    );
    return result.overall === 'APPLIED' || result.overall === 'READY_TO_APPLY' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test
// file, whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]bootstrap-stage3-production\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : 'unknown';
      process.stdout.write(line({ event: 'RUN_FAILED', reason: detail }) + '\n');
      process.exitCode = 1;
    },
  );
}
