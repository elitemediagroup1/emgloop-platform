// Register a measurement source — an OPERATIONS BRIDGE, not product architecture.
//
// WHAT IT IS
//
// The smallest thing that can invoke `MeasurementSourceRepository.registerSource`
// against production. PR 4 shipped source-authority persistence with zero
// callers — no route, no action, no page, no script and no workflow reached it —
// which is the correct sequencing and also meant the table could not be written
// to at all. This is half the bridge, and it is deletable the day a real
// operator surface ships.
//
// WHY IT IS A SEPARATE ACT FROM DECLARING AUTHORITY
//
// Registering a source says "this organization is willing to believe this thing,
// about these measures". Declaring authority says "for this campaign and this
// measure, believe it INSTEAD of anything else". They are different statements
// with different consequences, and a dispatch that silently created a source
// while declaring authority over it would collapse them into one act — so an
// authority declaration must name a source somebody already registered, and this
// runner never declares authority.
//
// WHAT IT IS NOT
//
// It is not a second opinion about what registration means. Identity conflict,
// definition conflict, the PROVIDER_STREAM pairing, the closed vocabularies and
// the write itself all live in the repository and stay there. This file computes
// none of them.
//
// ONE METRIC PER DISPATCH, DELIBERATELY. A measure definition id is an agreement
// between two parties, and each one deserves its own dispatcher, its own run
// record and its own chance to be refused. This is safe only because
// `registerSource` is ADDITIVE — it was changed in this batch from replacing a
// source's metric set to adding to it, precisely so that a one-metric dispatch
// cannot delete the metrics it did not mention.
//
// IT NEVER READS TRAFFIC, AND CANNOT. A source's existence is a commercial
// decision, not an observation: a provider having a field is exactly what must
// NOT make it believable. This runner takes no provider credential, contacts no
// provider, and a test asserts it names no adapter, no ingestion, no recovery,
// no reconciliation, no certification and no measurement machinery.
//
// USAGE
//
//   npm run register:measurement-source -- \
//     --organization <slug> --key <source-key> --display-name "..." \
//     --kind PROVIDER_STREAM --provider <p> --stream <s> \
//     --metric CALL_VOLUME --measure-definition-id "..." [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import {
  MEASUREMENT_SOURCE_KINDS,
  MEASURE_METRICS,
  isMeasureMetric,
  type MeasureMetric,
  type MeasurementSourceDefinition,
  type MeasurementSourceKind,
} from '@emgloop/shared';
import type {
  RegisterSourceInput,
  RegisterSourcePreview,
  RegisterSourceResult,
} from '@emgloop/database';

// --- The seams this file is tested through ------------------------------------
//
// Narrow on purpose. The runner is handed the ability to preview a registration,
// to record one and to read one back, plus a read-only organization lookup — and
// can do nothing else. There is no authority method here at all.

export interface SourceRegistrar {
  previewSourceRegistration(organizationId: string, input: RegisterSourceInput): Promise<RegisterSourcePreview>;
  registerSource(organizationId: string, input: RegisterSourceInput): Promise<RegisterSourceResult>;
  findSource(organizationId: string, key: string): Promise<MeasurementSourceDefinition | null>;
}

/** Read-only organization lookup. This runner may never provision one. */
export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; name: string; status: string } | null>;
}

export interface RunDeps {
  sources: SourceRegistrar;
  organizations: OrganizationLookup;
  /** Injected so tests can read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
}

export interface RunRequest {
  organizationSlug: string;
  key: string;
  displayName: string;
  kind: string;
  /** Required for PROVIDER_STREAM, and must be blank for every other kind. */
  provider: string | null;
  stream: string | null;
  metric: string;
  measureDefinitionId: string;
  dryRun: boolean;
}

export type RunOutcome =
  | 'CREATED'
  | 'ADDED_METRIC'
  | 'ALREADY_EQUIVALENT'
  | 'WOULD_CREATE_SOURCE_AND_METRIC'
  | 'WOULD_ADD_METRIC'
  | 'WOULD_BE_ALREADY_EQUIVALENT'
  | 'BLOCKED'
  | 'FAILED_PRECONDITION';

export interface RunResult {
  outcome: RunOutcome;
  dryRun: boolean;
  /** The source key operated on, echoed for the run record. Never an id from input. */
  sourceKey: string | null;
  problems: readonly string[];
}

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

// --- Input validation ---------------------------------------------------------
//
// Judged with the SAME predicates and vocabularies the repository applies, so a
// value this file accepts cannot be one the repository then rejects. The point
// of validating here at all is to fail before a production connection is opened.

export interface ValidatedRequest {
  key: string;
  displayName: string;
  kind: MeasurementSourceKind;
  provider: string | null;
  stream: string | null;
  metric: MeasureMetric;
  measureDefinitionId: string;
}

function isSourceKind(value: string): value is MeasurementSourceKind {
  return (MEASUREMENT_SOURCE_KINDS as readonly string[]).includes(value);
}

export function validateRequest(
  request: RunRequest,
): { ok: true; value: ValidatedRequest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const key = request.key.trim();
  const displayName = request.displayName.trim();
  const provider = request.provider?.trim() || null;
  const stream = request.stream?.trim() || null;
  const measureDefinitionId = request.measureDefinitionId.trim();

  if (key === '') {
    problems.push('--key is required; it is the handle an authority declaration names');
  }
  if (displayName === '') {
    problems.push('--display-name is required');
  }
  if (!isSourceKind(request.kind)) {
    problems.push(`--kind must be one of ${MEASUREMENT_SOURCE_KINDS.join(' | ')}`);
  }
  if (!isMeasureMetric(request.metric)) {
    problems.push(`--metric must be one of ${MEASURE_METRICS.join(' | ')}`);
  }
  if (measureDefinitionId === '') {
    problems.push(
      '--measure-definition-id is required; it names the definition two parties agreed on, and a supported metric without one is not usable',
    );
  }
  // THE PAIRING IS MIRRORED FROM THE DATABASE CHECK, so bad input fails before a
  // production connection is opened rather than as a constraint violation after.
  // The kind selects how availability is proven: a polled stream proves it by
  // having been observed, which requires naming the stream; a report that
  // arrives has no stream to observe.
  if (request.kind === 'PROVIDER_STREAM') {
    if (provider === null) problems.push('PROVIDER_STREAM requires --provider');
    if (stream === null) problems.push('PROVIDER_STREAM requires --stream');
  } else if (isSourceKind(request.kind)) {
    if (provider !== null) {
      problems.push(`--provider is only meaningful on PROVIDER_STREAM, not ${request.kind}`);
    }
    if (stream !== null) {
      problems.push(`--stream is only meaningful on PROVIDER_STREAM, not ${request.kind}`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      key,
      displayName,
      kind: request.kind as MeasurementSourceKind,
      provider: request.kind === 'PROVIDER_STREAM' ? provider : null,
      stream: request.kind === 'PROVIDER_STREAM' ? stream : null,
      metric: request.metric as MeasureMetric,
      measureDefinitionId,
    },
  };
}

// --- The run ------------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

function describe(source: MeasurementSourceDefinition): Record<string, string | null> {
  return {
    sourceKey: source.key,
    kind: source.kind,
    displayName: source.displayName,
    provider: source.provider,
    stream: source.stream,
    supportedMetrics: source.supportedMetrics.slice().sort().join(','),
  };
}

/**
 * Register one source and one measure definition, or say what doing so would do.
 *
 * THE DRY RUN AND THE WRITE ASK THE SAME QUESTION. `previewSourceRegistration`
 * and `registerSource` share one decision function inside the repository, so a
 * dry run reporting WOULD_ADD_METRIC cannot be followed by a write that refuses.
 * Working the outcome out separately here would be the parallel system
 * CLAUDE.md names first, and it would diverge precisely where somebody is
 * deciding whether to touch production.
 */
export async function runRegistration(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const refuse = (problems: string[]): RunResult => {
    for (const problem of problems) {
      deps.log(line({ event: 'PRECONDITION_FAILED', reason: problem }));
    }
    return { outcome: 'FAILED_PRECONDITION', dryRun: request.dryRun, sourceKey: null, problems };
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

  const input: RegisterSourceInput = {
    key: validated.value.key,
    kind: validated.value.kind,
    displayName: validated.value.displayName,
    provider: validated.value.provider,
    stream: validated.value.stream,
    // ONE METRIC PER DISPATCH. Safe only because registration is additive: the
    // metrics this source already declares and this dispatch does not name are
    // left exactly as they were.
    metrics: [
      { metric: validated.value.metric, measureDefinitionId: validated.value.measureDefinitionId },
    ],
  };

  deps.log(
    line({
      event: 'REGISTRATION_START',
      organization: organization.slug,
      sourceKey: input.key,
      kind: input.kind,
      provider: input.provider ?? null,
      stream: input.stream ?? null,
      metric: validated.value.metric,
      measureDefinitionId: validated.value.measureDefinitionId,
      dryRun: request.dryRun,
    }),
  );

  // THE PRE-WRITE CHECK RUNS ON EVERY RUN, not only on a dry one. An operator
  // who skipped the dry run still gets the existing state printed beside what
  // happened, so the log explains itself without a second dispatch.
  const preview = await deps.sources.previewSourceRegistration(organization.id, input);
  deps.log(
    line({
      event: 'PRE_WRITE_CHECK',
      sourceKey: input.key,
      wouldBe: preview.outcome,
      existing: preview.existing === null ? 'none' : 'registered',
      existingKind: preview.existing?.kind ?? null,
      existingMetrics: preview.existing ? preview.existing.supportedMetrics.slice().sort().join(',') : null,
      wouldAdd: preview.wouldAddMetrics.join(','),
      reason: preview.reason,
    }),
  );
  for (const problem of preview.problems) {
    deps.log(line({ event: 'PRE_WRITE_PROBLEM', detail: problem }));
  }

  if (preview.outcome === 'BLOCKED') {
    deps.log(line({ event: 'REGISTRATION_BLOCKED', written: false, reason: preview.reason }));
    return { outcome: 'BLOCKED', dryRun: request.dryRun, sourceKey: input.key, problems: preview.problems };
  }

  if (request.dryRun) {
    // NOTHING IS WRITTEN, and `registerSource` is not called at all -- it
    // mutates, and a dry run that invoked it would be a write with a comment on
    // it.
    const would: RunOutcome =
      preview.outcome === 'CREATED'
        ? 'WOULD_CREATE_SOURCE_AND_METRIC'
        : preview.outcome === 'ADDED_METRIC'
          ? 'WOULD_ADD_METRIC'
          : 'WOULD_BE_ALREADY_EQUIVALENT';
    deps.log(line({ event: 'DRY_RUN_COMPLETE', written: false, wouldBe: would }));
    return { outcome: would, dryRun: true, sourceKey: input.key, problems: [] };
  }

  const result = await deps.sources.registerSource(organization.id, input);
  if (!result.ok) {
    // Reachable when a concurrent registration landed between the preview and
    // the write. The preview is advice; the repository is the decision.
    deps.log(line({ event: 'REGISTRATION_BLOCKED', written: false, reason: result.reason }));
    for (const problem of result.problems) {
      deps.log(line({ event: 'REGISTRATION_PROBLEM', detail: problem }));
    }
    return { outcome: 'BLOCKED', dryRun: false, sourceKey: input.key, problems: result.problems };
  }

  // READ BACK WHAT WAS WRITTEN, from the repository rather than from the write's
  // own return value. A write that reported success and a table that does not
  // agree is exactly the case worth catching, and it costs one read.
  const stored = await deps.sources.findSource(organization.id, input.key);
  deps.log(
    line({
      event: 'REGISTRATION_RESULT',
      organization: organization.slug,
      result: result.outcome,
      written: result.outcome !== 'ALREADY_EQUIVALENT',
      addedMetrics: result.addedMetrics.join(','),
      readBack: stored === null ? 'MISSING' : 'CONFIRMED',
      ...(stored ? describe(stored) : {}),
      measureDefinitionId: stored?.measureDefinitionIds[validated.value.metric] ?? null,
    }),
  );
  if (stored === null) {
    return {
      outcome: 'BLOCKED',
      dryRun: false,
      sourceKey: input.key,
      problems: ['the source was reported written but could not be read back'],
    };
  }

  return { outcome: result.outcome, dryRun: false, sourceKey: input.key, problems: [] };
}

// --- Input plumbing -----------------------------------------------------------

/** Names of the environment values this run needs. Values are never returned. */
export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // NO PROVIDER CREDENTIAL. Registering a source is a commercial decision and
  // never reads traffic, so this runner has no reason to hold one.
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
    key: pick('--key', '--source-key'),
    displayName: pick('--display-name'),
    kind: pick('--kind'),
    provider: pick('--provider') || null,
    stream: pick('--stream') || null,
    metric: pick('--metric'),
    measureDefinitionId: pick('--measure-definition-id', '--definition-id'),
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
    const result = await runRegistration(request, {
      sources: repositories.measurementSources,
      organizations: repositories.organizations,
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
const ENTRY_POINT = /[\\/]register-measurement-source\.ts$/;
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
