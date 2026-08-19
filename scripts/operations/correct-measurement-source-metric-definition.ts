// Correct a measurement source metric definition — an OPERATIONS BRIDGE.
//
// WHAT IT IS
//
// The smallest thing that can fix a definition id typed wrongly during the first
// registration of a source. It changes ONE column on ONE metric row and nothing
// else, ever.
//
// WHY IT HAD TO EXIST
//
// Registration refuses a differing definition id rather than overwriting one,
// because overwriting silently redefines what a stored measurement measured.
// That refusal is right. Its consequence is that a definition id mistyped on the
// FIRST registration is unfixable through the registration path forever. This is
// the narrow, guarded exception — a CORRECTION, never a second way to register.
//
// THE SAFETY CONDITION, AND WHY IT IS NOT THE DATABASE'S
//
// Nothing in the database references a metric ROW. `MeasureSourceAuthority` names
// the SOURCE through a composite foreign key and carries `metric` as a plain
// string column, and `measureDefinitionId` is stored in exactly one place and
// copied nowhere. So Postgres would accept this update at any moment, under any
// circumstances, and report nothing wrong. The danger is entirely semantic — and
// a semantic danger the database cannot see is one the repository must refuse
// itself.
//
// CORRECTION IS THEREFORE SAFE ONLY WHILE NO AUTHORITY NAMES THAT SOURCE FOR
// THAT MEASURE. Before an authority exists, no measurement can have been computed
// from the source at all — the readiness gate resolves MISSING and withholds — so
// no published number depends on the old string. Once one exists, changing the
// definition would retroactively redefine a published number and silently start
// or stop two sources agreeing, with nothing in either to show it happened.
//
// WHAT IT IS NOT
//
// It is not a second opinion about when a correction is allowed. Existence, the
// no-op case and the authority guard are all decided by one function inside the
// repository, and the write re-asks it inside its transaction. This file computes
// none of them.
//
// IT CANNOT CHANGE IDENTITY. There is no input for source kind, provider, stream
// or metric, and no code path that writes one. Those are resolved from the
// persisted source, never supplied.
//
// USAGE
//
//   npm run correct:source-metric-definition -- \
//     --organization <slug> --source-key <key> --metric CALL_VOLUME \
//     --measure-definition-id "..." --reason "..." [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import { MEASURE_METRICS, isMeasureMetric, type MeasureMetric } from '@emgloop/shared';
import type {
  CorrectDefinitionInput,
  CorrectDefinitionPreview,
  CorrectDefinitionResult,
} from '@emgloop/database';

// --- The seams this file is tested through ------------------------------------
//
// Narrow on purpose. The runner may preview a correction, perform one, and look
// an organization up. It has no registration method, no authority method, and no
// way to read or write anything else.

export interface DefinitionCorrector {
  previewMeasureDefinitionCorrection(
    organizationId: string,
    input: CorrectDefinitionInput,
  ): Promise<CorrectDefinitionPreview>;
  correctMeasureDefinition(
    organizationId: string,
    input: CorrectDefinitionInput,
  ): Promise<CorrectDefinitionResult>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface RunDeps {
  sources: DefinitionCorrector;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface RunRequest {
  organizationSlug: string;
  sourceKey: string;
  metric: string;
  measureDefinitionId: string;
  reason: string;
  dryRun: boolean;
}

export type RunOutcome =
  | 'CORRECTED'
  | 'WOULD_CORRECT'
  | 'ALREADY_EQUIVALENT'
  | 'BLOCKED_AUTHORITY_EXISTS'
  | 'SOURCE_NOT_FOUND'
  | 'METRIC_NOT_FOUND'
  | 'FAILED_PRECONDITION';

export interface RunResult {
  outcome: RunOutcome;
  dryRun: boolean;
  /** What the row said before this run. Null when it could not be read. */
  from: string | null;
  /** What it says after, or would say. */
  to: string | null;
  /** Authorities naming this source for this measure. Non-zero means blocked. */
  authorityCount: number;
  problems: readonly string[];
}

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

// --- Input validation ---------------------------------------------------------
//
// Judged with the SAME vocabulary the repository applies, so a value this file
// accepts cannot be one the repository then rejects. The point of validating here
// at all is to fail before a production connection is opened.

export interface ValidatedRequest {
  sourceKey: string;
  metric: MeasureMetric;
  measureDefinitionId: string;
  reason: string;
}

export function validateRequest(
  request: RunRequest,
): { ok: true; value: ValidatedRequest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const sourceKey = request.sourceKey.trim();
  const measureDefinitionId = request.measureDefinitionId.trim();
  const reason = request.reason.trim();

  if (sourceKey === '') {
    problems.push('--source-key is required; it must name a source this organization already registered');
  }
  if (!isMeasureMetric(request.metric)) {
    problems.push(`--metric must be one of ${MEASURE_METRICS.join(' | ')}`);
  }
  if (measureDefinitionId === '') {
    // Blanking a definition would leave the metric supported and unusable, which
    // `sourceSupports` treats as not supported at all — a silent withdrawal
    // wearing a correction's clothes. The database CHECK refuses it too.
    problems.push('--measure-definition-id is required and cannot be blank');
  }
  if (reason === '') {
    problems.push('--reason is required; it is the only record of why this was changed');
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      sourceKey,
      metric: request.metric as MeasureMetric,
      measureDefinitionId,
      reason,
    },
  };
}

// --- The run ------------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * Correct one definition id, or say what correcting it would do.
 *
 * THE DRY RUN AND THE WRITE ASK THE SAME QUESTION.
 * `previewMeasureDefinitionCorrection` and `correctMeasureDefinition` share one
 * decision function inside the repository, so a dry run reporting WOULD_CORRECT
 * cannot be followed by a write that refuses for a reason the preview did not
 * mention. The one case they can legitimately differ on is an authority declared
 * between the two calls — and the write re-asks the guard INSIDE its transaction
 * precisely so that case is caught there rather than assumed away here.
 */
export async function runCorrection(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const refuse = (problems: string[]): RunResult => {
    for (const problem of problems) {
      deps.log(line({ event: 'PRECONDITION_FAILED', reason: problem }));
    }
    return {
      outcome: 'FAILED_PRECONDITION',
      dryRun: request.dryRun,
      from: null,
      to: null,
      authorityCount: 0,
      problems,
    };
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

  // EXACTLY THE FOUR THINGS A CORRECTION NEEDS. There is no field here for kind,
  // provider or stream: identity is resolved from the persisted source and can
  // never be supplied, so this runner has no way to change what the source IS.
  const input: CorrectDefinitionInput = {
    sourceKey: validated.value.sourceKey,
    metric: validated.value.metric,
    measureDefinitionId: validated.value.measureDefinitionId,
    reason: validated.value.reason,
  };

  deps.log(
    line({
      event: 'CORRECTION_START',
      organization: organization.slug,
      sourceKey: input.sourceKey,
      metric: input.metric,
      requestedDefinitionId: input.measureDefinitionId,
      dryRun: request.dryRun,
    }),
  );

  // THE PRE-WRITE CHECK RUNS ON EVERY RUN, not only on a dry one. An operator who
  // skipped the dry run still gets the old value printed beside the new one, so
  // the log explains itself without a second dispatch — and BOTH ids appear in
  // the record, which is the whole provenance this correction has.
  const preview = await deps.sources.previewMeasureDefinitionCorrection(organization.id, input);
  deps.log(
    line({
      event: 'PRE_WRITE_CHECK',
      sourceKey: input.sourceKey,
      metric: input.metric,
      wouldBe: preview.outcome,
      currentDefinitionId: preview.currentDefinitionId,
      requestedDefinitionId: preview.requestedDefinitionId,
      authorityCount: preview.authorityCount,
    }),
  );
  for (const problem of preview.problems) {
    deps.log(line({ event: 'PRE_WRITE_PROBLEM', detail: problem }));
  }

  if (preview.outcome !== 'WOULD_CORRECT') {
    // ALREADY_EQUIVALENT is not an error and is reported as itself; the others
    // are refusals. None of them writes.
    const outcome = preview.outcome === 'INVALID_REQUEST' ? 'FAILED_PRECONDITION' : preview.outcome;
    deps.log(line({ event: 'CORRECTION_NOT_APPLIED', written: false, reason: preview.outcome }));
    return {
      outcome,
      dryRun: request.dryRun,
      from: preview.currentDefinitionId,
      to: null,
      authorityCount: preview.authorityCount,
      problems: preview.problems,
    };
  }

  if (request.dryRun) {
    // NOTHING IS WRITTEN, and `correctMeasureDefinition` is not called at all --
    // it mutates, and a dry run that invoked it would be a write with a comment
    // on it.
    deps.log(
      line({
        event: 'DRY_RUN_COMPLETE',
        written: false,
        wouldBe: 'WOULD_CORRECT',
        from: preview.currentDefinitionId,
        to: preview.requestedDefinitionId,
      }),
    );
    return {
      outcome: 'WOULD_CORRECT',
      dryRun: true,
      from: preview.currentDefinitionId,
      to: preview.requestedDefinitionId,
      authorityCount: preview.authorityCount,
      problems: [],
    };
  }

  const result = await deps.sources.correctMeasureDefinition(organization.id, input);
  if (!result.ok) {
    // Reachable when an authority was declared between the preview and the
    // write. The preview is advice; the guard inside the transaction is the
    // decision, and this is what it looks like when it fires.
    deps.log(line({ event: 'CORRECTION_BLOCKED', written: false, reason: result.reason }));
    for (const problem of result.problems) {
      deps.log(line({ event: 'CORRECTION_PROBLEM', detail: problem }));
    }
    return {
      outcome: result.reason === 'INVALID_REQUEST' ? 'FAILED_PRECONDITION' : result.reason,
      dryRun: false,
      from: result.currentDefinitionId,
      to: null,
      authorityCount: result.authorityCount,
      problems: result.problems,
    };
  }

  // READ BACK WHAT WAS WRITTEN, from the repository rather than from the write's
  // own return value. A write that reported success and a table that does not
  // agree is exactly the case worth catching, and it costs one read.
  const after = await deps.sources.previewMeasureDefinitionCorrection(organization.id, input);
  const confirmed = after.currentDefinitionId === result.to;
  deps.log(
    line({
      event: 'CORRECTION_RESULT',
      organization: organization.slug,
      sourceKey: result.sourceKey,
      metric: result.metric,
      from: result.from,
      to: result.to,
      result: 'CORRECTED',
      written: true,
      authorityCount: 0,
      readBack: confirmed ? 'CONFIRMED' : 'MISMATCH',
      readBackDefinitionId: after.currentDefinitionId,
    }),
  );
  if (!confirmed) {
    return {
      outcome: 'FAILED_PRECONDITION',
      dryRun: false,
      from: result.from,
      to: result.to,
      authorityCount: 0,
      problems: ['the correction was reported written but the row does not agree'],
    };
  }

  return {
    outcome: 'CORRECTED',
    dryRun: false,
    from: result.from,
    to: result.to,
    authorityCount: 0,
    problems: [],
  };
}

// --- Input plumbing -----------------------------------------------------------

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // NO PROVIDER CREDENTIAL. A correction is an operator statement about a record
  // and never reads traffic.
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
    sourceKey: pick('--source-key', '--source'),
    metric: pick('--metric'),
    measureDefinitionId: pick('--measure-definition-id', '--definition-id'),
    reason: pick('--reason'),
    dryRun,
  };
}

// --- Wiring -------------------------------------------------------------------
//
// Everything above is pure orchestration over two injected seams, which is what
// the tests drive. Below is the only place real dependencies are constructed,
// and it does nothing but construct them.

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
    const result = await runCorrection(request, {
      sources: repositories.measurementSources,
      organizations: repositories.organizations,
      log,
    });
    // ALREADY_EQUIVALENT is a green run: the record already says what was asked
    // for, and nothing needed doing.
    return result.outcome === 'CORRECTED' ||
      result.outcome === 'WOULD_CORRECT' ||
      result.outcome === 'ALREADY_EQUIVALENT'
      ? 0
      : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing. The
// match is ANCHORED to the exact filename — a substring check lets the test file,
// whose name contains this one, run main() as an import side effect.
const ENTRY_POINT = /[\\/]correct-measurement-source-metric-definition\.ts$/;
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
