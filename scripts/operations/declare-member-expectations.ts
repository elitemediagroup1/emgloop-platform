// Declare member expectations — an OPERATIONS BRIDGE, not product architecture.
//
// WHAT IT IS
//
// The smallest thing that can invoke `ProviderMemberExpectationRepository`
// against production. That method shipped in PR 2 as an additive step with
// nothing reading it yet — the right sequencing — and the consequence was that
// the expectation table could not be written to at all: no route, no action, no
// page, no script and no workflow reached it. This is the bridge, and it is
// deletable the day a real operator surface ships.
//
// WHAT IT IS NOT
//
// It is not a second opinion about what a declaration means. Every decision that
// matters lives inside the repository and stays there: the closed vocabularies,
// the EXCLUDED-needs-a-reason pairing, the half-open effective range, overlap
// refusal, supersession, idempotency on an identical statement, and the write
// itself. This file computes none of them and must never begin to.
//
// A DECLARATION IS A HUMAN STATEMENT, SO ONE PER DISPATCH. There is deliberately
// no batch mode. Four campaigns is four runs, each with its own dispatcher, its
// own reason and its own line in the audit trail — which is what makes the run
// record worth having. A batch would collapse four statements into one act.
//
// IT NEVER READS TRAFFIC, AND CANNOT. Expectation is declared, never inferred: a
// campaign that BROKE must not un-expect itself the moment it stops delivering.
// This runner therefore takes no provider credential, contacts no provider, and
// there is a test asserting it names no adapter, no ingestion, no recovery, no
// reconciliation and no certification machinery.
//
// USAGE
//
//   npm run declare:member-expectations -- \
//     --organization <slug> --campaign <id> --state NOT_CONFIGURED \
//     --basis PROVIDER_CONFIG_VERIFIED --reason "..." \
//     --effective-from 2026-08-05 [--effective-to 2026-09-01] \
//     [--declarer-email someone@example.com] [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import {
  MEMBER_EXCLUSION_REASONS,
  MEMBER_EXPECTATION_BASES,
  MEMBER_EXPECTATION_STATES,
  isBusinessDate,
  isMemberExclusionReason,
  isMemberExpectationBasis,
  isMemberExpectationState,
  type BusinessDate,
  type MemberExclusionReason,
  type MemberExpectationBasis,
  type MemberExpectationState,
} from '@emgloop/shared';
import type { DeclarationPreview, DeclareResult, ExpectationDeclarationView } from '@emgloop/database';

// --- Fixed scope --------------------------------------------------------------
//
// NOT WORKFLOW INPUTS, DELIBERATELY. This bridge exists for one operation: the
// Stage 3 CallGrid campaign expectation. Exposing provider, stream and dimension
// as inputs would let an operator declare against a stream nobody has reconciled
// or a dimension the contract does not support — `EXPECTATION_DIMENSIONS` is
// CAMPAIGN only in v1 — and the repository would refuse it after the run had
// already been dispatched at production. A constant refuses it before.

export const PROVIDER = 'callgrid';
export const STREAM = 'calls';
export const DIMENSION = 'CAMPAIGN' as const;

// --- The seams this file is tested through ------------------------------------
//
// Narrow on purpose. The runner is handed the ability to preview a declaration,
// to record one, to read one back, to look an organization up and to list an
// organization's members — and can do nothing else.

/** The declaration capabilities. Preview reads; declare is the only write. */
export interface DeclarationWriter {
  previewDeclaration(organizationId: string, input: DeclareInput): Promise<DeclarationPreview>;
  declare(organizationId: string, input: DeclareInput): Promise<DeclareResult>;
  declarationsFor(
    organizationId: string,
    provider: string,
    stream: string,
    dimension: typeof DIMENSION,
    memberExternalId: string,
  ): Promise<ExpectationDeclarationView[]>;
}

/** Exactly the input the repository takes. Re-declared so this file's seam is explicit. */
export interface DeclareInput {
  provider: string;
  stream: string;
  dimension: typeof DIMENSION;
  memberExternalId: string;
  state: MemberExpectationState;
  exclusionReason: MemberExclusionReason | null;
  basis: MemberExpectationBasis;
  reason: string;
  effectiveFrom: BusinessDate;
  effectiveTo: BusinessDate | null;
  declaredByUserId: string | null;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

/** Read-only, ORGANIZATION-SCOPED member roster. The only way a declarer resolves. */
export interface MemberDirectory {
  listUsers(organizationId: string): Promise<Array<{ id: string; email: string; status: string }>>;
}

export interface RunDeps {
  expectations: DeclarationWriter;
  organizations: OrganizationLookup;
  directory: MemberDirectory;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface RunRequest {
  organizationSlug: string;
  memberExternalId: string;
  state: string;
  exclusionReason: string | null;
  basis: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Optional. Blank means the row records no human actor, which is legitimate. */
  declarerEmail: string | null;
  dryRun: boolean;
}

export type RunOutcome =
  | 'CREATED'
  | 'ALREADY_EQUIVALENT'
  | 'WOULD_CREATE'
  | 'WOULD_BE_ALREADY_EQUIVALENT'
  | 'BLOCKED'
  | 'FAILED_PRECONDITION';

export interface RunResult {
  outcome: RunOutcome;
  dryRun: boolean;
  /** Set on any outcome that wrote or would write. */
  expectationId: string | null;
  /** Whether a human actor was recorded, without naming them again in the result. */
  declarerResolved: boolean;
  problems: readonly string[];
}

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

// --- Input validation ---------------------------------------------------------
//
// Judged with the SAME predicates the repository applies, so a value this file
// accepts cannot be one the repository then rejects, and vice versa. The point
// of validating here at all is to fail before a production connection is opened
// rather than after.

export interface ValidatedRequest {
  memberExternalId: string;
  state: MemberExpectationState;
  exclusionReason: MemberExclusionReason | null;
  basis: MemberExpectationBasis;
  reason: string;
  effectiveFrom: BusinessDate;
  effectiveTo: BusinessDate | null;
}

export function validateRequest(
  request: RunRequest,
): { ok: true; value: ValidatedRequest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const memberExternalId = request.memberExternalId.trim();
  const reason = request.reason.trim();
  const exclusionRaw = request.exclusionReason?.trim() || null;
  const effectiveToRaw = request.effectiveTo?.trim() || null;

  if (memberExternalId === '') {
    problems.push('--campaign <id> is required; a declaration keyed on a label is not identity');
  }
  if (reason === '') {
    problems.push('--reason is required; an unexplained declaration is a place to hide');
  }
  if (!isMemberExpectationState(request.state)) {
    problems.push(`state must be one of ${MEMBER_EXPECTATION_STATES.join(' | ')}`);
  }
  if (!isMemberExpectationBasis(request.basis)) {
    problems.push(`basis must be one of ${MEMBER_EXPECTATION_BASES.join(' | ')}`);
  }
  if (!isBusinessDate(request.effectiveFrom)) {
    problems.push(`--effective-from must be YYYY-MM-DD, not ${String(request.effectiveFrom)}`);
  }
  if (effectiveToRaw !== null && !isBusinessDate(effectiveToRaw)) {
    problems.push(`--effective-to must be YYYY-MM-DD when supplied, not ${effectiveToRaw}`);
  }
  // The half-open convention: `effectiveTo` is EXCLUSIVE, so equal bounds
  // describe no date at all. The database refuses it too; this refuses it before
  // a production connection is opened.
  if (
    isBusinessDate(request.effectiveFrom) &&
    effectiveToRaw !== null &&
    isBusinessDate(effectiveToRaw) &&
    effectiveToRaw <= request.effectiveFrom
  ) {
    problems.push('--effective-to is exclusive and must be strictly after --effective-from');
  }
  // EXCLUDED requires a named reason and the others forbid one. NOT_CONFIGURED
  // is NOT a quiet synonym for EXCLUDED: one says the records could not arrive,
  // the other says they were deliberately left out of the measurement.
  if (request.state === 'EXCLUDED') {
    if (exclusionRaw === null) {
      problems.push(`EXCLUDED requires --exclusion-reason (${MEMBER_EXCLUSION_REASONS.join(' | ')})`);
    } else if (!isMemberExclusionReason(exclusionRaw)) {
      problems.push(`--exclusion-reason must be one of ${MEMBER_EXCLUSION_REASONS.join(' | ')}`);
    }
  } else if (exclusionRaw !== null) {
    problems.push(`--exclusion-reason is only meaningful on EXCLUDED, not ${request.state}`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      memberExternalId,
      state: request.state as MemberExpectationState,
      exclusionReason: exclusionRaw as MemberExclusionReason | null,
      basis: request.basis as MemberExpectationBasis,
      reason,
      effectiveFrom: request.effectiveFrom as BusinessDate,
      effectiveTo: effectiveToRaw as BusinessDate | null,
    },
  };
}

// --- Declarer resolution ------------------------------------------------------

export type DeclarerResolution =
  | { ok: true; userId: string | null }
  | { ok: false; problem: string };

/**
 * Resolve who is making this declaration, WITHIN the organization.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. An email that matches nobody, or more than
 * one member, resolves to a refusal rather than to null: silently recording
 * "nobody said this" when a person believed they were signing it would put a
 * weaker provenance on the row than the operator intended, and that weakness
 * would be invisible afterwards.
 *
 * NO USER ID IS EVER ACCEPTED FROM OUTSIDE. The runner takes an email and looks
 * it up through the organization-scoped roster; there is no input that could
 * carry an id belonging to another tenant, because there is no input that
 * carries an id at all.
 *
 * A BLANK EMAIL IS LEGITIMATE and resolves to null, which the repository
 * documents as the honest value when no human actor is resolvable -- never a
 * stand-in. The GitHub run record still names who dispatched it.
 */
export async function resolveDeclarer(
  directory: MemberDirectory,
  organizationId: string,
  email: string | null,
): Promise<DeclarerResolution> {
  const wanted = email?.trim().toLowerCase() ?? '';
  if (wanted === '') return { ok: true, userId: null };

  const members = await directory.listUsers(organizationId);
  const matches = members.filter((m) => m.email.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    // The address is not echoed: it was supplied by the operator, and a run log
    // is a durable artefact. Naming the count is enough to act on.
    return { ok: false, problem: 'the declarer email matches no active member of this organization' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      problem: `the declarer email matches ${matches.length} members of this organization; nothing was written`,
    };
  }
  return { ok: true, userId: matches[0]!.id };
}

// --- The run ------------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function describe(view: ExpectationDeclarationView): Record<string, string | null> {
  return {
    expectationId: view.id,
    state: view.state,
    effectiveFrom: view.effectiveFrom,
    effectiveTo: view.effectiveTo,
    basis: view.basis,
    exclusionReason: view.exclusionReason,
    declaredBy: view.declaredByUserId === null ? 'none recorded' : 'recorded',
  };
}

/**
 * Declare one member expectation, or say what declaring it would do.
 *
 * THE DRY RUN AND THE WRITE ASK THE SAME QUESTION. `previewDeclaration` and
 * `declare` share one decision function inside the repository, so a dry run
 * reporting WOULD_CREATE cannot be followed by a write that refuses. Working the
 * outcome out separately here would be the parallel system CLAUDE.md names
 * first, and it would diverge precisely where somebody is deciding whether to
 * touch production.
 */
export async function runDeclaration(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const refuse = (problems: string[]): RunResult => {
    for (const problem of problems) {
      deps.log(line({ event: 'PRECONDITION_FAILED', reason: problem }));
    }
    return { outcome: 'FAILED_PRECONDITION', dryRun: request.dryRun, expectationId: null, declarerResolved: false, problems };
  };

  const validated = validateRequest(request);
  if (!validated.ok) return refuse(validated.problems);

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    // NOT-FOUND, not forbidden, and never provisioned.
    return refuse([`No organization with slug "${request.organizationSlug}".`]);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse([`Organization "${organization.slug}" is ${organization.status}.`]);
  }

  const declarer = await resolveDeclarer(deps.directory, organization.id, request.declarerEmail);
  if (!declarer.ok) return refuse([declarer.problem]);

  const input: DeclareInput = {
    provider: PROVIDER,
    stream: STREAM,
    dimension: DIMENSION,
    memberExternalId: validated.value.memberExternalId,
    state: validated.value.state,
    exclusionReason: validated.value.exclusionReason,
    basis: validated.value.basis,
    reason: validated.value.reason,
    effectiveFrom: validated.value.effectiveFrom,
    effectiveTo: validated.value.effectiveTo,
    declaredByUserId: declarer.userId,
  };

  deps.log(
    line({
      event: 'DECLARATION_START',
      organization: organization.slug,
      provider: PROVIDER,
      stream: STREAM,
      dimension: DIMENSION,
      campaign: input.memberExternalId,
      state: input.state,
      basis: input.basis,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      declarer: declarer.userId === null ? 'none' : 'resolved',
      dryRun: request.dryRun,
    }),
  );

  // THE PRE-WRITE CHECK RUNS ON EVERY RUN, not only on a dry one. An operator
  // who skipped the dry run still gets the existing state printed beside what
  // happened, so the log explains itself without a second dispatch.
  const preview = await deps.expectations.previewDeclaration(organization.id, input);
  deps.log(
    line({
      event: 'PRE_WRITE_CHECK',
      campaign: input.memberExternalId,
      businessDate: input.effectiveFrom,
      wouldBe: preview.outcome,
      existing: preview.effectiveNow === null ? 'none' : preview.effectiveNow.state,
      existingFrom: preview.effectiveNow?.effectiveFrom ?? null,
      existingTo: preview.effectiveNow?.effectiveTo ?? null,
      existingId: preview.effectiveNow?.id ?? null,
      supersedes: preview.supersedes?.id ?? null,
      reason: preview.reason,
    }),
  );
  for (const problem of preview.problems) {
    deps.log(line({ event: 'PRE_WRITE_PROBLEM', detail: problem }));
  }

  if (preview.outcome === 'BLOCKED') {
    deps.log(line({ event: 'DECLARATION_BLOCKED', written: false, reason: preview.reason }));
    return {
      outcome: 'BLOCKED',
      dryRun: request.dryRun,
      expectationId: null,
      declarerResolved: declarer.userId !== null,
      problems: preview.problems,
    };
  }

  if (request.dryRun) {
    // NOTHING IS WRITTEN, and `declare` is not called at all -- it mutates, and a
    // dry run that invoked it would be a write with a comment on it.
    deps.log(
      line({
        event: 'DRY_RUN_COMPLETE',
        written: false,
        wouldBe: preview.outcome,
        expectationId: preview.effectiveNow?.id ?? null,
      }),
    );
    return {
      outcome: preview.outcome === 'ALREADY_EQUIVALENT' ? 'WOULD_BE_ALREADY_EQUIVALENT' : 'WOULD_CREATE',
      dryRun: true,
      expectationId: preview.effectiveNow?.id ?? null,
      declarerResolved: declarer.userId !== null,
      problems: [],
    };
  }

  const result = await deps.expectations.declare(organization.id, input);
  if (!result.ok) {
    // Reachable when a concurrent declaration landed between the preview and the
    // write. The preview is advice; the repository and its EXCLUDE constraint are
    // the decision.
    deps.log(line({ event: 'DECLARATION_BLOCKED', written: false, reason: result.reason }));
    for (const problem of result.problems) {
      deps.log(line({ event: 'DECLARATION_PROBLEM', detail: problem }));
    }
    return {
      outcome: 'BLOCKED',
      dryRun: false,
      expectationId: null,
      declarerResolved: declarer.userId !== null,
      problems: result.problems,
    };
  }

  // READ BACK WHAT WAS WRITTEN, from the repository rather than from the write's
  // own return value. A write that reported success and a table that does not
  // agree is exactly the case worth catching, and it costs one read.
  const history = await deps.expectations.declarationsFor(
    organization.id,
    PROVIDER,
    STREAM,
    DIMENSION,
    input.memberExternalId,
  );
  const stored = history.find((d) => d.id === result.declaration.id) ?? null;
  deps.log(
    line({
      event: 'DECLARATION_RESULT',
      organization: organization.slug,
      provider: PROVIDER,
      stream: STREAM,
      dimension: DIMENSION,
      campaign: input.memberExternalId,
      result: result.unchanged ? 'ALREADY_EQUIVALENT' : 'CREATED',
      written: !result.unchanged,
      supersededId: result.supersededId,
      readBack: stored === null ? 'MISSING' : 'CONFIRMED',
      ...(stored ? describe(stored) : {}),
    }),
  );
  if (stored === null) {
    return {
      outcome: 'BLOCKED',
      dryRun: false,
      expectationId: null,
      declarerResolved: declarer.userId !== null,
      problems: ['the declaration was reported written but could not be read back'],
    };
  }

  return {
    outcome: result.unchanged ? 'ALREADY_EQUIVALENT' : 'CREATED',
    dryRun: false,
    expectationId: stored.id,
    declarerResolved: declarer.userId !== null,
    problems: [],
  };
}

// --- Input plumbing -----------------------------------------------------------

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // NO PROVIDER CREDENTIAL. A declaration is a human statement and never reads
  // traffic, so this runner has no reason to hold one and deliberately does not.
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (!databaseUrl) return { ok: false, missing: ['DATABASE_URL'] };
  return { ok: true };
}

/** Minimal flag parsing. Deliberately not a CLI framework. */
export function parseArgs(argv: readonly string[]): RunRequest {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag.startsWith('--')) {
      flags.set(flag, (argv[i + 1] ?? '').trim());
      i += 1;
    }
  }
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = flags.get(n);
      if (v !== undefined && v !== '') return v;
    }
    return '';
  };
  return {
    organizationSlug: pick('--organization', '--org'),
    memberExternalId: pick('--campaign', '--campaign-id', '--member'),
    state: pick('--state'),
    exclusionReason: pick('--exclusion-reason') || null,
    basis: pick('--basis'),
    reason: pick('--reason'),
    effectiveFrom: pick('--effective-from'),
    effectiveTo: pick('--effective-to') || null,
    declarerEmail: pick('--declarer-email') || null,
    dryRun,
  };
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over three injected seams, which is
// what the tests drive. Below is the only place real dependencies are
// constructed, and it does nothing but construct them.

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const request = parseArgs(process.argv.slice(2));

  if (!request.organizationSlug) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the pure orchestration above
  // can be tested without a database client existing.
  const { prisma, repositories } = await import('@emgloop/database');

  try {
    const result = await runDeclaration(request, {
      expectations: repositories.memberExpectations,
      organizations: repositories.organizations,
      directory: repositories.iam,
      log,
    });
    return result.outcome === 'BLOCKED' || result.outcome === 'FAILED_PRECONDITION' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test file,
// whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]declare-member-expectations\.ts$/;
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
