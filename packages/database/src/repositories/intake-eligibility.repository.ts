// Intake eligibility -- which Intake Records are operational intake work. Loop Intelligence, 2026-09-29.
//
// A CUSTOMER ROW IS NOT INTAKE WORK. Production proved it: 24,579 of 24,590 Intake Records were created by the
// retired automatic ingestion (one per unmatched CallGrid caller, metadata.createdFrom = 'callgrid'), carried
// the New or Contacted status that ingestion and its seeded call workflows wrote, had never been touched by a
// person, and read as 24,575 "stalled" records -- because `lastSeenAt` never moves. So a record is intake
// only when a GOVERNED ENTRY FACT exists:
//
//   WEB_LEAD     the retired creator's verified mark of a website form submission (metadata.createdFrom =
//                'website', not an anonymous visitor): a person asked to be contacted. Entered at the time of
//                that submission -- the earliest website FORM_SUBMISSION the creator attached to the record --
//                and at the creator's createdAt only when no such interaction exists. Never lastSeenAt.
//   HUMAN_WORK   an explicit act of work by a signed-in person, each attributed and timestamped:
//                  HUMAN_NOTE      a CRM note written by a HUMAN_AGENT (interactions, loopKind crm_note, no
//                                  provider -- an integration's interaction can never pose as one)
//                  STATUS_CHANGE   an intake status set by a person (audit customer.status_changed, HUMAN_AGENT)
//                  PARTY_LINK      a Party link made or reversed by a user (customer_party_links)
//                AND THE ACTOR MUST BE A HUMAN OPERATOR OF THIS ORGANIZATION: a user holding a membership here
//                with a human role (OWNER, ADMIN, MANAGER, EMPLOYEE, READ_ONLY). An AI employee's login, a
//                creator, an unknown or service role, a user of another organization, or no actor at all never
//                qualifies -- whatever a payload or an audit row claims. Entered at the first such act.
//
// NOT ELIGIBLE, BY DESIGN: verified CallGrid ingestion and anonymous-visitor records; records whose origin
// is heuristic or unknown (fail closed); an ASSIGNMENT alone (routing is audited, but it is not evidence that
// anyone began the work); a status written by a workflow or by ingestion (system, not a person). Nothing here
// deletes, archives or changes a record: a record that is not eligible simply is not counted as intake.
//
// THE CLOCK IS WORK, NOT `lastSeenAt`. lastWorkedAt = the latest HUMAN_WORK act; a record's clock is
// lastWorkedAt, or its entry time if nobody has worked it yet. A working record is STALLED when its clock is
// older than 14 days (exactly 14 days is not stalled). `lastSeenAt` is never read. An act dated more than five
// minutes in the future is malformed and ignored (fail closed); one within that clock-skew allowance counts as
// now, so a skewed clock can never keep a record fresh.
//
// STATUS. An explicit, known status applies once a record is eligible. A missing or unrecognised one reads as
// New ONLY for a WEB_LEAD (a submitted lead awaits first contact); otherwise it is UNSET -- never New.
//
// READ-ONLY, ONE ORGANIZATION. Every read is scoped by the organization and paged by id; the answer says
// `complete: false` rather than present a partial count as a whole one. Record ids stay inside the database
// package: surfaces get counts and (for the board) the eligible cards only.

import type { Prisma, PrismaClient } from '@prisma/client';

import { PIPELINE_STATUSES, type PipelineStatus } from './pipeline-status';

const DAY = 24 * 60 * 60 * 1000;
export const INTAKE_STALE_DAYS = 14;
const PAGE = 2_000;
const CHUNK = 1_000;
/** Rows any one evidence read may page through before it stops and says so. */
export const INTAKE_MAX_ROWS = 500_000;
/** Clock skew tolerated on an act's timestamp; beyond it the act is malformed and ignored. */
export const INTAKE_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** The roles whose acts are a person's work. Everything else -- AI_EMPLOYEE, CREATOR, anything unknown -- is not. */
export const HUMAN_OPERATOR_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const ACTOR_CHUNK = 200;

/** The audit actions the CRM writes for a person's intake edits. Only the status change is work. */
export const CUSTOMER_STATUS_CHANGED = 'customer.status_changed';
export const CUSTOMER_ASSIGNMENT_CHANGED = 'customer.assignment_changed';

export const INTAKE_STATUSES = [...PIPELINE_STATUSES, 'UNSET'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];
export const INTAKE_WORKING: readonly PipelineStatus[] = Object.freeze(['New', 'Contacted', 'Quoted']);
export type IntakeBasis = 'WEB_LEAD' | 'HUMAN_WORK';
export const INTAKE_WORK_EVENTS = ['HUMAN_NOTE', 'STATUS_CHANGE', 'PARTY_LINK'] as const;
export type IntakeWorkEvent = (typeof INTAKE_WORK_EVENTS)[number];

/** One eligible Intake Record. INTERNAL to the database package (it carries the record id). */
export interface IntakeRecord {
  readonly id: string;
  /** WEB_LEAD when the verified lead mark exists (even if it was also worked); otherwise HUMAN_WORK. */
  readonly basis: IntakeBasis;
  readonly workEvents: readonly IntakeWorkEvent[];
  readonly status: IntakeStatus;
  readonly enteredAt: Date;
  readonly lastWorkedAt: Date | null;
  /** lastWorkedAt, or enteredAt when nobody has worked it yet. */
  readonly clockAt: Date;
  readonly stalled: boolean;
}

export interface IntakeRead {
  readonly complete: boolean;
  /** Every Intake Record in the organization, eligible or not. */
  readonly totalRecords: number;
  readonly records: readonly IntakeRecord[];
}

/** What a surface may show: counts only. */
export interface IntakeCounts {
  readonly complete: boolean;
  readonly totalRecords: number;
  readonly eligible: number;
  /** Records that are not intake: not a verified lead, and nobody has worked them. */
  readonly excluded: number;
  readonly byStatus: Readonly<Record<IntakeStatus, number>>;
  readonly byBasis: Readonly<Record<IntakeBasis, number>>;
  /** Eligible records in New, Contacted or Quoted. */
  readonly working: number;
  /** Working records whose clock is older than 14 days, per working status. */
  readonly stalled: Readonly<Record<'New' | 'Contacted' | 'Quoted', number>>;
}

/**
 * PURE. The status an eligible record reads as: an explicit known status; else New for a web lead; else UNSET.
 */
export function intakeStatusOf(raw: unknown, basis: IntakeBasis): IntakeStatus {
  if (typeof raw === 'string' && (PIPELINE_STATUSES as readonly string[]).includes(raw)) return raw as PipelineStatus;
  return basis === 'WEB_LEAD' ? 'New' : 'UNSET';
}

/** PURE. Counts from records. */
export function intakeCountsOf(read: IntakeRead): IntakeCounts {
  const byStatus = Object.fromEntries(INTAKE_STATUSES.map((s) => [s, 0])) as Record<IntakeStatus, number>;
  const byBasis: Record<IntakeBasis, number> = { WEB_LEAD: 0, HUMAN_WORK: 0 };
  const stalled = { New: 0, Contacted: 0, Quoted: 0 };
  let working = 0;
  for (const r of read.records) {
    byStatus[r.status] += 1;
    byBasis[r.basis] += 1;
    if ((INTAKE_WORKING as readonly string[]).includes(r.status)) {
      working += 1;
      if (r.stalled) stalled[r.status as 'New' | 'Contacted' | 'Quoted'] += 1;
    }
  }
  return { complete: read.complete, totalRecords: read.totalRecords, eligible: read.records.length, excluded: read.totalRecords - read.records.length, byStatus, byBasis, working, stalled };
}

type Row = { id: string } & Record<string, unknown>;
interface Finder {
  findMany(args: { where: unknown; select: Record<string, boolean>; orderBy: { id: 'asc' }; take: number }): Promise<Row[]>;
}

export class IntakeEligibilityRepository {
  constructor(private readonly prisma: PrismaClient, private readonly opts: { readonly maxRows?: number } = {}) {}

  /** Page a read by id to its end (or its bound), handing each row to `onRow`. */
  private async page(delegate: Finder, where: Record<string, unknown>, select: Record<string, boolean>, onRow: (row: Row) => void): Promise<boolean> {
    let after: string | undefined;
    let read = 0;
    for (;;) {
      const rows = await delegate.findMany({ where: after ? { AND: [where, { id: { gt: after } }] } : where, select: { id: true, ...select }, orderBy: { id: 'asc' }, take: PAGE });
      for (const r of rows) onRow(r);
      read += rows.length;
      if (rows.length < PAGE) return true;
      if (read >= (this.opts.maxRows ?? INTAKE_MAX_ROWS)) return false;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** The organization's eligible Intake Records. INTERNAL: carries ids. */
  async read(organizationId: string, now: Date): Promise<IntakeRead> {
    const org = { organizationId };
    let complete = true;
    const latestAllowed = now.getTime() + INTAKE_FUTURE_SKEW_MS;
    /** An act's time, clamped to now within the skew allowance; null when it is malformed (future) or absent. */
    const actTime = (at: unknown): Date | null => {
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
      if (at.getTime() > latestAllowed) return null;
      return at.getTime() > now.getTime() ? now : at;
    };
    const work = new Map<string, { events: Set<IntakeWorkEvent>; first: Date; last: Date }>();
    const worked = (customerId: unknown, event: IntakeWorkEvent, rawAt: unknown) => {
      const at = actTime(rawAt);
      if (typeof customerId !== 'string' || !at) return;
      const w = work.get(customerId);
      if (!w) work.set(customerId, { events: new Set([event]), first: at, last: at });
      else {
        w.events.add(event);
        if (at < w.first) w.first = at;
        if (at > w.last) w.last = at;
      }
    };

    // The people whose acts are work: human operator members of THIS organization (any membership status --
    // an act by someone since deactivated was still a person's work).
    const members = await this.prisma.organizationMembership.findMany({ where: { ...org, systemRole: { in: [...HUMAN_OPERATOR_ROLES] } }, select: { userId: true } });
    const humans = [...new Set(members.map((m) => m.userId))];
    const humanSet = new Set(humans);

    for (let i = 0; i < humans.length; i += ACTOR_CHUNK) {
      const actors = humans.slice(i, i + ACTOR_CHUNK);
      // HUMAN_NOTE: a CRM note by a person -- written through the CRM (no provider), by a human operator here.
      if (!(await this.page(
        this.prisma.interaction as unknown as Finder,
        { ...org, kind: 'NOTE', provider: null, customerId: { not: null }, AND: [{ payload: { path: ['loopKind'], equals: 'crm_note' } }, { payload: { path: ['actorType'], equals: 'HUMAN_AGENT' } }, { OR: actors.map((id) => ({ payload: { path: ['actorUserId'], equals: id } })) }] },
        { customerId: true, occurredAt: true },
        (r) => worked(r.customerId, 'HUMAN_NOTE', r.occurredAt),
      ))) complete = false;
      // STATUS_CHANGE: an intake status a person set (the audit the CRM writes; workflows write none).
      if (!(await this.page(
        this.prisma.auditLog as unknown as Finder,
        { ...org, entityType: 'customer', action: CUSTOMER_STATUS_CHANGED, actorType: 'HUMAN_AGENT', userId: { in: actors }, entityId: { not: null } },
        { entityId: true, createdAt: true },
        (r) => worked(r.entityId, 'STATUS_CHANGE', r.createdAt),
      ))) complete = false;
      // PARTY_LINK: a Party link made, or reversed, by a person.
      if (!(await this.page(
        this.prisma.customerPartyLink as unknown as Finder,
        { ...org, OR: [{ linkedByUserId: { in: actors } }, { reversedByUserId: { in: actors } }] },
        { customerId: true, linkedAt: true, linkedByUserId: true, reversedAt: true, reversedByUserId: true },
        (r) => {
          if (typeof r.linkedByUserId === 'string' && humanSet.has(r.linkedByUserId)) worked(r.customerId, 'PARTY_LINK', r.linkedAt);
          if (typeof r.reversedByUserId === 'string' && humanSet.has(r.reversedByUserId)) worked(r.customerId, 'PARTY_LINK', r.reversedAt);
        },
      ))) complete = false;
    }

    // WEB_LEAD: the verified website-form mark, not an anonymous visitor.
    const leads = new Map<string, { createdAt: Date; status: unknown }>();
    const visitorless: Prisma.CustomerWhereInput = { OR: [{ externalId: null }, { NOT: { externalId: { startsWith: 'web-visitor:' } } }] };
    if (!(await this.page(
      this.prisma.customer as unknown as Finder,
      { AND: [org, { metadata: { path: ['createdFrom'], equals: 'website' } }, visitorless] },
      { createdAt: true, attributes: true },
      (r) => leads.set(r.id, { createdAt: r.createdAt as Date, status: (r.attributes as Record<string, unknown> | null)?.pipelineStatus }),
    ))) complete = false;
    // A lead entered when its form was submitted: the earliest website FORM_SUBMISSION the creator attached.
    const submittedAt = new Map<string, Date>();
    const leadIds = [...leads.keys()];
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const rows = await this.prisma.interaction.findMany({
        where: { organizationId, customerId: { in: leadIds.slice(i, i + CHUNK) }, kind: 'FORM_SUBMISSION', provider: 'website' },
        select: { customerId: true, occurredAt: true },
      });
      for (const r of rows) {
        const at = actTime(r.occurredAt);
        if (!r.customerId || !at) continue;
        const prior = submittedAt.get(r.customerId);
        if (!prior || at < prior) submittedAt.set(r.customerId, at);
      }
    }

    // The worked records themselves (they must exist in this organization), with their status.
    const workedRows = new Map<string, unknown>();
    const workedIds = [...work.keys()].filter((id) => !leads.has(id));
    for (let i = 0; i < workedIds.length; i += CHUNK) {
      const rows = await this.prisma.customer.findMany({ where: { organizationId, id: { in: workedIds.slice(i, i + CHUNK) } }, select: { id: true, attributes: true } });
      for (const r of rows) workedRows.set(r.id, (r.attributes as Record<string, unknown> | null)?.pipelineStatus);
    }

    const staleBefore = new Date(now.getTime() - INTAKE_STALE_DAYS * DAY);
    const records: IntakeRecord[] = [];
    const add = (id: string, basis: IntakeBasis, rawStatus: unknown, entered: Date) => {
      const w = work.get(id);
      const status = intakeStatusOf(rawStatus, basis);
      // The later of entry and the latest work: work never moves a record's clock backwards.
      const clockAt = w && w.last.getTime() > entered.getTime() ? w.last : entered;
      records.push({
        id,
        basis,
        workEvents: w ? INTAKE_WORK_EVENTS.filter((e) => w.events.has(e)) : [],
        status,
        enteredAt: entered,
        lastWorkedAt: w?.last ?? null,
        clockAt,
        stalled: (INTAKE_WORKING as readonly string[]).includes(status) && clockAt.getTime() < staleBefore.getTime(),
      });
    };
    for (const [id, lead] of leads) {
      const entered = submittedAt.get(id) ?? actTime(lead.createdAt) ?? lead.createdAt;
      add(id, 'WEB_LEAD', lead.status, entered);
    }
    for (const [id, status] of workedRows) add(id, 'HUMAN_WORK', status, work.get(id)!.first);

    const totalRecords = await this.prisma.customer.count({ where: org });
    return { complete, totalRecords, records };
  }

  /** Counts only -- what Home, the CRM and the organization page show. */
  async counts(organizationId: string, now: Date): Promise<IntakeCounts> {
    return intakeCountsOf(await this.read(organizationId, now));
  }
}
