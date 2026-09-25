// The facts the organization and personal domain producers read. Loop Intelligence Phase E, 2026-09-26.
//
// COUNTS AND IDS, SCOPED IN THE QUERY. Every method takes the organization (and, for a person's own facts,
// the user) as its first argument and resolves nothing outside it. A producer reads its domain through
// here or through the domain's own repository -- never Prisma directly -- so a fact a reading states traces
// to one scoped query in one place.
//
// Deliberately narrow: no names, no free text, no bodies. Each method returns exactly what a reading needs
// to MEASURE or OBSERVE, with the window it covered.

import type { PrismaClient } from '@prisma/client';

import { customerStatusWhere, PIPELINE_STATUSES, type PipelineStatus } from '../crm.repository';

const ACTIVE_STAGE = ['ready', 'in_progress'];

export interface WorkFacts {
  readonly activeInstances: number;
  readonly openStages: number;
  readonly unassigned: number;
  readonly overdue: number;
  readonly dueSoon: number;
  readonly pastReturn: number;
  readonly completed7d: number;
  readonly completedPrior7d: number;
  /** Ids of the overdue and past-return instances, oldest commitment first (for canonical references). */
  readonly overdueInstanceIds: readonly string[];
}

export class DomainFactsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Calendar (a person's own) -------------------------------------------------------------------

  async calendarTimeZone(organizationId: string, userId: string): Promise<string | null> {
    const row = await this.prisma.employeeWorkPreferences.findFirst({ where: { organizationId, userId }, select: { timeZone: true } });
    return row?.timeZone ?? null;
  }

  async calendarEvents(organizationId: string, userId: string, from: Date, to: Date, take: number) {
    return this.prisma.workEvent.findMany({
      where: { organizationId, userId, allDay: false, startsAt: { gte: from, lt: to } },
      orderBy: { startsAt: 'asc' },
      take,
      select: { id: true, summary: true, startsAt: true, endsAt: true, status: true, externalAttendeeCount: true, attendeeHashes: true, selfResponse: true },
    });
  }

  /** Participant keys of the person's mail threads that an open NEEDS_YOU item is waiting on. */
  async waitingThreadParticipants(organizationId: string, userId: string): Promise<(readonly string[])[]> {
    const waiting = await this.prisma.workItem.findMany({ where: { organizationId, userId, state: 'OPEN', class: 'NEEDS_YOU', subjectKind: 'THREAD' }, select: { subjectRef: true }, take: 200 });
    const ids = waiting.map((w) => w.subjectRef.replace(/^[a-z_]+:/, '')).filter(Boolean);
    if (ids.length === 0) return [];
    const threads = await this.prisma.workThread.findMany({ where: { organizationId, userId, OR: [{ id: { in: ids } }, { threadId: { in: ids } }] }, select: { participantHashes: true } });
    return threads.map((t) => t.participantHashes);
  }

  /** Whether the person has sent any mail to any of these recipients since `since`. */
  async sentMailTo(organizationId: string, userId: string, since: Date, recipients: readonly string[]): Promise<boolean> {
    const row = await this.prisma.workMessage.findFirst({ where: { organizationId, userId, direction: 'OUTBOUND', internalDate: { gte: since }, toHashes: { hasSome: [...recipients] } }, select: { id: true } });
    return row !== null;
  }

  /** The people with a connected Google account, as PRINCIPAL targets. */
  async connectedGooglePrincipals(take = 500): Promise<{ organizationId: string; userId: string }[]> {
    return this.prisma.googleConnection.findMany({ where: { status: 'CONNECTED' }, select: { organizationId: true, userId: true }, take });
  }

  // --- Pipeline (Intake) ---------------------------------------------------------------------------

  /** Records in each status that have seen no activity since `staleBefore`. */
  async staleByStatus(organizationId: string, statuses: readonly PipelineStatus[], staleBefore: Date): Promise<Record<string, number>> {
    const counts = await this.prisma.$transaction(statuses.map((s) => this.prisma.customer.count({ where: { AND: [{ organizationId, lastSeenAt: { lt: staleBefore } }, customerStatusWhere(s)] } })));
    return Object.fromEntries(statuses.map((s, i) => [s, counts[i] ?? 0]));
  }

  // --- CRM (People) --------------------------------------------------------------------------------

  async crmFacts(organizationId: string, since: Date, priorSince: Date, until: Date) {
    const established = { organizationId, establishedAt: { not: null }, supersededAt: null, archivedAt: null };
    const [people, companies, awaiting, newEstablished, priorEstablished, active, started, ended] = await Promise.all([
      this.prisma.cognitiveIdentity.count({ where: { ...established, entityType: 'PERSON' } }),
      this.prisma.cognitiveIdentity.count({ where: { ...established, entityType: 'COMPANY' } }),
      this.prisma.cognitiveIdentity.count({ where: { organizationId, establishedAt: null, supersededAt: null, archivedAt: null } }),
      this.prisma.cognitiveIdentity.count({ where: { ...established, establishedAt: { gte: since, lt: until } } }),
      this.prisma.cognitiveIdentity.count({ where: { ...established, establishedAt: { gte: priorSince, lt: since } } }),
      this.prisma.crmRelationship.count({ where: { organizationId, state: 'ACTIVE' } }),
      this.prisma.crmRelationshipEvent.count({ where: { organizationId, toState: 'ACTIVE', fromState: null, occurredAt: { gte: since, lt: until } } }),
      this.prisma.crmRelationshipEvent.count({ where: { organizationId, toState: 'ENDED', occurredAt: { gte: since, lt: until } } }),
    ]);
    return { people, companies, awaiting, newEstablished, priorEstablished, active, started, ended };
  }

  // --- Work ----------------------------------------------------------------------------------------

  /** The organization's work (userId null) or one person's own assigned work. */
  async workFacts(organizationId: string, userId: string | null, now: Date, dueSoonUntil: Date, since: Date, priorSince: Date): Promise<WorkFacts> {
    const instance = { organizationId, status: 'active' };
    const own = userId ? { ownerUserId: userId } : {};
    const open = { ...own, status: { in: ACTIVE_STAGE }, workInstance: instance };
    const [activeInstances, openStages, unassigned, overdue, dueSoon, pastReturn, completed7d, completedPrior7d, overdueRows] = await Promise.all([
      userId ? this.prisma.workInstance.count({ where: { ...instance, stages: { some: open } } }) : this.prisma.workInstance.count({ where: instance }),
      this.prisma.workStage.count({ where: open }),
      userId ? Promise.resolve(0) : this.prisma.workStage.count({ where: { ownerUserId: null, status: 'ready', workInstance: instance } }),
      this.prisma.workStage.count({ where: { ...open, dueAt: { lt: now } } }),
      this.prisma.workStage.count({ where: { ...open, dueAt: { gte: now, lt: dueSoonUntil } } }),
      this.prisma.workInstance.count({ where: { ...instance, expectedReturnAt: { lt: now }, ...(userId ? { stages: { some: open } } : {}) } }),
      this.prisma.workStage.count({ where: { ...(userId ? { completedByUserId: userId } : {}), status: 'completed', completedAt: { gte: since, lt: now }, workInstance: { organizationId } } }),
      this.prisma.workStage.count({ where: { ...(userId ? { completedByUserId: userId } : {}), status: 'completed', completedAt: { gte: priorSince, lt: since }, workInstance: { organizationId } } }),
      this.prisma.workInstance.findMany({
        where: { ...instance, OR: [{ expectedReturnAt: { lt: now } }, { stages: { some: { ...open, dueAt: { lt: now } } } }], ...(userId ? { stages: { some: open } } : {}) },
        orderBy: [{ expectedReturnAt: 'asc' }, { createdAt: 'asc' }],
        take: 6,
        select: { id: true },
      }),
    ]);
    return { activeInstances, openStages, unassigned, overdue, dueSoon, pastReturn, completed7d, completedPrior7d, overdueInstanceIds: overdueRows.map((r) => r.id) };
  }

  /** Organizations with active work, and the people with open assigned stages -- ids only, for a pass. */
  async organizationsWithActiveWork(take = 200): Promise<string[]> {
    const rows = await this.prisma.workInstance.findMany({ where: { status: 'active' }, select: { organizationId: true }, distinct: ['organizationId'], orderBy: { organizationId: 'asc' }, take });
    return rows.map((r) => r.organizationId);
  }

  async principalsWithOpenWork(take = 500): Promise<{ organizationId: string; userId: string }[]> {
    const rows = await this.prisma.workStage.findMany({
      where: { ownerUserId: { not: null }, status: { in: ACTIVE_STAGE }, workInstance: { status: 'active' } },
      select: { ownerUserId: true, workInstance: { select: { organizationId: true } } },
      distinct: ['ownerUserId'],
      take,
    });
    return rows.map((r) => ({ organizationId: r.workInstance.organizationId, userId: r.ownerUserId! }));
  }

  /** Organizations with records in a domain's own table -- ids only, for a pass. */
  async organizationsWithCustomers(take = 200): Promise<string[]> {
    const rows = await this.prisma.customer.findMany({ select: { organizationId: true }, distinct: ['organizationId'], orderBy: { organizationId: 'asc' }, take });
    return rows.map((r) => r.organizationId);
  }

  async organizationsWithParties(take = 200): Promise<string[]> {
    const rows = await this.prisma.cognitiveIdentity.findMany({ where: { establishedAt: { not: null } }, select: { organizationId: true }, distinct: ['organizationId'], orderBy: { organizationId: 'asc' }, take });
    return rows.map((r) => r.organizationId);
  }

  async organizationsWithWebsiteEvents(since: Date, take = 200): Promise<string[]> {
    const rows = await this.prisma.interaction.findMany({ where: { provider: 'website', occurredAt: { gte: since } }, select: { organizationId: true }, distinct: ['organizationId'], orderBy: { organizationId: 'asc' }, take });
    return rows.map((r) => r.organizationId);
  }

  async organizationsWithCreators(take = 200): Promise<string[]> {
    const rows = await this.prisma.creatorProfile.findMany({ select: { organizationId: true }, distinct: ['organizationId'], orderBy: { organizationId: 'asc' }, take });
    return rows.map((r) => r.organizationId);
  }

  /**
   * The member an organization reading runs as, when the deployment names one: an ACTIVE membership in
   * that organization with an operator role. Never guessed -- an unnamed or unqualified user is null, and
   * the reading stays rule-based.
   */
  async actingOperator(organizationId: string, userId: string, now: Date): Promise<{ organizationId: string; userId: string; role: string } | null> {
    const m = await this.prisma.organizationMembership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE', systemRole: { in: ['OWNER', 'ADMIN', 'MANAGER'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      select: { organizationId: true, userId: true, systemRole: true },
    });
    return m ? { organizationId: m.organizationId, userId: m.userId, role: m.systemRole } : null;
  }
}

export { PIPELINE_STATUSES };
