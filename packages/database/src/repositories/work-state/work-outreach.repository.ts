// ONE PERSON'S OWN MAIL AND CALENDAR, AS THE CRM COMMAND CENTER NEEDS THEM (CRM slice 6).
//
// Architecture: docs/architecture/crm-people-command-center.md, under the isolation rule of
// docs/architecture/daily-loop-employee-intelligence.md §20.1: every method takes a WorkPrincipal,
// and there is no organization-only read. What the command center shows about outreach is derived
// from these rows FOR THE VIEWER WHO OWNS THEM, on every read, and stored nowhere else.
//
// METADATA ONLY. Message rows are read with an explicit column list: thread, time, direction, the
// address hashes, labels and subject -- never a body (none is stored), never an address beyond the
// person's own correspondent rows.
//
// The person's "Possible New People" dismissals live here too: they are derived from the same mail,
// belong to the same person, and are erased with the rest of their work state.

import type { PrismaClient } from '@prisma/client';

import { workScope, type WorkPrincipal } from './work-principal';

export interface OutreachCorrespondent {
  readonly addressHash: string;
  readonly displayAddress: string;
  readonly displayName: string | null;
  readonly domain: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly inboundCount: number;
  readonly outboundCount: number;
  readonly suppressed: boolean;
}

export interface OutreachMessage {
  readonly provider: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly internalDate: Date;
  readonly direction: string;
  readonly fromHash: string | null;
  readonly toHashes: readonly string[];
  readonly ccHashes: readonly string[];
  readonly labels: readonly string[];
  readonly subject: string | null;
  readonly automationClass: string | null;
}

export interface OutreachEvent {
  readonly eventId: string;
  readonly startsAt: Date | null;
  readonly startDate: Date | null;
  readonly allDay: boolean;
  readonly status: string | null;
  readonly summary: string | null;
  readonly attendeeHashes: readonly string[];
}

export interface OutreachDismissal {
  readonly correspondentHash: string;
  readonly reason: string;
  readonly dismissedAt: Date;
  readonly restoredAt: Date | null;
}

/** A directory larger than this is read as a refusal, not a partial truth. */
export const OUTREACH_CORRESPONDENT_LIMIT = 50_000;
export const OUTREACH_MESSAGE_LIMIT = 100_000;

const HASH = /^[0-9a-f]{64}$/;

export class WorkOutreachRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Every address this person has corresponded with (suppressed included: the caller decides). */
  async correspondents(principal: WorkPrincipal): Promise<{ rows: OutreachCorrespondent[]; truncated: boolean }> {
    const rows = await this.prisma.workCorrespondent.findMany({
      where: workScope(principal),
      select: { addressHash: true, displayAddress: true, displayName: true, domain: true, firstSeenAt: true, lastSeenAt: true, inboundCount: true, outboundCount: true, suppressed: true },
      orderBy: [{ lastSeenAt: 'desc' }, { addressHash: 'asc' }],
      take: OUTREACH_CORRESPONDENT_LIMIT + 1,
    });
    return { rows: rows.slice(0, OUTREACH_CORRESPONDENT_LIMIT), truncated: rows.length > OUTREACH_CORRESPONDENT_LIMIT };
  }

  /** One correspondent by its hash, or null. */
  async correspondent(principal: WorkPrincipal, addressHash: string): Promise<OutreachCorrespondent | null> {
    if (!HASH.test(addressHash)) return null;
    return this.prisma.workCorrespondent.findFirst({
      where: { ...workScope(principal), addressHash },
      select: { addressHash: true, displayAddress: true, displayName: true, domain: true, firstSeenAt: true, lastSeenAt: true, inboundCount: true, outboundCount: true, suppressed: true },
    });
  }

  /** This person's messages from, to or copying any of these addresses. Oldest first. */
  async messagesWith(principal: WorkPrincipal, addressHashes: readonly string[]): Promise<{ rows: OutreachMessage[]; truncated: boolean }> {
    const hashes = [...new Set(addressHashes)].filter((h) => HASH.test(h));
    if (hashes.length === 0) return { rows: [], truncated: false };
    const rows = await this.prisma.workMessage.findMany({
      where: { ...workScope(principal), OR: [{ fromHash: { in: hashes } }, { toHashes: { hasSome: hashes } }, { ccHashes: { hasSome: hashes } }] },
      select: { provider: true, messageId: true, threadId: true, internalDate: true, direction: true, fromHash: true, toHashes: true, ccHashes: true, labels: true, subject: true, automationClass: true },
      orderBy: [{ internalDate: 'asc' }, { messageId: 'asc' }],
      take: OUTREACH_MESSAGE_LIMIT + 1,
    });
    return { rows: rows.slice(0, OUTREACH_MESSAGE_LIMIT), truncated: rows.length > OUTREACH_MESSAGE_LIMIT };
  }

  /** This person's calendar events with any of these addresses among the attendees. */
  async eventsWith(principal: WorkPrincipal, addressHashes: readonly string[]): Promise<OutreachEvent[]> {
    const hashes = [...new Set(addressHashes)].filter((h) => HASH.test(h));
    if (hashes.length === 0) return [];
    return this.prisma.workEvent.findMany({
      where: { ...workScope(principal), attendeeHashes: { hasSome: hashes } },
      select: { eventId: true, startsAt: true, startDate: true, allDay: true, status: true, summary: true, attendeeHashes: true },
      orderBy: [{ startsAt: 'asc' }, { eventId: 'asc' }],
      take: 20_000,
    });
  }

  /** When this person's earliest stored message is: where what Loop observed of their mail begins. */
  async earliestMessageAt(principal: WorkPrincipal): Promise<Date | null> {
    const row = await this.prisma.workMessage.findFirst({ where: workScope(principal), select: { internalDate: true }, orderBy: { internalDate: 'asc' } });
    return row?.internalDate ?? null;
  }

  /** This person's own addresses: their login and the address their Google connection was linked as. */
  async ownAddresses(principal: WorkPrincipal): Promise<string[]> {
    const scope = workScope(principal);
    const [user, connections] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: scope.userId, organizationId: scope.organizationId }, select: { email: true } }),
      this.prisma.googleConnection.findMany({ where: scope, select: { emailAtLink: true } }),
    ]);
    return [user?.email, ...connections.map((c) => c.emailAtLink)].filter((a): a is string => typeof a === 'string' && a.includes('@')).map((a) => a.trim().toLowerCase());
  }

  // --- Possible New People dismissals (private to this person) ---------------------------------

  async dismissals(principal: WorkPrincipal): Promise<OutreachDismissal[]> {
    return this.prisma.crmDiscoveryDismissal.findMany({
      where: workScope(principal),
      select: { correspondentHash: true, reason: true, dismissedAt: true, restoredAt: true },
    });
  }

  /** Dismiss (or re-dismiss) one address from this person's queue. */
  async dismiss(principal: WorkPrincipal, correspondentHash: string, reason: string, at: Date): Promise<boolean> {
    if (!HASH.test(correspondentHash)) return false;
    const scope = workScope(principal);
    await this.prisma.crmDiscoveryDismissal.upsert({
      where: { organizationId_userId_correspondentHash: { ...scope, correspondentHash } },
      create: { ...scope, correspondentHash, reason, dismissedAt: at },
      update: { reason, dismissedAt: at, restoredAt: null },
    });
    return true;
  }

  /** Restore one dismissed address to this person's queue. False when it was not dismissed. */
  async restore(principal: WorkPrincipal, correspondentHash: string, at: Date): Promise<boolean> {
    if (!HASH.test(correspondentHash)) return false;
    const done = await this.prisma.crmDiscoveryDismissal.updateMany({
      where: { ...workScope(principal), correspondentHash, restoredAt: null },
      data: { restoredAt: at },
    });
    return done.count === 1;
  }
}
