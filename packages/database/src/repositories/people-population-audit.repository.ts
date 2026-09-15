// People population audit -- how the existing Customer population was produced.
//
// READ-ONLY, AGGREGATE COUNTS, ONE ORGANIZATION. Until identity Slice 1 (#239)
// ingestion created or matched a Customer for every caller number, withheld
// caller, form email or phone and anonymous website visitor, and the seeded call
// workflows rewrote the matched Customer's status. Historical remediation must be
// designed from evidence about that population, so this reader measures it:
// provenance, anonymous-visitor residue, withheld callers, duplicate phone
// patterns, how interactions were attached, which records people actually worked,
// what the call workflows touched, the identity-governance baseline, creation
// bursts, and exposure after Slice 1. It changes nothing and decides nothing.
//
// WHAT LEAVES THIS FILE: integers, booleans, null (UNKNOWN), and bucket labels
// from the fixed vocabularies below. Names, emails, phone numbers, tags, workflow
// names, event names, metadata and record ids are read only to place a row in a
// bucket, held in memory for the duration of the read, and never returned. Dates
// leave only as UTC month, week or day buckets.
//
// CONSISTENT BY CUT-OFF, NOT BY TRANSACTION. Every read is bounded to rows created
// before `asOf`, so traffic that arrives while the audit runs is not half-counted,
// and no long-running transaction holds a snapshot on production.
//
// BOUNDED. Every table is read in id order, PAGE_SIZE rows at a time, up to its
// bound. A section whose read passed its bound is null (UNKNOWN) and
// `exceededBound` is true, rather than a partial number that looks like a whole
// one.

import type { PrismaClient } from '@prisma/client';
import { OBSERVATION_SOURCES } from '@emgloop/shared';
import { isExcludedCustomer, isExcludedInteraction, isPlaceholderPhone, type CustomerLike } from './operational-filters';
import { PIPELINE_STATUSES } from './crm.repository';

export const PAGE_SIZE = 2_000;

export const AUDIT_BOUNDS = {
  customers: 500_000,
  interactions: 3_000_000,
  /** Attached CallGrid / website interactions, read with their metadata. */
  attachedProviderInteractions: 1_000_000,
  notes: 1_000_000,
  dependents: 1_000_000,
  auditEntries: 1_000_000,
  partyLinks: 500_000,
  workflows: 10_000,
  workflowRuns: 2_000_000,
  integrationEvents: 3_000_000,
} as const;

// --- Fixed vocabularies. Nothing outside these ever labels an output. ---------------

export const PROVENANCE_CLASSES = [
  'INGESTION_CALL',
  'INGESTION_WEB_VISITOR',
  'INGESTION_WEB_LEAD',
  'INGESTION_OTHER_SOURCE',
  'SEED_OR_DEMO',
  'EXTERNAL_IMPORT',
  'UNMARKED',
] as const;
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];
const INGESTION_CLASSES: ReadonlySet<ProvenanceClass> = new Set([
  'INGESTION_CALL',
  'INGESTION_WEB_VISITOR',
  'INGESTION_WEB_LEAD',
  'INGESTION_OTHER_SOURCE',
]);

export const PHONE_CLASSES = ['ABSENT', 'NO_DIGITS', 'SHORT_DIGITS', 'NANP', 'OTHER_LENGTH', 'OVERLONG'] as const;
export type PhoneClass = (typeof PHONE_CLASSES)[number];

export const WITHHELD_FORMS = [
  'ANONYMOUS',
  'RESTRICTED',
  'UNAVAILABLE',
  'UNKNOWN',
  'PRIVATE',
  'BLOCKED',
  'WITHHELD',
  'NO_CALLER_ID',
  'SHORT_NUMBER',
  'OTHER_TEXT',
] as const;
export type WithheldForm = (typeof WITHHELD_FORMS)[number];

export const COUNT_BUCKETS = ['0', '1', '2_5', '6_20', '21_PLUS'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export const STATUS_BUCKETS = [...PIPELINE_STATUSES.map((s) => s.toUpperCase()), 'OTHER', 'ABSENT'] as const;

/** The tags ingestion and its seeded workflows wrote. Any other tag was added some other way. */
export const INGESTION_TAGS = ['lead', 'anonymous-visitor', 'inbound-call', 'missed-call'] as const;
const INGESTION_TAG_SET: ReadonlySet<string> = new Set(INGESTION_TAGS);
const EXCLUSION_TAGS: ReadonlySet<string> = new Set(['demo', 'test', 'qa', 'e2e', 'sample', 'seed', 'fixture', 'archived', 'sprint-14-archive']);

/** Evidence a person worked a record, strongest first. */
export const STRONG_HUMAN_SIGNALS = [
  'CONVERSATION',
  'BOOKING',
  'ORDER',
  'SERVICE_REQUEST',
  'HUMAN_NOTE',
  'HUMAN_AUDIT',
  'PARTY_LINK',
  'MERGED',
] as const;
/** Weaker: each can also come from an import, a custom workflow or a bulk action. */
export const WEAK_HUMAN_SIGNALS = ['NAME_SET', 'STATUS_BEYOND_CONTACTED', 'ASSIGNED', 'TAG_OUTSIDE_INGESTION'] as const;
export type HumanSignal = (typeof STRONG_HUMAN_SIGNALS)[number] | (typeof WEAK_HUMAN_SIGNALS)[number];

/** Statuses the seeded call workflows could set. Anything beyond them was set another way. */
const WORKFLOW_DEFAULT_STATUSES: ReadonlySet<string> = new Set(['New', 'Contacted']);

export const CALL_ATTACHMENTS = [
  'CALLER_EXACT',
  'CALLER_LAST7_ONLY',
  'CALLER_DIFFERENT',
  'CALLER_WITHHELD',
  'CALLER_ABSENT',
  'CUSTOMER_NO_USABLE_PHONE',
] as const;
export type CallAttachment = (typeof CALL_ATTACHMENTS)[number];

export const PROVIDER_BUCKETS = ['CALLGRID', 'WEBSITE', 'NONE', 'OTHER'] as const;
export type ProviderBucket = (typeof PROVIDER_BUCKETS)[number];

export const NOTE_KINDS = ['HUMAN', 'WORKFLOW', 'OTHER'] as const;

export const WORKFLOW_CLASSES = ['EVENT_CALL', 'EVENT_WEB', 'EVENT_OTHER', 'MANUAL', 'SCHEDULE', 'OTHER'] as const;
export type WorkflowClass = (typeof WORKFLOW_CLASSES)[number];

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'] as const;

export const STEP_BUCKETS = [
  'ADD_TAG',
  'SET_PIPELINE_STATUS',
  'ASSIGN',
  'CREATE_NOTE',
  'SET_CONVERSATION_STATUS',
  'EMIT_EVENT',
  'OTHER',
] as const;
export const STATUS_STEP_BUCKETS = ['SETS_NEW', 'SETS_CONTACTED', 'SETS_BEYOND_CONTACTED', 'SETS_OTHER'] as const;

export const OBSERVATION_BUCKETS = [...OBSERVATION_SOURCES, 'NONE', 'OTHER'] as const;

const CALLER_KEYS = ['fromNumber', 'caller', 'callerId', 'caller_number', 'from'];

// --- Pure classification --------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Digits of a phone value, with a leading NANP 1 dropped from 11 digits. */
function phoneDigits(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function phoneClass(raw: string | null | undefined): PhoneClass {
  if (!text(raw)) return 'ABSENT';
  const d = phoneDigits(raw);
  if (d.length === 0) return 'NO_DIGITS';
  if (d.length < 7) return 'SHORT_DIGITS';
  if (d.length === 10) return 'NANP';
  if (d.length > 15) return 'OVERLONG';
  return 'OTHER_LENGTH';
}

/** The number a phone value names, for comparison, or null when it names none. */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = phoneDigits(raw);
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/** How a phone value that names no number was written. Fixed labels only. */
export function withheldForm(raw: string | null | undefined): WithheldForm {
  const letters = (raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!letters) return 'SHORT_NUMBER';
  if (letters.includes('anonymous')) return 'ANONYMOUS';
  if (letters.includes('restricted')) return 'RESTRICTED';
  if (letters.includes('unavailable')) return 'UNAVAILABLE';
  if (letters.includes('unknown')) return 'UNKNOWN';
  if (letters.includes('private')) return 'PRIVATE';
  if (letters.includes('blocked')) return 'BLOCKED';
  if (letters.includes('withheld')) return 'WITHHELD';
  if (letters.includes('nocallerid') || letters === 'callerid' || letters === 'noid') return 'NO_CALLER_ID';
  return 'OTHER_TEXT';
}

export interface ProvenanceInput {
  externalId: string | null;
  tags: string[] | null;
  metadata: unknown;
}

/** Where a Customer came from, by the marks each creator left. Precedence is top-down. */
export function provenanceClass(c: ProvenanceInput): ProvenanceClass {
  const ext = (c.externalId ?? '').toLowerCase();
  const tags = (c.tags ?? []).map((t) => String(t).toLowerCase());
  if (ext.startsWith('web-visitor:') || tags.includes('anonymous-visitor')) return 'INGESTION_WEB_VISITOR';
  const createdFrom = text(obj(c.metadata).createdFrom);
  if (createdFrom === 'callgrid') return 'INGESTION_CALL';
  if (createdFrom === 'website') return 'INGESTION_WEB_LEAD';
  if (createdFrom) return 'INGESTION_OTHER_SOURCE';
  if (['sic-demo-', 'demo-', 'e2e-', 'test-', 'qa-', 'hotfix-verify'].some((p) => ext.startsWith(p))) return 'SEED_OR_DEMO';
  if (ext) return 'EXTERNAL_IMPORT';
  return 'UNMARKED';
}

export function countBucket(n: number): CountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2_5';
  if (n <= 20) return '6_20';
  return '21_PLUS';
}

export function providerBucket(provider: string | null): ProviderBucket {
  if (!provider) return 'NONE';
  if (provider === 'callgrid') return 'CALLGRID';
  if (provider === 'website') return 'WEBSITE';
  return 'OTHER';
}

export function statusBucket(attributes: unknown): string {
  const s = text(obj(attributes).pipelineStatus);
  if (!s) return 'ABSENT';
  return (PIPELINE_STATUSES as readonly string[]).includes(s) ? s.toUpperCase() : 'OTHER';
}

export function workflowClass(trigger: string, triggerConfig: unknown): WorkflowClass {
  if (trigger === 'MANUAL') return 'MANUAL';
  if (trigger === 'SCHEDULE') return 'SCHEDULE';
  if (trigger !== 'EVENT') return 'OTHER';
  const eventName = text(obj(triggerConfig).eventName) ?? '';
  if (eventName.startsWith('integration.call.')) return 'EVENT_CALL';
  if (eventName.startsWith('integration.web.')) return 'EVENT_WEB';
  return 'EVENT_OTHER';
}

/** How a call on a Customer's timeline relates to that Customer's own phone. */
export function callAttachment(callerRaw: string | null, customerPhone: string | null): CallAttachment {
  if (!text(callerRaw)) return 'CALLER_ABSENT';
  const caller = phoneKey(callerRaw);
  if (!caller) return 'CALLER_WITHHELD';
  const own = phoneKey(customerPhone);
  if (!own) return 'CUSTOMER_NO_USABLE_PHONE';
  if (caller === own) return 'CALLER_EXACT';
  if (caller.slice(-7) === own.slice(-7)) return 'CALLER_LAST7_ONLY';
  return 'CALLER_DIFFERENT';
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The Monday (UTC) that starts the week containing `d`. */
export function weekOf(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return dayOf(day);
}

type Counts<K extends string> = Record<K, number>;

function zeroes<K extends string>(keys: readonly K[]): Counts<K> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Counts<K>;
}

function bump<K extends string>(counts: Counts<K>, key: K, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

// --- The result -----------------------------------------------------------------------

export interface PeoplePopulationAudit {
  asOf: string;
  slice1At: string;
  exceededBound: boolean;
  provenance: {
    customers: number;
    byClass: Counts<ProvenanceClass>;
    identifiers: Counts<'PHONE_ONLY' | 'EMAIL_ONLY' | 'BOTH' | 'NEITHER'>;
    namePresent: number;
    tags: Counts<'LEAD' | 'ANONYMOUS_VISITOR' | 'INBOUND_CALL' | 'MISSED_CALL' | 'EXCLUSION_MARKER' | 'OUTSIDE_INGESTION'>;
    mergedMarker: number;
    testOrDemoMarked: number;
    byMonth: Array<{ month: string; byClass: Counts<ProvenanceClass> }>;
  } | null;
  anonymousVisitors: {
    total: number;
    withName: number;
    withEmail: number;
    withPhone: number;
    byInteractionCount: Counts<CountBucket>;
    byStatus: Record<string, number>;
    withStrongHumanWork: number;
    withAnyHumanWork: number;
    partyLinked: number;
  } | null;
  withheldCallers: {
    phonePresent: number;
    byPhoneClass: Counts<PhoneClass>;
    placeholderPhones: number;
    withheld: number;
    byForm: Counts<WithheldForm>;
    withheldByClass: Counts<ProvenanceClass>;
    withheldByInteractionCount: Counts<CountBucket>;
    withheldWithStrongHumanWork: number;
  } | null;
  duplicatePhones: {
    sameNumberGroups: number;
    sameNumberRows: number;
    sameNumberGroupSizes: Counts<'2' | '3_5' | '6_10' | '11_PLUS'>;
    formatVariantGroups: number;
    last7CollisionGroups: number;
    last7CollisionRows: number;
    last7CollisionNumbers: number;
    sameEmailGroups: number;
    sameEmailRows: number;
  } | null;
  interactionAttachment: {
    interactions: number;
    attached: number;
    unattached: number;
    byProvider: Record<string, number>;
    notes: Counts<(typeof NOTE_KINDS)[number]> | null;
    customersByInteractionCount: Counts<CountBucket>;
    callAttachment: Counts<CallAttachment> | null;
    customersWithTwoOrMoreCallers: number | null;
    customersWithLast7OnlyCalls: number | null;
  } | null;
  humanWork: {
    bySignal: Counts<HumanSignal>;
    anySignal: number;
    strongSignal: number;
    weakOnly: number;
    noSignal: number;
    byClass: Array<{ cls: ProvenanceClass; total: number; strong: number; weakOnly: number; none: number }>;
  } | null;
  workflowDamage: {
    workflows: number;
    active: number;
    byClass: Counts<WorkflowClass>;
    activeByClass: Counts<WorkflowClass>;
    workflowsWithStep: Counts<(typeof STEP_BUCKETS)[number]>;
    workflowsSettingStatus: Counts<(typeof STATUS_STEP_BUCKETS)[number]>;
    runs: number | null;
    runsByStatus: Counts<(typeof RUN_STATUSES)[number]> | null;
    runsByWorkflowClass: Counts<WorkflowClass> | null;
    runsByMonth: Array<{ month: string; byStatus: Counts<(typeof RUN_STATUSES)[number]> }> | null;
    customersTouchedByCallWorkflows: number | null;
    touchedWithStrongHumanWork: number | null;
    likelyStatusOverwritten: number | null;
    customersWithWorkflowNotes: number | null;
    runsAfterSlice1: number | null;
  } | null;
  governance: {
    partiesEstablished: number;
    partiesEstablishedByBasis: Record<string, number>;
    partyTypedUnestablished: number;
    customerPartyLinks: number;
    activeLinks: number;
    reversedLinks: number;
    linksByBasis: Record<string, number>;
    customersWithActiveLink: number;
  };
  creationBursts: {
    daysWithIngestionCreations: number;
    maxDaily: number;
    p95Daily: number;
    medianDaily: number;
    topDays: Array<{
      day: string;
      customers: number;
      ingestionCustomers: number;
      eventsReceived: number;
      eventsBySource: Counts<(typeof OBSERVATION_BUCKETS)[number]>;
      eventsOccurredEarlier: number;
    }>;
    eventsScanComplete: boolean;
  } | null;
  slice1Exposure: {
    customersCreatedAfter: number;
    ingestionCustomersCreatedAfter: number;
    interactionsAfter: number | null;
    /** CallGrid or website interactions created after Slice 1 that carry a customer. */
    attachedProviderInteractionsAfter: number | null;
    workflowRunsAfter: number | null;
    excludedOnlyViaCustomer: Counts<ProviderBucket> | null;
    bookingsOnIngestionCustomers: number | null;
    ordersOnIngestionCustomers: number | null;
    peopleAddedByWeek: Array<{ week: string; ingestion: number; other: number }>;
  } | null;
}

// --- The reader ------------------------------------------------------------------------

type Where = Record<string, unknown>;
type Finder = { findMany(args: Record<string, unknown>): Promise<Array<Record<string, any>>> };

interface CustomerFacts {
  cls: ProvenanceClass;
  createdAt: Date;
  phone: string | null;
  email: string | null;
  hasName: boolean;
  tags: string[];
  status: string;
  rawStatus: string | null;
  assigned: boolean;
  merged: boolean;
  like: CustomerLike;
}

const WEEKS = 12;
const TOP_DAYS = 20;

export interface PeopleAuditOptions {
  /** Rows per page. Tests use a small page to exercise pagination. */
  pageSize?: number;
  bounds?: Partial<Record<keyof typeof AUDIT_BOUNDS, number>>;
}

export class PeoplePopulationAuditRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PeopleAuditOptions = {},
  ) {}

  private bound(name: keyof typeof AUDIT_BOUNDS): number {
    return this.options.bounds?.[name] ?? AUDIT_BOUNDS[name];
  }

  /**
   * Read `delegate` in id order, PAGE_SIZE rows at a time, calling `visit` for each
   * row until the table is exhausted (true) or `bound` rows were visited (false).
   */
  private async scan(
    delegate: Finder,
    where: Where,
    select: Record<string, true>,
    bound: number,
    visit: (row: Record<string, any>) => void,
  ): Promise<boolean> {
    const pageSize = this.options.pageSize ?? PAGE_SIZE;
    let lastId: string | null = null;
    let seen = 0;
    for (;;) {
      const page: Array<Record<string, any>> = await delegate.findMany({
        where: lastId === null ? where : { ...where, id: { gt: lastId } },
        select: { ...select, id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
      });
      for (const row of page) {
        if (seen >= bound) return false;
        visit(row);
        seen += 1;
      }
      if (page.length < pageSize) return true;
      lastId = String(page[page.length - 1]!.id);
    }
  }

  async audit(organizationId: string, asOf: Date, slice1At: Date): Promise<PeoplePopulationAudit> {
    const p = this.prisma as unknown as Record<string, Finder & { count(args: Record<string, unknown>): Promise<number> }>;
    const before = { organizationId, createdAt: { lt: asOf } };
    let exceededBound = false;
    const complete = (ok: boolean) => {
      if (!ok) exceededBound = true;
      return ok;
    };

    // ---- 1. Customers ------------------------------------------------------------
    const customers = new Map<string, CustomerFacts>();
    const customersComplete = complete(await this.scan(
      p.customer!,
      before,
      { externalId: true, firstName: true, lastName: true, email: true, phone: true, tags: true, attributes: true, metadata: true, createdAt: true },
      this.bound('customers'),
      (c) => {
        const attributes = obj(c.attributes);
        const metadata = obj(c.metadata);
        const tags: string[] = Array.isArray(c.tags) ? c.tags.map((t: unknown) => String(t)) : [];
        customers.set(String(c.id), {
          cls: provenanceClass({ externalId: c.externalId ?? null, tags, metadata }),
          createdAt: c.createdAt as Date,
          phone: text(c.phone),
          email: text(c.email),
          hasName: Boolean(text(c.firstName) || text(c.lastName)),
          tags,
          status: statusBucket(attributes),
          rawStatus: text(attributes.pipelineStatus),
          assigned: Boolean(text(attributes.assignedHumanName) || text(attributes.assignedAiName)),
          merged: Boolean(text(metadata.mergedInto)),
          like: { tags, email: c.email ?? null, phone: c.phone ?? null, externalId: c.externalId ?? null, firstName: c.firstName ?? null, lastName: c.lastName ?? null },
        });
      },
    ));

    // ---- 2. Records that depend on a Customer ----------------------------------------
    const interactionsPerCustomer = new Map<string, number>();
    const byProvider: Record<string, number> = {};
    let interactions = 0;
    let attached = 0;
    let interactionsAfter = 0;
    let attachedProviderInteractionsAfter = 0;
    const interactionsComplete = complete(await this.scan(
      p.interaction!,
      before,
      { customerId: true, provider: true, createdAt: true },
      this.bound('interactions'),
      (i) => {
        interactions += 1;
        const isAttached = typeof i.customerId === 'string';
        const key = `${providerBucket(i.provider ?? null)}_${isAttached ? 'ATTACHED' : 'UNATTACHED'}`;
        byProvider[key] = (byProvider[key] ?? 0) + 1;
        if (isAttached) {
          attached += 1;
          interactionsPerCustomer.set(i.customerId, (interactionsPerCustomer.get(i.customerId) ?? 0) + 1);
        }
        if ((i.createdAt as Date) >= slice1At) {
          interactionsAfter += 1;
          const fromProvider = i.provider === 'callgrid' || i.provider === 'website';
          if (isAttached && fromProvider) attachedProviderInteractionsAfter += 1;
        }
      },
    ));

    const notes = zeroes(NOTE_KINDS);
    const humanNoteCustomers = new Set<string>();
    const workflowNoteCustomers = new Set<string>();
    const notesComplete = complete(await this.scan(
      p.interaction!,
      { ...before, kind: 'NOTE' },
      { customerId: true, payload: true },
      this.bound('notes'),
      (n) => {
        const payload = obj(n.payload);
        const loopKind = text(payload.loopKind);
        const kind = loopKind === 'crm_note' || loopKind === 'human_note' ? 'HUMAN' : text(payload.source) === 'workflow' ? 'WORKFLOW' : 'OTHER';
        bump(notes, kind);
        if (typeof n.customerId === 'string') {
          if (kind === 'HUMAN') humanNoteCustomers.add(n.customerId);
          if (kind === 'WORKFLOW') workflowNoteCustomers.add(n.customerId);
        }
      },
    ));

    const withCustomer = (delegate: Finder, bound: number) => {
      const ids = new Set<string>();
      const counts = new Map<string, number>();
      return this.scan(delegate, { ...before, customerId: { not: null } }, { customerId: true }, bound, (r) => {
        ids.add(r.customerId);
        counts.set(r.customerId, (counts.get(r.customerId) ?? 0) + 1);
      }).then((ok) => ({ ok: complete(ok), ids, counts }));
    };
    const conversations = await withCustomer(p.conversation!, this.bound('dependents'));
    const bookings = await withCustomer(p.booking!, this.bound('dependents'));
    const orders = await withCustomer(p.order!, this.bound('dependents'));
    const serviceRequests = await withCustomer(p.serviceRequest!, this.bound('dependents'));

    const humanAuditCustomers = new Set<string>();
    const auditComplete = complete(await this.scan(
      p.auditLog!,
      { ...before, entityType: 'customer', userId: { not: null } },
      { entityId: true },
      this.bound('auditEntries'),
      (a) => {
        if (typeof a.entityId === 'string') humanAuditCustomers.add(a.entityId);
      },
    ));

    const linksByBasis: Record<string, number> = {};
    const activeLinkCustomers = new Set<string>();
    const anyLinkCustomers = new Set<string>();
    let customerPartyLinks = 0;
    let reversedLinks = 0;
    const linksComplete = complete(await this.scan(
      p.customerPartyLink!,
      before,
      { customerId: true, basis: true, reversedAt: true },
      this.bound('partyLinks'),
      (l) => {
        customerPartyLinks += 1;
        linksByBasis[String(l.basis)] = (linksByBasis[String(l.basis)] ?? 0) + 1;
        anyLinkCustomers.add(l.customerId);
        if (l.reversedAt) reversedLinks += 1;
        else activeLinkCustomers.add(l.customerId);
      },
    ));

    // ---- 3. Human work, per Customer ------------------------------------------------------
    // Every signal source must have been read in full, or "no human work" would be
    // an undercount presented as an answer.
    const humanComplete = notesComplete && auditComplete && linksComplete &&
      conversations.ok && bookings.ok && orders.ok && serviceRequests.ok;
    const human = new Map<string, { strong: boolean; any: boolean }>();
    const bySignal = zeroes<HumanSignal>([...STRONG_HUMAN_SIGNALS, ...WEAK_HUMAN_SIGNALS]);
    for (const [id, c] of customers) {
      const strong: HumanSignal[] = [];
      if (conversations.ids.has(id)) strong.push('CONVERSATION');
      if (bookings.ids.has(id)) strong.push('BOOKING');
      if (orders.ids.has(id)) strong.push('ORDER');
      if (serviceRequests.ids.has(id)) strong.push('SERVICE_REQUEST');
      if (humanNoteCustomers.has(id)) strong.push('HUMAN_NOTE');
      if (humanAuditCustomers.has(id)) strong.push('HUMAN_AUDIT');
      if (anyLinkCustomers.has(id)) strong.push('PARTY_LINK');
      if (c.merged) strong.push('MERGED');
      const weak: HumanSignal[] = [];
      if (c.hasName) weak.push('NAME_SET');
      if (c.rawStatus && !WORKFLOW_DEFAULT_STATUSES.has(c.rawStatus)) weak.push('STATUS_BEYOND_CONTACTED');
      if (c.assigned) weak.push('ASSIGNED');
      if (c.tags.some((t) => !INGESTION_TAG_SET.has(t.toLowerCase()))) weak.push('TAG_OUTSIDE_INGESTION');
      for (const s of [...strong, ...weak]) bump(bySignal, s);
      human.set(id, { strong: strong.length > 0, any: strong.length + weak.length > 0 });
    }

    // ---- 4. Attached CallGrid and website interactions, with their metadata ---------------
    const callAttachmentCounts = zeroes(CALL_ATTACHMENTS);
    const callersPerCustomer = new Map<string, Set<string>>();
    const last7OnlyCustomers = new Set<string>();
    const excludedOnlyViaCustomer = zeroes(PROVIDER_BUCKETS);
    const providerScanComplete = complete(await this.scan(
      p.interaction!,
      { ...before, customerId: { not: null }, provider: { in: ['callgrid', 'website'] } },
      { customerId: true, provider: true, channel: true, externalId: true, metadata: true },
      this.bound('attachedProviderInteractions'),
      (i) => {
        const c = customers.get(i.customerId);
        if (!c) return;
        const metadata = obj(i.metadata);
        if (isExcludedCustomer(c.like) && !isExcludedInteraction({ externalId: i.externalId ?? null, metadata })) {
          bump(excludedOnlyViaCustomer, providerBucket(i.provider ?? null));
        }
        if (i.provider !== 'callgrid' || i.channel !== 'PHONE') return;
        const callerRaw = CALLER_KEYS.map((k) => text(metadata[k])).find((v) => v !== null) ?? null;
        const kind = callAttachment(callerRaw, c.phone);
        bump(callAttachmentCounts, kind);
        if (kind === 'CALLER_LAST7_ONLY') last7OnlyCustomers.add(i.customerId);
        const caller = phoneKey(callerRaw);
        if (caller) {
          const set = callersPerCustomer.get(i.customerId) ?? new Set<string>();
          set.add(caller);
          callersPerCustomer.set(i.customerId, set);
        }
      },
    ));

    // ---- 5. Workflows and their runs -------------------------------------------------------
    const workflowClassById = new Map<string, WorkflowClass>();
    const workflowHasCustomerStep = new Map<string, boolean>();
    const wfByClass = zeroes(WORKFLOW_CLASSES);
    const wfActiveByClass = zeroes(WORKFLOW_CLASSES);
    const workflowsWithStep = zeroes(STEP_BUCKETS);
    const workflowsSettingStatus = zeroes(STATUS_STEP_BUCKETS);
    let workflows = 0;
    let activeWorkflows = 0;
    complete(await this.scan(
      p.workflow!,
      before,
      { trigger: true, isActive: true, triggerConfig: true, definition: true },
      this.bound('workflows'),
      (w) => {
        workflows += 1;
        const cls = workflowClass(String(w.trigger), w.triggerConfig);
        workflowClassById.set(String(w.id), cls);
        bump(wfByClass, cls);
        if (w.isActive) {
          activeWorkflows += 1;
          bump(wfActiveByClass, cls);
        }
        const steps = Array.isArray(obj(w.definition).steps) ? (obj(w.definition).steps as unknown[]) : [];
        const stepKinds = new Set<(typeof STEP_BUCKETS)[number]>();
        const statusKinds = new Set<(typeof STATUS_STEP_BUCKETS)[number]>();
        for (const raw of steps) {
          const step = obj(raw);
          const type = text(step.type)?.toUpperCase() ?? '';
          stepKinds.add((STEP_BUCKETS as readonly string[]).includes(type) ? (type as (typeof STEP_BUCKETS)[number]) : 'OTHER');
          if (type === 'SET_PIPELINE_STATUS') {
            const status = text(obj(step.config).status);
            statusKinds.add(status === 'New' ? 'SETS_NEW' : status === 'Contacted' ? 'SETS_CONTACTED' : status && (PIPELINE_STATUSES as readonly string[]).includes(status) ? 'SETS_BEYOND_CONTACTED' : 'SETS_OTHER');
          }
        }
        for (const k of stepKinds) bump(workflowsWithStep, k);
        for (const k of statusKinds) bump(workflowsSettingStatus, k);
        workflowHasCustomerStep.set(String(w.id), ['ADD_TAG', 'SET_PIPELINE_STATUS', 'ASSIGN', 'CREATE_NOTE'].some((k) => stepKinds.has(k as never)));
      },
    ));

    const runsByStatus = zeroes(RUN_STATUSES);
    const runsByWorkflowClass = zeroes(WORKFLOW_CLASSES);
    const runsByMonth = new Map<string, Counts<(typeof RUN_STATUSES)[number]>>();
    const touchedByCallWorkflows = new Set<string>();
    let runs = 0;
    let runsAfterSlice1 = 0;
    const runsComplete = complete(await this.scan(
      p.workflowRun!,
      before,
      { workflowId: true, status: true, createdAt: true, input: true },
      this.bound('workflowRuns'),
      (r) => {
        runs += 1;
        const status = (RUN_STATUSES as readonly string[]).includes(String(r.status)) ? (String(r.status) as (typeof RUN_STATUSES)[number]) : 'PENDING';
        bump(runsByStatus, status);
        const cls = workflowClassById.get(String(r.workflowId)) ?? 'OTHER';
        bump(runsByWorkflowClass, cls);
        const month = monthOf(r.createdAt as Date);
        const m = runsByMonth.get(month) ?? zeroes(RUN_STATUSES);
        bump(m, status);
        runsByMonth.set(month, m);
        if ((r.createdAt as Date) >= slice1At) runsAfterSlice1 += 1;
        // A FAILED run still ran every step before and after the one that failed,
        // so it may have written to the Customer as well.
        const customerId = text(obj(obj(r.input).context).customerId);
        const ran = status === 'SUCCEEDED' || status === 'FAILED';
        if (customerId && cls === 'EVENT_CALL' && ran && workflowHasCustomerStep.get(String(r.workflowId))) {
          touchedByCallWorkflows.add(customerId);
        }
      },
    ));

    // ---- 6. Integration events, for creation bursts -----------------------------------------
    const eventsByDay = new Map<string, { received: number; bySource: Counts<(typeof OBSERVATION_BUCKETS)[number]>; earlier: number }>();
    const eventsComplete = complete(await this.scan(
      p.integrationEvent!,
      before,
      { receivedAt: true, occurredAt: true, firstIngestionSource: true },
      this.bound('integrationEvents'),
      (e) => {
        const day = dayOf(e.receivedAt as Date);
        const d = eventsByDay.get(day) ?? { received: 0, bySource: zeroes(OBSERVATION_BUCKETS), earlier: 0 };
        d.received += 1;
        const src = text(e.firstIngestionSource);
        bump(d.bySource, !src ? 'NONE' : (OBSERVATION_SOURCES as readonly string[]).includes(src) ? (src as (typeof OBSERVATION_BUCKETS)[number]) : 'OTHER');
        if (e.occurredAt && dayOf(e.occurredAt as Date) < day) d.earlier += 1;
        eventsByDay.set(day, d);
      },
    ));

    // ---- 7. Identity governance baseline (counts only) --------------------------------------
    const PARTY_TYPES = { in: ['PERSON', 'COMPANY'] };
    const [partiesEstablished, partyTypedUnestablished, establishedManual, establishedExplicit] = await Promise.all([
      p.cognitiveIdentity!.count({ where: { organizationId, entityType: PARTY_TYPES, establishedAt: { not: null } } }),
      p.cognitiveIdentity!.count({ where: { organizationId, entityType: PARTY_TYPES, establishedAt: null } }),
      p.cognitiveIdentity!.count({ where: { organizationId, entityType: PARTY_TYPES, establishmentBasis: 'MANUAL' } }),
      p.cognitiveIdentity!.count({ where: { organizationId, entityType: PARTY_TYPES, establishmentBasis: 'EXPLICIT_LINK' } }),
    ]);

    // ---- Assemble ------------------------------------------------------------------------------
    const governance: PeoplePopulationAudit['governance'] = {
      partiesEstablished,
      partiesEstablishedByBasis: { MANUAL: establishedManual, EXPLICIT_LINK: establishedExplicit },
      partyTypedUnestablished,
      customerPartyLinks,
      activeLinks: customerPartyLinks - reversedLinks,
      reversedLinks,
      linksByBasis,
      customersWithActiveLink: activeLinkCustomers.size,
    };

    // Every other section is built on the Customer read. Without all of it, none of
    // them can say anything true, so all of them are UNKNOWN.
    if (!customersComplete) {
      return {
        asOf: asOf.toISOString(),
        slice1At: slice1At.toISOString(),
        exceededBound: true,
        provenance: null,
        anonymousVisitors: null,
        withheldCallers: null,
        duplicatePhones: null,
        interactionAttachment: null,
        humanWork: null,
        workflowDamage: null,
        governance,
        creationBursts: null,
        slice1Exposure: null,
      };
    }

    const byClass = zeroes(PROVENANCE_CLASSES);
    const identifiers = zeroes(['PHONE_ONLY', 'EMAIL_ONLY', 'BOTH', 'NEITHER'] as const);
    const tags = zeroes(['LEAD', 'ANONYMOUS_VISITOR', 'INBOUND_CALL', 'MISSED_CALL', 'EXCLUSION_MARKER', 'OUTSIDE_INGESTION'] as const);
    const months = new Map<string, Counts<ProvenanceClass>>();
    let namePresent = 0;
    let mergedMarker = 0;
    let testOrDemoMarked = 0;

    const visitors = { total: 0, withName: 0, withEmail: 0, withPhone: 0, byInteractionCount: zeroes(COUNT_BUCKETS), byStatus: {} as Record<string, number>, withStrongHumanWork: 0, withAnyHumanWork: 0, partyLinked: 0 };
    const withheld = { phonePresent: 0, byPhoneClass: zeroes(PHONE_CLASSES), placeholderPhones: 0, withheld: 0, byForm: zeroes(WITHHELD_FORMS), withheldByClass: zeroes(PROVENANCE_CLASSES), withheldByInteractionCount: zeroes(COUNT_BUCKETS), withheldWithStrongHumanWork: 0 };
    const numbers = new Map<string, { rows: number; formats: Set<string> }>();
    const emails = new Map<string, number>();
    const createdByDay = new Map<string, { all: number; ingestion: number }>();
    const peopleAddedByWeek = new Map<string, { ingestion: number; other: number }>();
    const humanByClass = new Map<ProvenanceClass, { total: number; strong: number; weakOnly: number; none: number }>();
    let customersCreatedAfter = 0;
    let ingestionCustomersCreatedAfter = 0;
    let bookingsOnIngestion = 0;
    let ordersOnIngestion = 0;
    let likelyStatusOverwritten = 0;
    const weekFloor = weekOf(new Date(asOf.getTime() - (WEEKS - 1) * 7 * 86_400_000));

    for (const [id, c] of customers) {
      const h = human.get(id)!;
      const ingestion = INGESTION_CLASSES.has(c.cls);
      bump(byClass, c.cls);
      const month = months.get(monthOf(c.createdAt)) ?? zeroes(PROVENANCE_CLASSES);
      bump(month, c.cls);
      months.set(monthOf(c.createdAt), month);
      bump(identifiers, c.phone && c.email ? 'BOTH' : c.phone ? 'PHONE_ONLY' : c.email ? 'EMAIL_ONLY' : 'NEITHER');
      if (c.hasName) namePresent += 1;
      if (c.merged) mergedMarker += 1;
      if (isExcludedCustomer(c.like)) testOrDemoMarked += 1;
      const lowerTags = c.tags.map((t) => t.toLowerCase());
      if (lowerTags.includes('lead')) bump(tags, 'LEAD');
      if (lowerTags.includes('anonymous-visitor')) bump(tags, 'ANONYMOUS_VISITOR');
      if (lowerTags.includes('inbound-call')) bump(tags, 'INBOUND_CALL');
      if (lowerTags.includes('missed-call')) bump(tags, 'MISSED_CALL');
      if (lowerTags.some((t) => EXCLUSION_TAGS.has(t))) bump(tags, 'EXCLUSION_MARKER');
      if (lowerTags.some((t) => !INGESTION_TAG_SET.has(t))) bump(tags, 'OUTSIDE_INGESTION');

      const count = interactionsPerCustomer.get(id) ?? 0;
      if (c.cls === 'INGESTION_WEB_VISITOR') {
        visitors.total += 1;
        if (c.hasName) visitors.withName += 1;
        if (c.email) visitors.withEmail += 1;
        if (c.phone) visitors.withPhone += 1;
        bump(visitors.byInteractionCount, countBucket(count));
        visitors.byStatus[c.status] = (visitors.byStatus[c.status] ?? 0) + 1;
        if (h.strong) visitors.withStrongHumanWork += 1;
        if (h.any) visitors.withAnyHumanWork += 1;
        if (anyLinkCustomers.has(id)) visitors.partyLinked += 1;
      }

      const pc = phoneClass(c.phone);
      bump(withheld.byPhoneClass, pc);
      if (pc !== 'ABSENT') withheld.phonePresent += 1;
      if (isPlaceholderPhone(c.phone)) withheld.placeholderPhones += 1;
      if (pc === 'NO_DIGITS' || pc === 'SHORT_DIGITS') {
        withheld.withheld += 1;
        bump(withheld.byForm, withheldForm(c.phone));
        bump(withheld.withheldByClass, c.cls);
        bump(withheld.withheldByInteractionCount, countBucket(count));
        if (h.strong) withheld.withheldWithStrongHumanWork += 1;
      }

      const key = phoneKey(c.phone);
      if (key) {
        const n = numbers.get(key) ?? { rows: 0, formats: new Set<string>() };
        n.rows += 1;
        n.formats.add(c.phone!);
        numbers.set(key, n);
      }
      if (c.email) emails.set(c.email.toLowerCase(), (emails.get(c.email.toLowerCase()) ?? 0) + 1);

      const day = dayOf(c.createdAt);
      const d = createdByDay.get(day) ?? { all: 0, ingestion: 0 };
      d.all += 1;
      if (ingestion) d.ingestion += 1;
      createdByDay.set(day, d);
      const week = weekOf(c.createdAt);
      if (week >= weekFloor) {
        const w = peopleAddedByWeek.get(week) ?? { ingestion: 0, other: 0 };
        if (ingestion) w.ingestion += 1;
        else w.other += 1;
        peopleAddedByWeek.set(week, w);
      }
      if (c.createdAt >= slice1At) {
        customersCreatedAfter += 1;
        if (ingestion) ingestionCustomersCreatedAfter += 1;
      }
      if (ingestion) {
        bookingsOnIngestion += bookings.counts.get(id) ?? 0;
        ordersOnIngestion += orders.counts.get(id) ?? 0;
      }
      const hc = humanByClass.get(c.cls) ?? { total: 0, strong: 0, weakOnly: 0, none: 0 };
      hc.total += 1;
      if (h.strong) hc.strong += 1;
      else if (h.any) hc.weakOnly += 1;
      else hc.none += 1;
      humanByClass.set(c.cls, hc);
      const callTagged = lowerTags.includes('inbound-call') || lowerTags.includes('missed-call');
      if (h.strong && callTagged && (c.rawStatus === 'New' || c.rawStatus === 'Contacted')) likelyStatusOverwritten += 1;
    }

    const provenance: NonNullable<PeoplePopulationAudit['provenance']> = {
      customers: customers.size,
      byClass,
      identifiers,
      namePresent,
      tags,
      mergedMarker,
      testOrDemoMarked,
      byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, counts]) => ({ month, byClass: counts })),
    };

    const sameNumber = [...numbers.values()].filter((n) => n.rows > 1);
    const sizes = zeroes(['2', '3_5', '6_10', '11_PLUS'] as const);
    for (const g of sameNumber) bump(sizes, g.rows === 2 ? '2' : g.rows <= 5 ? '3_5' : g.rows <= 10 ? '6_10' : '11_PLUS');
    const last7 = new Map<string, { numbers: number; rows: number }>();
    for (const [key, n] of numbers) {
      const l = last7.get(key.slice(-7)) ?? { numbers: 0, rows: 0 };
      l.numbers += 1;
      l.rows += n.rows;
      last7.set(key.slice(-7), l);
    }
    const collisions = [...last7.values()].filter((l) => l.numbers > 1);
    const sameEmail = [...emails.values()].filter((n) => n > 1);
    const duplicatePhones: NonNullable<PeoplePopulationAudit['duplicatePhones']> = {
      sameNumberGroups: sameNumber.length,
      sameNumberRows: sameNumber.reduce((a, g) => a + g.rows, 0),
      sameNumberGroupSizes: sizes,
      formatVariantGroups: sameNumber.filter((g) => g.formats.size > 1).length,
      last7CollisionGroups: collisions.length,
      last7CollisionRows: collisions.reduce((a, l) => a + l.rows, 0),
      last7CollisionNumbers: collisions.reduce((a, l) => a + l.numbers, 0),
      sameEmailGroups: sameEmail.length,
      sameEmailRows: sameEmail.reduce((a, n) => a + n, 0),
    };

    let strongCount = 0;
    let weakOnly = 0;
    let none = 0;
    for (const h of human.values()) {
      if (h.strong) strongCount += 1;
      else if (h.any) weakOnly += 1;
      else none += 1;
    }
    const humanWork: NonNullable<PeoplePopulationAudit['humanWork']> = {
      bySignal,
      anySignal: strongCount + weakOnly,
      strongSignal: strongCount,
      weakOnly,
      noSignal: none,
      byClass: PROVENANCE_CLASSES.map((cls) => ({ cls, ...(humanByClass.get(cls) ?? { total: 0, strong: 0, weakOnly: 0, none: 0 }) })),
    };

    const ingestionDaily = [...createdByDay.values()].map((d) => d.ingestion).filter((n) => n > 0).sort((a, b) => a - b);
    const pct = (q: number) => (ingestionDaily.length ? ingestionDaily[Math.min(ingestionDaily.length - 1, Math.floor(q * ingestionDaily.length))]! : 0);
    const creationBursts: NonNullable<PeoplePopulationAudit['creationBursts']> = {
      daysWithIngestionCreations: ingestionDaily.length,
      maxDaily: ingestionDaily.length ? ingestionDaily[ingestionDaily.length - 1]! : 0,
      p95Daily: pct(0.95),
      medianDaily: pct(0.5),
      topDays: [...createdByDay.entries()]
        .filter(([, d]) => d.ingestion > 0)
        .sort(([da, a], [db, b]) => b.ingestion - a.ingestion || da.localeCompare(db))
        .slice(0, TOP_DAYS)
        .map(([day, d]) => {
          const e = eventsByDay.get(day);
          return {
            day,
            customers: d.all,
            ingestionCustomers: d.ingestion,
            eventsReceived: e?.received ?? 0,
            eventsBySource: e?.bySource ?? zeroes(OBSERVATION_BUCKETS),
            eventsOccurredEarlier: e?.earlier ?? 0,
          };
        }),
      eventsScanComplete: eventsComplete,
    };

    const slice1Exposure: NonNullable<PeoplePopulationAudit['slice1Exposure']> = {
      customersCreatedAfter,
      ingestionCustomersCreatedAfter,
      interactionsAfter: interactionsComplete ? interactionsAfter : null,
      attachedProviderInteractionsAfter: interactionsComplete ? attachedProviderInteractionsAfter : null,
      workflowRunsAfter: runsComplete ? runsAfterSlice1 : null,
      excludedOnlyViaCustomer: providerScanComplete ? excludedOnlyViaCustomer : null,
      bookingsOnIngestionCustomers: bookings.ok ? bookingsOnIngestion : null,
      ordersOnIngestionCustomers: orders.ok ? ordersOnIngestion : null,
      peopleAddedByWeek: [...peopleAddedByWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({ week, ...w })),
    };

    const customersByInteractionCount = zeroes(COUNT_BUCKETS);
    for (const id of customers.keys()) bump(customersByInteractionCount, countBucket(interactionsPerCustomer.get(id) ?? 0));
    const interactionAttachment: PeoplePopulationAudit['interactionAttachment'] = interactionsComplete
      ? {
          interactions,
          attached,
          unattached: interactions - attached,
          byProvider,
          notes: notesComplete ? notes : null,
          customersByInteractionCount,
          callAttachment: providerScanComplete ? callAttachmentCounts : null,
          customersWithTwoOrMoreCallers: providerScanComplete ? [...callersPerCustomer.values()].filter((s) => s.size > 1).length : null,
          customersWithLast7OnlyCalls: providerScanComplete ? last7OnlyCustomers.size : null,
        }
      : null;

    const workflowDamage: PeoplePopulationAudit['workflowDamage'] = {
      workflows,
      active: activeWorkflows,
      byClass: wfByClass,
      activeByClass: wfActiveByClass,
      workflowsWithStep,
      workflowsSettingStatus,
      runs: runsComplete ? runs : null,
      runsByStatus: runsComplete ? runsByStatus : null,
      runsByWorkflowClass: runsComplete ? runsByWorkflowClass : null,
      runsByMonth: runsComplete ? [...runsByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, byStatus]) => ({ month, byStatus })) : null,
      customersTouchedByCallWorkflows: runsComplete ? [...touchedByCallWorkflows].filter((id) => customers.has(id)).length : null,
      touchedWithStrongHumanWork: runsComplete && humanComplete ? [...touchedByCallWorkflows].filter((id) => human.get(id)?.strong).length : null,
      likelyStatusOverwritten: humanComplete ? likelyStatusOverwritten : null,
      customersWithWorkflowNotes: notesComplete ? workflowNoteCustomers.size : null,
      runsAfterSlice1: runsComplete ? runsAfterSlice1 : null,
    };

    return {
      asOf: asOf.toISOString(),
      slice1At: slice1At.toISOString(),
      exceededBound,
      provenance,
      // Interaction counts per Customer come from the interaction read; without all
      // of it these two sections cannot be stated.
      anonymousVisitors: interactionsComplete && humanComplete ? visitors : null,
      withheldCallers: interactionsComplete && humanComplete ? withheld : null,
      duplicatePhones,
      interactionAttachment,
      humanWork: humanComplete ? humanWork : null,
      workflowDamage,
      governance,
      creationBursts,
      slice1Exposure,
    };
  }
}
