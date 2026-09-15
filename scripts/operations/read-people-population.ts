// Read people population -- the evidence historical People remediation is designed from.
//
// READ-ONLY, AGGREGATE COUNTS, ONE ORGANIZATION. Prints how the existing Customer
// population was produced and what has happened to it: provenance, anonymous
// visitor residue, withheld callers, duplicate phone patterns, how interactions
// were attached, which records people worked, what the call workflows touched,
// the identity-governance baseline, creation bursts, and exposure after identity
// Slice 1 (#239). It changes nothing, remediates nothing and decides nothing.
//
// READ-ONLY IS ENFORCED BY THE DATABASE, not only by this code. The connection is
// opened with `default_transaction_read_only=on`, so Postgres refuses any write
// the process attempts (SQLSTATE 25006), whatever the code does.
//
// NOTHING IDENTIFYING IS PRINTED. Every line is `event=NAME KEY=value ...`, where
// every key comes from a fixed vocabulary and every value is an integer, a
// boolean, UNKNOWN, a UTC date bucket, a fixed uppercase label or the requested
// organization slug. `printable` checks each line against that shape before it is
// written and the run fails rather than print anything else. A failure prints its
// error class and Prisma code, never its message, because a message can quote a
// value.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. A human asks.

import type { PeoplePopulationAudit } from '../../packages/database/src/repositories/people-population-audit.repository';

/** #239 merged at this instant. Production received it at its next deploy, shortly after. */
export const SLICE1_MERGED_AT = '2026-09-15T13:49:40.000Z';

export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
}

export interface PopulationReader {
  audit(organizationId: string, asOf: Date, slice1At: Date): Promise<PeoplePopulationAudit>;
}

/** The counts-only subset of the identity footprint this audit reports. */
export interface IdentityBaselineReader {
  footprint(organizationId: string): Promise<{
    identities: { total: number; partyTyped: number };
    satellites: { evidence: number; resolutionLinks: number; linksByStatus: Record<string, number> };
    exceededBound: boolean;
  }>;
}

export interface PopulationDeps {
  organizations: OrganizationLookup;
  population: PopulationReader;
  identities: IdentityBaselineReader;
  now: () => Date;
  log: (line: string) => void;
}

export interface PopulationResult {
  overall: 'READ' | 'FAILED_PRECONDITION';
  audit: PeoplePopulationAudit | null;
  error: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;

export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

export function parseArgs(argv: readonly string[]): { organization: string; slice1At: string } {
  let organization = '';
  let slice1At = SLICE1_MERGED_AT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    } else if (argv[i] === '--slice1-at') {
      const v = (argv[i + 1] ?? '').trim();
      if (v) slice1At = v;
      i += 1;
    }
  }
  return { organization, slice1At };
}

/**
 * The connection string with a read-only session forced on.
 *
 * Postgres applies `-c default_transaction_read_only=on` to every transaction on
 * the connection, so a write fails in the database whatever issued it. An
 * `options` value already on the URL is kept and extended, never replaced.
 */
export function readOnlySessionUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL is not a PostgreSQL connection string');
  }
  const flag = '-c default_transaction_read_only=on';
  const existing = url.searchParams.get('options');
  if (!existing?.includes('default_transaction_read_only=on')) {
    url.searchParams.set('options', existing ? `${existing} ${flag}` : flag);
  }
  return url.toString();
}

type Field = string | number | boolean | null;

const KEY = /^[A-Za-z0-9_]+$/;
const NUMBERISH = /^(\d+|true|false|UNKNOWN)$/;
const LABEL = /^[A-Z][A-Z0-9_]*$/;
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Keys whose value is not a count, and the only shape each may take. */
const SHAPED: Record<string, (value: string, slug: string) => boolean> = {
  event: (v) => LABEL.test(v),
  class: (v) => LABEL.test(v),
  reason: (v) => LABEL.test(v),
  OVERALL_RESULT: (v) => LABEL.test(v),
  ERROR_CLASS: (v) => LABEL.test(v),
  CODE: (v) => LABEL.test(v),
  organization: (v, slug) => v === slug,
  month: (v) => MONTH.test(v),
  week: (v) => DAY.test(v),
  day: (v) => DAY.test(v),
  AS_OF: (v) => INSTANT.test(v),
  SLICE1_AT: (v) => INSTANT.test(v),
};

/**
 * Whether a line has the only shape this runner may print: known keys carry
 * their fixed shape, the organization is the one requested, and every other value
 * is a count, a boolean or UNKNOWN. A lowercase word, an email, a phone number, a
 * name or an id cannot satisfy it.
 */
export function printable(l: string, organizationSlug: string): boolean {
  return l.split(' ').every((token) => {
    const at = token.indexOf('=');
    if (at <= 0) return false;
    const key = token.slice(0, at);
    const value = token.slice(at + 1);
    if (!KEY.test(key)) return false;
    const shaped = SHAPED[key];
    return shaped ? shaped(value, organizationSlug) : NUMBERISH.test(value);
  });
}

function line(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? 'UNKNOWN' : String(v)}`)
    .join(' ');
}

/** Keyed counts, prefixed, zero buckets omitted. A null map is one UNKNOWN field. */
function counts(prefix: string, values: Record<string, number> | null): Record<string, Field> {
  if (values === null) return { [`${prefix}ALL`]: null };
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => [`${prefix}${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, n]),
  );
}

export async function runPeoplePopulationAudit(
  request: { organizationSlug: string; slice1At: string },
  deps: PopulationDeps,
): Promise<PopulationResult> {
  const emit = (fields: Record<string, Field>) => {
    const l = line(fields);
    if (!printable(l, request.organizationSlug)) throw new Error('refusing to print a line outside the aggregate vocabulary');
    deps.log(l);
  };
  const refuse = (reason: string): PopulationResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', audit: null, error: reason };
  };

  if (!SLUG.test(request.organizationSlug)) return refuse('INVALID_ORGANIZATION_SLUG');
  if (!ISO_INSTANT.test(request.slice1At) || Number.isNaN(Date.parse(request.slice1At))) {
    return refuse('INVALID_SLICE1_AT');
  }
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('UNKNOWN_ORGANIZATION');

  const asOf = deps.now();
  const slice1At = new Date(request.slice1At);
  const a = await deps.population.audit(org.id, asOf, slice1At);
  const identity = await deps.identities.footprint(org.id);

  emit({ event: 'AUDIT_SCOPE', organization: org.slug, AS_OF: a.asOf, SLICE1_AT: a.slice1At, READ_ONLY_SESSION: true });

  const prov = a.provenance;
  emit({
    event: 'PROVENANCE',
    CUSTOMERS: prov?.customers ?? null,
    ...(prov ? counts('CLASS_', prov.byClass) : { CLASS_ALL: null }),
    ...(prov ? counts('IDENTIFIERS_', prov.identifiers) : {}),
    NAME_PRESENT: prov?.namePresent ?? null,
    ...(prov ? counts('TAG_', prov.tags) : {}),
    MERGED_MARKER: prov?.mergedMarker ?? null,
    TEST_OR_DEMO_MARKED: prov?.testOrDemoMarked ?? null,
  });
  for (const m of prov?.byMonth ?? []) emit({ event: 'PROVENANCE_MONTH', month: m.month, ...counts('CLASS_', m.byClass) });

  const v = a.anonymousVisitors;
  emit({
    event: 'ANONYMOUS_VISITORS',
    TOTAL: v?.total ?? null,
    WITH_NAME: v?.withName ?? null,
    WITH_EMAIL: v?.withEmail ?? null,
    WITH_PHONE: v?.withPhone ?? null,
    ...(v ? counts('INTERACTIONS_', v.byInteractionCount) : {}),
    ...(v ? counts('STATUS_', v.byStatus) : {}),
    STRONG_HUMAN_WORK: v?.withStrongHumanWork ?? null,
    ANY_HUMAN_WORK: v?.withAnyHumanWork ?? null,
    PARTY_LINKED: v?.partyLinked ?? null,
  });

  const w = a.withheldCallers;
  emit({
    event: 'WITHHELD_CALLERS',
    PHONE_PRESENT: w?.phonePresent ?? null,
    ...(w ? counts('PHONE_', w.byPhoneClass) : {}),
    PLACEHOLDER_PHONES: w?.placeholderPhones ?? null,
    WITHHELD: w?.withheld ?? null,
    ...(w ? counts('FORM_', w.byForm) : {}),
    ...(w ? counts('CLASS_', w.withheldByClass) : {}),
    ...(w ? counts('INTERACTIONS_', w.withheldByInteractionCount) : {}),
    STRONG_HUMAN_WORK: w?.withheldWithStrongHumanWork ?? null,
  });

  const d = a.duplicatePhones;
  emit({
    event: 'DUPLICATE_PHONES',
    SAME_NUMBER_GROUPS: d?.sameNumberGroups ?? null,
    SAME_NUMBER_ROWS: d?.sameNumberRows ?? null,
    ...(d ? counts('GROUP_SIZE_', d.sameNumberGroupSizes) : {}),
    FORMAT_VARIANT_GROUPS: d?.formatVariantGroups ?? null,
    LAST7_COLLISION_GROUPS: d?.last7CollisionGroups ?? null,
    LAST7_COLLISION_ROWS: d?.last7CollisionRows ?? null,
    LAST7_COLLISION_NUMBERS: d?.last7CollisionNumbers ?? null,
    SAME_EMAIL_GROUPS: d?.sameEmailGroups ?? null,
    SAME_EMAIL_ROWS: d?.sameEmailRows ?? null,
  });

  const ia = a.interactionAttachment;
  emit({
    event: 'INTERACTION_ATTACHMENT',
    INTERACTIONS: ia?.interactions ?? null,
    ATTACHED: ia?.attached ?? null,
    UNATTACHED: ia?.unattached ?? null,
    ...(ia ? counts('PROVIDER_', ia.byProvider) : {}),
    ...(ia ? counts('NOTES_', ia.notes) : {}),
    ...(ia ? counts('CUSTOMERS_WITH_INTERACTIONS_', ia.customersByInteractionCount) : {}),
  });
  emit({
    event: 'CALL_ATTACHMENT',
    ...(ia ? counts('', ia.callAttachment) : { ALL: null }),
    CUSTOMERS_WITH_2_PLUS_CALLERS: ia?.customersWithTwoOrMoreCallers ?? null,
    CUSTOMERS_WITH_LAST7_ONLY_CALLS: ia?.customersWithLast7OnlyCalls ?? null,
  });

  const h = a.humanWork;
  emit({
    event: 'HUMAN_WORK',
    ...(h ? counts('SIGNAL_', h.bySignal) : { SIGNAL_ALL: null }),
    ANY: h?.anySignal ?? null,
    STRONG: h?.strongSignal ?? null,
    WEAK_ONLY: h?.weakOnly ?? null,
    NONE: h?.noSignal ?? null,
  });
  for (const c of h?.byClass ?? []) {
    if (c.total > 0) emit({ event: 'HUMAN_WORK_CLASS', class: c.cls, TOTAL: c.total, STRONG: c.strong, WEAK_ONLY: c.weakOnly, NONE: c.none });
  }

  const wf = a.workflowDamage;
  emit({
    event: 'WORKFLOWS',
    WORKFLOWS: wf?.workflows ?? null,
    ACTIVE: wf?.active ?? null,
    ...(wf ? counts('CLASS_', wf.byClass) : {}),
    ...(wf ? counts('ACTIVE_', wf.activeByClass) : {}),
    ...(wf ? counts('WITH_STEP_', wf.workflowsWithStep) : {}),
    ...(wf ? counts('STATUS_STEP_', wf.workflowsSettingStatus) : {}),
  });
  emit({
    event: 'WORKFLOW_RUNS',
    RUNS: wf?.runs ?? null,
    ...(wf ? counts('STATUS_', wf.runsByStatus) : {}),
    ...(wf ? counts('CLASS_', wf.runsByWorkflowClass) : {}),
    CUSTOMERS_TOUCHED_BY_CALL_WORKFLOWS: wf?.customersTouchedByCallWorkflows ?? null,
    TOUCHED_WITH_STRONG_HUMAN_WORK: wf?.touchedWithStrongHumanWork ?? null,
    LIKELY_STATUS_OVERWRITTEN: wf?.likelyStatusOverwritten ?? null,
    CUSTOMERS_WITH_WORKFLOW_NOTES: wf?.customersWithWorkflowNotes ?? null,
    RUNS_AFTER_SLICE1: wf?.runsAfterSlice1 ?? null,
  });
  for (const m of wf?.runsByMonth ?? []) emit({ event: 'WORKFLOW_RUNS_MONTH', month: m.month, ...counts('STATUS_', m.byStatus) });

  const g = a.governance;
  emit({
    event: 'IDENTITY_GOVERNANCE',
    COGNITIVE_IDENTITIES: identity.identities.total,
    PARTY_TYPED: identity.identities.partyTyped,
    PARTIES_ESTABLISHED: g.partiesEstablished,
    ...counts('ESTABLISHED_', g.partiesEstablishedByBasis),
    PARTY_TYPED_UNESTABLISHED: g.partyTypedUnestablished,
    IDENTITY_EVIDENCE: identity.satellites.evidence,
    RESOLUTION_LINKS: identity.satellites.resolutionLinks,
    ...counts('RESOLUTION_LINK_', identity.satellites.linksByStatus),
    CUSTOMER_PARTY_LINKS: g.customerPartyLinks,
    ACTIVE_LINKS: g.activeLinks,
    REVERSED_LINKS: g.reversedLinks,
    ...counts('LINK_BASIS_', g.linksByBasis),
    CUSTOMERS_WITH_ACTIVE_LINK: g.customersWithActiveLink,
    FOOTPRINT_EXCEEDED_BOUND: identity.exceededBound,
  });

  const b = a.creationBursts;
  emit({
    event: 'CREATION_BURSTS',
    DAYS_WITH_INGESTION_CREATIONS: b?.daysWithIngestionCreations ?? null,
    MAX_DAILY: b?.maxDaily ?? null,
    P95_DAILY: b?.p95Daily ?? null,
    MEDIAN_DAILY: b?.medianDaily ?? null,
    EVENTS_SCAN_COMPLETE: b?.eventsScanComplete ?? null,
  });
  for (const day of b?.topDays ?? []) {
    emit({
      event: 'CREATION_DAY',
      day: day.day,
      CUSTOMERS: day.customers,
      INGESTION_CUSTOMERS: day.ingestionCustomers,
      EVENTS_RECEIVED: b!.eventsScanComplete ? day.eventsReceived : null,
      ...(b!.eventsScanComplete ? counts('SOURCE_', day.eventsBySource) : { SOURCE_ALL: null }),
      EVENTS_OCCURRED_EARLIER: b!.eventsScanComplete ? day.eventsOccurredEarlier : null,
    });
  }

  const x = a.slice1Exposure;
  emit({
    event: 'SLICE1_EXPOSURE',
    CUSTOMERS_CREATED_AFTER: x?.customersCreatedAfter ?? null,
    INGESTION_CUSTOMERS_CREATED_AFTER: x?.ingestionCustomersCreatedAfter ?? null,
    INTERACTIONS_AFTER: x?.interactionsAfter ?? null,
    PROVIDER_INTERACTIONS_ATTACHED_AFTER: x?.attachedProviderInteractionsAfter ?? null,
    WORKFLOW_RUNS_AFTER: x?.workflowRunsAfter ?? null,
    ...(x ? counts('EXCLUDED_ONLY_VIA_CUSTOMER_', x.excludedOnlyViaCustomer) : {}),
    BOOKINGS_ON_INGESTION_CUSTOMERS: x?.bookingsOnIngestionCustomers ?? null,
    ORDERS_ON_INGESTION_CUSTOMERS: x?.ordersOnIngestionCustomers ?? null,
  });
  for (const wk of x?.peopleAddedByWeek ?? []) emit({ event: 'PEOPLE_ADDED_WEEK', week: wk.week, INGESTION: wk.ingestion, OTHER: wk.other });

  emit({ event: 'VERDICT', EXCEEDED_BOUND: a.exceededBound || identity.exceededBound, OVERALL_RESULT: 'READ' });
  return { overall: 'READ', audit: a, error: null };
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'ORGANIZATION_REQUIRED' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'DATABASE_URL_MISSING' }));
    return 2;
  }
  // Before the database package loads: its client reads DATABASE_URL when it is
  // constructed, so every query this process makes runs read-only.
  process.env.DATABASE_URL = readOnlySessionUrl(process.env.DATABASE_URL!);

  const { prisma, repositories, PeoplePopulationAuditRepository, IdentityFootprintRepository } = await import('@emgloop/database');
  try {
    const result = await runPeoplePopulationAudit(
      { organizationSlug: args.organization, slice1At: args.slice1At },
      {
        organizations: repositories.organizations,
        population: new PeoplePopulationAuditRepository(prisma),
        identities: new IdentityFootprintRepository(prisma),
        now: () => new Date(),
        log,
      },
    );
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-people-population\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // The class and Prisma code only. A message can quote a row value.
      const name = error instanceof Error ? error.constructor.name.replace(/[^A-Za-z0-9]/g, '') || 'Error' : 'Unknown';
      const code = (error as { code?: unknown })?.code;
      const safeCode = typeof code === 'string' && /^[A-Z0-9]{1,8}$/.test(code) ? code : 'NONE';
      process.stdout.write(line({ event: 'RUN_FAILED', ERROR_CLASS: name.toUpperCase(), CODE: safeCode }) + '\n');
      process.exitCode = 1;
    },
  );
}
