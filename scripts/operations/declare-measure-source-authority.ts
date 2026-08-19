// Declare measure source authority — an OPERATIONS BRIDGE, not product architecture.
//
// WHAT IT IS
//
// The smallest thing that can invoke
// `MeasurementSourceRepository.declareAuthority` against production. PR 4 shipped
// source-authority persistence with zero callers, so nothing could state which
// source owns a measure. This is the other half of the bridge, and it is
// deletable the day a real operator surface ships.
//
// WHAT IT DECLARES, EXACTLY
//
//   For this organization, this member, this measure, over this effective range,
//   THIS REGISTERED SOURCE IS AUTHORITATIVE.
//
// It does NOT say the source is available, has data for any date, is reconciled,
// is fresh, or that a measurement is ready. Those are separate facts with
// separate machinery, and collapsing any of them into this one is how a number
// gets published because a field happened to be non-null.
//
// AUTHORITY IS DECLARED, NEVER INFERRED. This runner reads no calls, no revenue,
// no webhook configuration, no reconciliation verdict and no import. On
// 2026-08-05 every one of the 974 records the provider held carried
// `converted=false` — present, not absent — so a conversion rate computed from
// them would have returned 0% at full coverage and stated a business falsehood as
// a measured fact. A person says whose number it is, or nobody does.
//
// THE SOURCE MUST ALREADY EXIST. There is deliberately no way to create one from
// here: `register-measurement-source.ts` is a separate dispatch, because "we are
// willing to believe this thing" and "believe it INSTEAD of anything else" are
// different statements. Naming an unregistered key is refused, not helpfully
// fixed.
//
// ONE MEMBER, ONE MEASURE, ONE SOURCE PER DISPATCH. There is no batch mode. Each
// declaration gets its own dispatcher, its own reason and its own line in the
// audit trail — which is what makes the run record worth having.
//
// USAGE
//
//   npm run declare:source-authority -- \
//     --organization <slug> --dimension CAMPAIGN --member <external-id> \
//     --metric REVENUE --source-key <key> --reason "..." \
//     --effective-from 2026-08-05 [--effective-to 2026-09-01] \
//     [--declarer-email someone@example.com] [--dry-run]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL   the DIRECT (non-pooled) production endpoint

import {
  BINDING_DIMENSIONS,
  MEASURE_METRICS,
  isBindingDimension,
  isBusinessDate,
  isMeasureMetric,
  type BindingDimension,
  type BusinessDate,
  type MeasureMetric,
} from '@emgloop/shared';
import type {
  AuthorityDeclarationPreview,
  AuthorityDeclarationView,
  DeclareAuthorityInput,
  DeclareAuthorityResult,
} from '@emgloop/database';

// --- The seams this file is tested through ------------------------------------
//
// Narrow on purpose. The runner may preview a declaration, record one and read
// the history back, and may look an organization up and list its members. It has
// NO source-registration method: this runner cannot create a source, only name
// one that exists.

export interface AuthorityWriter {
  previewAuthorityDeclaration(
    organizationId: string,
    input: DeclareAuthorityInput,
  ): Promise<AuthorityDeclarationPreview>;
  declareAuthority(organizationId: string, input: DeclareAuthorityInput): Promise<DeclareAuthorityResult>;
  authoritiesFor(
    organizationId: string,
    dimension: BindingDimension,
    memberExternalId: string,
    metric: MeasureMetric,
  ): Promise<AuthorityDeclarationView[]>;
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
  authorities: AuthorityWriter;
  organizations: OrganizationLookup;
  directory: MemberDirectory;
  log: (line: string) => void;
}

export interface RunRequest {
  organizationSlug: string;
  dimension: string;
  memberExternalId: string;
  metric: string;
  sourceKey: string;
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
  | 'WOULD_SUPERSEDE'
  | 'WOULD_BE_ALREADY_EQUIVALENT'
  | 'BLOCKED'
  | 'FAILED_PRECONDITION';

export interface RunResult {
  outcome: RunOutcome;
  dryRun: boolean;
  authorityId: string | null;
  /** The authority this one ended, when it ended one. */
  supersededId: string | null;
  /** Whether a human actor was recorded, without naming them again in the result. */
  declarerResolved: boolean;
  problems: readonly string[];
}

export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

// --- Input validation ---------------------------------------------------------
//
// Judged with the SAME predicates and vocabularies the repository applies, so a
// value this file accepts cannot be one the repository then rejects.

export interface ValidatedRequest {
  dimension: BindingDimension;
  memberExternalId: string;
  metric: MeasureMetric;
  sourceKey: string;
  reason: string;
  effectiveFrom: BusinessDate;
  effectiveTo: BusinessDate | null;
}

export function validateRequest(
  request: RunRequest,
): { ok: true; value: ValidatedRequest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const memberExternalId = request.memberExternalId.trim();
  const sourceKey = request.sourceKey.trim();
  const reason = request.reason.trim();
  const effectiveToRaw = request.effectiveTo?.trim() || null;

  if (memberExternalId === '') {
    problems.push('--member <external-id> is required; an authority keyed on a label is not identity');
  }
  if (sourceKey === '') {
    problems.push('--source-key is required; it must name a source this organization already registered');
  }
  if (reason === '') {
    problems.push('--reason is required; an unexplained authority is a place to hide a revenue decision');
  }
  if (!isBindingDimension(request.dimension)) {
    problems.push(`--dimension must be one of ${BINDING_DIMENSIONS.join(' | ')}`);
  }
  if (!isMeasureMetric(request.metric)) {
    problems.push(`--metric must be one of ${MEASURE_METRICS.join(' | ')}`);
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

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      dimension: request.dimension as BindingDimension,
      memberExternalId,
      metric: request.metric as MeasureMetric,
      sourceKey,
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
 * FAILS CLOSED IN BOTH DIRECTIONS, following the model PR #168 proved. An email
 * that matches nobody, or more than one member, resolves to a refusal rather
 * than to null: silently recording "nobody said this" when a person believed
 * they were signing it would put a weaker provenance on the row than the
 * operator intended, and that weakness would be invisible afterwards.
 *
 * NO USER ID IS EVER ACCEPTED FROM OUTSIDE. The runner takes an email and looks
 * it up through the organization-scoped roster; there is no input that could
 * carry an id belonging to another tenant, because there is no input that
 * carries an id at all. A user in another organization therefore cannot resolve
 * — the roster read is scoped, not filtered afterwards.
 *
 * A BLANK EMAIL IS LEGITIMATE and resolves to null, which the repository
 * documents as the honest value when no human actor is resolvable — never a
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
    return { ok: false, problem: 'the declarer email matches no member of this organization' };
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

function describe(view: AuthorityDeclarationView): Record<string, string | null> {
  return {
    authorityId: view.id,
    sourceKey: view.sourceKey,
    effectiveFrom: view.effectiveFrom,
    effectiveTo: view.effectiveTo,
    declaredBy: view.declaredByUserId === null ? 'none recorded' : 'recorded',
  };
}

/**
 * Declare one measure source authority, or say what declaring it would do.
 *
 * THE DRY RUN AND THE WRITE ASK THE SAME QUESTION.
 * `previewAuthorityDeclaration` and `declareAuthority` share one precondition
 * helper and one effective-dating decision function inside the repository, so a
 * dry run reporting WOULD_SUPERSEDE cannot be followed by a write that refuses.
 * The only case where they legitimately differ is a declaration that lands
 * between the two calls — which is why the database's EXCLUDE constraint is the
 * decision and the preview is advice.
 */
export async function runDeclaration(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const refuse = (problems: string[]): RunResult => {
    for (const problem of problems) {
      deps.log(line({ event: 'PRECONDITION_FAILED', reason: problem }));
    }
    return {
      outcome: 'FAILED_PRECONDITION',
      dryRun: request.dryRun,
      authorityId: null,
      supersededId: null,
      declarerResolved: false,
      problems,
    };
  };

  const validated = validateRequest(request);
  if (!validated.ok) return refuse(validated.problems);

  const organization = await deps.organizations.findBySlug(request.organizationSlug);
  if (!organization) {
    return refuse([`No organization with slug "${request.organizationSlug}".`]);
  }
  if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
    return refuse([`Organization "${organization.slug}" is ${organization.status}.`]);
  }

  const declarer = await resolveDeclarer(deps.directory, organization.id, request.declarerEmail);
  if (!declarer.ok) return refuse([declarer.problem]);

  const input: DeclareAuthorityInput = {
    dimension: validated.value.dimension,
    memberExternalId: validated.value.memberExternalId,
    metric: validated.value.metric,
    sourceKey: validated.value.sourceKey,
    reason: validated.value.reason,
    effectiveFrom: validated.value.effectiveFrom,
    effectiveTo: validated.value.effectiveTo,
    declaredByUserId: declarer.userId,
  };

  deps.log(
    line({
      event: 'AUTHORITY_START',
      organization: organization.slug,
      dimension: input.dimension,
      member: input.memberExternalId,
      metric: input.metric,
      sourceKey: input.sourceKey,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      declarer: declarer.userId === null ? 'none' : 'resolved',
      dryRun: request.dryRun,
    }),
  );

  // THE PRE-WRITE CHECK RUNS ON EVERY RUN, not only on a dry one. It also proves
  // the named source exists and declares a definition for this measure — both
  // refusals live in the repository, so the runner learns of them here rather
  // than inventing its own version of the same question.
  const preview = await deps.authorities.previewAuthorityDeclaration(organization.id, input);
  deps.log(
    line({
      event: 'PRE_WRITE_CHECK',
      member: input.memberExternalId,
      metric: input.metric,
      businessDate: input.effectiveFrom,
      wouldBe: preview.outcome,
      existing: preview.effectiveNow === null ? 'none' : preview.effectiveNow.sourceKey,
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
    deps.log(line({ event: 'AUTHORITY_BLOCKED', written: false, reason: preview.reason }));
    return {
      outcome: 'BLOCKED',
      dryRun: request.dryRun,
      authorityId: null,
      supersededId: null,
      declarerResolved: declarer.userId !== null,
      problems: preview.problems,
    };
  }

  if (request.dryRun) {
    // NOTHING IS WRITTEN, and `declareAuthority` is not called at all.
    const would: RunOutcome =
      preview.outcome === 'ALREADY_EQUIVALENT'
        ? 'WOULD_BE_ALREADY_EQUIVALENT'
        : preview.outcome === 'WOULD_SUPERSEDE'
          ? 'WOULD_SUPERSEDE'
          : 'WOULD_CREATE';
    deps.log(
      line({
        event: 'DRY_RUN_COMPLETE',
        written: false,
        wouldBe: would,
        supersedes: preview.supersedes?.id ?? null,
        authorityId: preview.effectiveNow?.id ?? null,
      }),
    );
    return {
      outcome: would,
      dryRun: true,
      authorityId: preview.effectiveNow?.id ?? null,
      supersededId: preview.supersedes?.id ?? null,
      declarerResolved: declarer.userId !== null,
      problems: [],
    };
  }

  const result = await deps.authorities.declareAuthority(organization.id, input);
  if (!result.ok) {
    deps.log(line({ event: 'AUTHORITY_BLOCKED', written: false, reason: result.reason }));
    for (const problem of result.problems) {
      deps.log(line({ event: 'AUTHORITY_PROBLEM', detail: problem }));
    }
    return {
      outcome: 'BLOCKED',
      dryRun: false,
      authorityId: null,
      supersededId: null,
      declarerResolved: declarer.userId !== null,
      problems: result.problems,
    };
  }

  // READ BACK WHAT WAS WRITTEN, from the repository rather than from the write's
  // own return value.
  const history = await deps.authorities.authoritiesFor(
    organization.id,
    validated.value.dimension,
    validated.value.memberExternalId,
    validated.value.metric,
  );
  const stored = history.find((d) => d.id === result.declaration.id) ?? null;
  deps.log(
    line({
      event: 'AUTHORITY_RESULT',
      organization: organization.slug,
      dimension: input.dimension,
      member: input.memberExternalId,
      metric: input.metric,
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
      authorityId: null,
      supersededId: null,
      declarerResolved: declarer.userId !== null,
      problems: ['the authority was reported written but could not be read back'],
    };
  }

  return {
    outcome: result.unchanged ? 'ALREADY_EQUIVALENT' : 'CREATED',
    dryRun: false,
    authorityId: stored.id,
    supersededId: result.supersededId,
    declarerResolved: declarer.userId !== null,
    problems: [],
  };
}

// --- Input plumbing -----------------------------------------------------------

export function readEnvironment(
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; missing: string[] } {
  // NO PROVIDER CREDENTIAL. A declaration is a human statement and never reads
  // traffic.
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
    dimension: pick('--dimension'),
    memberExternalId: pick('--member', '--member-external-id', '--campaign'),
    metric: pick('--metric'),
    sourceKey: pick('--source-key', '--source'),
    reason: pick('--reason'),
    effectiveFrom: pick('--effective-from'),
    effectiveTo: pick('--effective-to') || null,
    declarerEmail: pick('--declarer-email') || null,
    dryRun,
  };
}

// --- Wiring -------------------------------------------------------------------

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

  const { prisma, repositories } = await import('@emgloop/database');

  try {
    const result = await runDeclaration(request, {
      authorities: repositories.measurementSources,
      organizations: repositories.organizations,
      directory: repositories.iam,
      log,
    });
    return result.outcome === 'BLOCKED' || result.outcome === 'FAILED_PRECONDITION' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file starts nothing.
const ENTRY_POINT = /[\\/]declare-measure-source-authority\.ts$/;
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
