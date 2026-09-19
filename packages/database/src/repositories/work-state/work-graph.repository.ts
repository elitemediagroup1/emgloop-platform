// The facts Daily Loop reads from: correspondents, threads, messages, events, documents.
//
// Architecture: daily-loop-employee-intelligence.md §11.2 and §17.
//
// IDEMPOTENT BY PROVIDER KEY. Every write is an upsert on the provider's own identifier
// scoped to this person -- (org, user, provider, threadId / messageId / eventId / fileId) --
// so re-ingesting the same page is a no-op and a retry is safe. That is the same property
// `IntegrationEvent` gets from (provider, externalId), without its defect: these keys are
// per employee, never global.
//
// A CORRESPONDENT IS NOT A PERSON. It is an address this employee writes to, stored hashed
// with its readable form beside it. Turning one into canonical identity is a governed act
// under `identityResolution`, and nothing here proposes, merges or attributes anything.
//
// NO CONTENT. There is no body, snippet, attachment or file content on any of these rows,
// and no column to put one in.

import type { PrismaClient } from '@prisma/client';
import { CALENDAR_ATTENDEE_KEY_LIMIT, type WorkClass, type WorkDirection, type WorkProvider } from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

const ONE_WAY_KEY = /^[0-9a-f]{64}$/;

/**
 * The attendee keys a row may hold: one-way keys only, none when attendance is unknown, at most
 * the contract's limit. Anything that is not a key -- an address passed by mistake -- is dropped
 * here, and the database CHECK refuses it again.
 */
function attendeeKeysOf(facts: EventFacts): string[] {
  if (!facts.attendanceKnown) return [];
  return [...new Set((facts.attendeeHashes ?? []).filter((k) => ONE_WAY_KEY.test(k)))].slice(0, CALENDAR_ATTENDEE_KEY_LIMIT);
}

export interface CorrespondentSeen {
  readonly addressHash: string;
  readonly displayAddress: string;
  readonly displayName?: string | null;
  readonly domain?: string | null;
  readonly seenAt: Date;
  readonly direction: WorkDirection;
}

export interface ThreadFacts {
  readonly provider: WorkProvider;
  readonly threadId: string;
  readonly subject?: string | null;
  readonly participantHashes?: readonly string[];
  readonly messageCount?: number;
  readonly firstMessageAt?: Date | null;
  readonly lastMessageAt?: Date | null;
  readonly lastDirection?: WorkDirection | null;
  readonly lastMessageId?: string | null;
  readonly labels?: readonly string[];
}

export interface MessageFacts {
  readonly provider: WorkProvider;
  readonly messageId: string;
  readonly threadId: string;
  readonly internalDate: Date;
  readonly direction: WorkDirection;
  readonly fromHash?: string | null;
  readonly toHashes?: readonly string[];
  readonly ccHashes?: readonly string[];
  readonly subject?: string | null;
  readonly headerMessageId?: string | null;
  readonly inReplyTo?: string | null;
  /** The RFC 5322 `References` chain, in order, so a reply can be threaded without Gmail. */
  readonly references?: readonly string[];
  readonly labels?: readonly string[];
  readonly observedAt: Date;
}

export interface EventFacts {
  readonly provider: WorkProvider;
  readonly eventId: string;
  readonly recurringEventId?: string | null;
  readonly originalStartsAt?: Date | null;
  /** Instants, for a timed event. */
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly allDay?: boolean;
  /** Dates, for an all-day event. Never resolved to an instant here (DL-2). */
  readonly startDate?: Date | null;
  readonly endDateExclusive?: Date | null;
  readonly eventTimeZone?: string | null;
  readonly status?: string | null;
  readonly kind?: string | null;
  readonly blocking?: string | null;
  /** The event's title: the one content field, and the minimum the Day view needs. */
  readonly summary?: string | null;
  readonly organizerHash?: string | null;
  readonly organizerIsSelf?: boolean;
  /** One-way attendee keys (D2). Stored only when attendance is known; never an address. */
  readonly attendeeHashes?: readonly string[];
  readonly attendanceKnown?: boolean;
  readonly attendeeCount?: number | null;
  readonly externalAttendeeCount?: number | null;
  readonly selfResponse?: string | null;
  readonly hasConference?: boolean;
  readonly providerUpdatedAt?: Date | null;
  readonly observedAt: Date;
}

export interface DocumentFacts {
  readonly provider: WorkProvider;
  readonly fileId: string;
  readonly name?: string | null;
  readonly mimeType?: string | null;
  readonly ownerHashes?: readonly string[];
  readonly modifiedAt?: Date | null;
  readonly webViewLink?: string | null;
  readonly observedAt: Date;
}

/** The class a rule decided, and the version of the rule that decided it. DL-8 writes these. */
export interface ThreadClassification {
  readonly derivedClass: WorkClass;
  readonly classRuleVersion: string;
  readonly medianReplyMinutes?: number | null;
}

export class WorkGraphRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // -- Correspondents -------------------------------------------------------------------

  /**
   * Record that this employee exchanged mail with an address. Counts accumulate and the
   * window widens; nothing here decides whether the address matters.
   */
  async recordCorrespondent(principal: WorkPrincipal, seen: CorrespondentSeen): Promise<void> {
    const scope = workScope(principal);
    const existing = await this.prisma.workCorrespondent.findFirst({ where: { ...scope, addressHash: seen.addressHash } });
    const inbound = seen.direction === 'INBOUND' ? 1 : 0;
    const outbound = seen.direction === 'OUTBOUND' ? 1 : 0;
    if (!existing) {
      await this.prisma.workCorrespondent.create({
        data: {
          ...scope,
          addressHash: seen.addressHash,
          displayAddress: seen.displayAddress,
          displayName: seen.displayName ?? null,
          domain: seen.domain ?? null,
          firstSeenAt: seen.seenAt,
          lastSeenAt: seen.seenAt,
          inboundCount: inbound,
          outboundCount: outbound,
        },
      });
      return;
    }
    await this.prisma.workCorrespondent.update({
      where: { id: existing.id },
      data: {
        displayName: seen.displayName ?? existing.displayName,
        domain: seen.domain ?? existing.domain,
        firstSeenAt: seen.seenAt < existing.firstSeenAt ? seen.seenAt : existing.firstSeenAt,
        lastSeenAt: seen.seenAt > existing.lastSeenAt ? seen.seenAt : existing.lastSeenAt,
        inboundCount: existing.inboundCount + inbound,
        outboundCount: existing.outboundCount + outbound,
      },
    });
  }

  async correspondents(principal: WorkPrincipal, options: { readonly includeSuppressed?: boolean; readonly limit?: number } = {}) {
    return this.prisma.workCorrespondent.findMany({
      where: { ...workScope(principal), ...(options.includeSuppressed ? {} : { suppressed: false }) },
      orderBy: { lastSeenAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
  }

  /** A person's own correction: stop surfacing this address. Reversible, and theirs alone. */
  async suppressCorrespondent(principal: WorkPrincipal, addressHash: string, suppressed: boolean): Promise<boolean> {
    const done = await this.prisma.workCorrespondent.updateMany({ where: { ...workScope(principal), addressHash }, data: { suppressed } });
    return done.count === 1;
  }

  // -- Threads and messages -------------------------------------------------------------

  /** Upsert a thread's facts. The provider key makes a re-read a no-op. */
  async upsertThread(principal: WorkPrincipal, facts: ThreadFacts): Promise<string> {
    const scope = workScope(principal);
    const where = { ...scope, provider: facts.provider, threadId: facts.threadId };
    const fields = {
      subject: facts.subject ?? null,
      participantHashes: [...(facts.participantHashes ?? [])],
      messageCount: facts.messageCount ?? 0,
      firstMessageAt: facts.firstMessageAt ?? null,
      lastMessageAt: facts.lastMessageAt ?? null,
      lastDirection: facts.lastDirection ?? null,
      lastMessageId: facts.lastMessageId ?? null,
      labels: [...(facts.labels ?? [])],
    };
    const existing = await this.prisma.workThread.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workThread.create({ data: { ...where, ...fields } });
      return created.id;
    }
    await this.prisma.workThread.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  /**
   * Write the class a rule decided. Separate from the facts on purpose: a rule change
   * reclassifies without re-reading Google, and a fact is never rewritten by an opinion.
   */
  async classifyThread(principal: WorkPrincipal, provider: WorkProvider, threadId: string, classification: ThreadClassification): Promise<boolean> {
    const done = await this.prisma.workThread.updateMany({
      where: { ...workScope(principal), provider, threadId },
      data: {
        derivedClass: classification.derivedClass,
        classRuleVersion: classification.classRuleVersion,
        medianReplyMinutes: classification.medianReplyMinutes ?? null,
      },
    });
    return done.count === 1;
  }

  async thread(principal: WorkPrincipal, provider: WorkProvider, threadId: string) {
    return this.prisma.workThread.findFirst({ where: { ...workScope(principal), provider, threadId } });
  }

  async threads(principal: WorkPrincipal, options: { readonly derivedClass?: WorkClass; readonly since?: Date; readonly limit?: number } = {}) {
    return this.prisma.workThread.findMany({
      where: {
        ...workScope(principal),
        ...(options.derivedClass ? { derivedClass: options.derivedClass } : {}),
        ...(options.since ? { lastMessageAt: { gte: options.since } } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  async upsertMessage(principal: WorkPrincipal, facts: MessageFacts): Promise<string> {
    const scope = workScope(principal);
    const where = { ...scope, provider: facts.provider, messageId: facts.messageId };
    const fields = {
      threadId: facts.threadId,
      internalDate: facts.internalDate,
      direction: facts.direction,
      fromHash: facts.fromHash ?? null,
      toHashes: [...(facts.toHashes ?? [])],
      ccHashes: [...(facts.ccHashes ?? [])],
      subject: facts.subject ?? null,
      headerMessageId: facts.headerMessageId ?? null,
      inReplyTo: facts.inReplyTo ?? null,
      references: [...(facts.references ?? [])],
      labels: [...(facts.labels ?? [])],
      observedAt: facts.observedAt,
    };
    const existing = await this.prisma.workMessage.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workMessage.create({ data: { ...where, ...fields } });
      return created.id;
    }
    await this.prisma.workMessage.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  async messages(principal: WorkPrincipal, threadId: string, limit = 100) {
    return this.prisma.workMessage.findMany({
      where: { ...workScope(principal), threadId },
      orderBy: { internalDate: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * This person's messages over one window, as COUNTING needs them: which thread, when, which way,
   * whether it replies to something, Gmail's own labels, and -- for a message that arrived -- the
   * sender's stored address, so "notification mail" is decided by the same rule the Mail dashboard
   * uses (an automated sender, or a Gmail bulk tab). No subject, no body.
   *
   * AN EXPLICIT COLUMN LIST, ON PURPOSE. A read that selects every column breaks the moment one
   * column it never uses is missing -- which is how a Home that only needed counts went down with a
   * migration that had not been applied (2026-09-18). This read depends on exactly what it uses.
   *
   * Each outbound message's thread is read too, for the thread's first message: the only way to
   * tell a conversation the employee started from a reply to one somebody else did.
   */
  async messageActivity(principal: WorkPrincipal, window: { readonly from: Date; readonly to: Date }, limit = 5000) {
    const take = Math.min(Math.max(limit, 1), 5000);
    const messages = await this.prisma.workMessage.findMany({
      where: { ...workScope(principal), internalDate: { gte: window.from, lt: window.to } },
      select: { threadId: true, internalDate: true, direction: true, labels: true, inReplyTo: true, fromHash: true },
      orderBy: { internalDate: 'asc' },
      take,
    });
    const senderHashes = [...new Set(messages.filter((m) => m.direction === 'INBOUND' && m.fromHash).map((m) => m.fromHash!))];
    const senders =
      senderHashes.length === 0
        ? []
        : await this.prisma.workCorrespondent.findMany({
            where: { ...workScope(principal), addressHash: { in: senderHashes } },
            select: { addressHash: true, displayAddress: true },
          });
    const addressOf = new Map(senders.map((c) => [c.addressHash, c.displayAddress]));
    const outboundThreads = [...new Set(messages.filter((m) => m.direction === 'OUTBOUND').map((m) => m.threadId))];
    const threads =
      outboundThreads.length === 0
        ? []
        : await this.prisma.workThread.findMany({
            where: { ...workScope(principal), threadId: { in: outboundThreads } },
            select: { threadId: true, firstMessageAt: true },
          });
    const firstMessageAt = new Map<string, Date>();
    for (const t of threads) if (t.firstMessageAt) firstMessageAt.set(t.threadId, t.firstMessageAt);
    return {
      messages: messages.map(({ fromHash, ...m }) => ({ ...m, fromAddress: fromHash ? addressOf.get(fromHash) ?? null : null })),
      firstMessageAt,
      truncated: messages.length >= take,
    };
  }

  /**
   * The stored messages of some of this person's own conversations, as the Mail dashboard's rules
   * need them: which thread, when, which way, who sent it (as the correspondent hash), whether it
   * replies to something, and Gmail's labels. Oldest first. No subject, no address, no body -- and,
   * like `messageActivity`, an explicit column list, so the read depends on exactly what it uses.
   */
  async threadEvidence(principal: WorkPrincipal, threadIds: readonly string[], limit = 4000) {
    if (threadIds.length === 0) return [];
    return this.prisma.workMessage.findMany({
      where: { ...workScope(principal), threadId: { in: [...threadIds] } },
      select: { threadId: true, internalDate: true, direction: true, fromHash: true, labels: true, inReplyTo: true },
      orderBy: { internalDate: 'asc' },
      take: Math.min(Math.max(limit, 1), 4000),
    });
  }

  /** One stored message by its provider id, so a deletion can find the thread it was on. */
  async messageByProviderId(principal: WorkPrincipal, provider: WorkProvider, messageId: string) {
    return this.prisma.workMessage.findFirst({ where: { ...workScope(principal), provider, messageId } });
  }

  /**
   * A thread whose every message is gone goes too.
   *
   * It is not a tidy-up: a thread row with no messages would still be counted, listed and
   * classified, and an employee would be told a conversation exists that Gmail no longer has.
   */
  async forgetThread(principal: WorkPrincipal, provider: WorkProvider, threadId: string): Promise<boolean> {
    const done = await this.prisma.workThread.deleteMany({ where: { ...workScope(principal), provider, threadId } });
    return done.count === 1;
  }

  /** Deleted at the source is a fact: the row goes, on the next cycle (§21.3a). */
  async forgetMessage(principal: WorkPrincipal, provider: WorkProvider, messageId: string): Promise<boolean> {
    const done = await this.prisma.workMessage.deleteMany({ where: { ...workScope(principal), provider, messageId } });
    return done.count === 1;
  }

  // -- Calendar and documents -----------------------------------------------------------

  async upsertEvent(principal: WorkPrincipal, facts: EventFacts): Promise<string> {
    const scope = workScope(principal);
    const where = { ...scope, provider: facts.provider, eventId: facts.eventId };
    const fields = {
      recurringEventId: facts.recurringEventId ?? null,
      originalStartsAt: facts.originalStartsAt ?? null,
      startsAt: facts.startsAt ?? null,
      endsAt: facts.endsAt ?? null,
      allDay: facts.allDay ?? false,
      startDate: facts.startDate ?? null,
      endDateExclusive: facts.endDateExclusive ?? null,
      eventTimeZone: facts.eventTimeZone ?? null,
      status: facts.status ?? null,
      kind: facts.kind ?? null,
      blocking: facts.blocking ?? null,
      summary: facts.summary ?? null,
      organizerHash: facts.organizerHash ?? null,
      organizerIsSelf: facts.organizerIsSelf ?? false,
      attendeeHashes: attendeeKeysOf(facts),
      attendanceKnown: facts.attendanceKnown ?? false,
      attendeeCount: facts.attendeeCount ?? null,
      externalAttendeeCount: facts.externalAttendeeCount ?? null,
      selfResponse: facts.selfResponse ?? null,
      hasConference: facts.hasConference ?? false,
      providerUpdatedAt: facts.providerUpdatedAt ?? null,
      observedAt: facts.observedAt,
    };
    const existing = await this.prisma.workEvent.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workEvent.create({ data: { ...where, ...fields } });
      return created.id;
    }
    await this.prisma.workEvent.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  async events(principal: WorkPrincipal, window: { readonly from: Date; readonly to: Date }) {
    return this.prisma.workEvent.findMany({
      where: { ...workScope(principal), startsAt: { gte: window.from, lte: window.to } },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * The events on a span of local days: timed ones by INSTANT, all-day ones by CIVIL DATE.
   *
   * Two shapes, two comparisons, on purpose. A timed event has a moment, so it is selected by
   * one; an all-day event has dates and no moment, so selecting it by an instant would mean
   * inventing a midnight for it -- exactly what DL-2 and DL-3 refused to do. The caller resolves
   * the day's boundaries in the employee's own zone (the Loop Time Authority) and passes both.
   *
   * The `from`/`to` dates are inclusive civil dates, and an all-day entry matches when it covers
   * any day in the span -- Google's end date being exclusive is handled by the comparison.
   */
  async eventsForDays(
    principal: WorkPrincipal,
    span: { readonly fromInstant: Date; readonly toInstant: Date; readonly fromDate: Date; readonly toDate: Date },
  ) {
    return this.prisma.workEvent.findMany({
      where: {
        ...workScope(principal),
        OR: [
          { allDay: false, startsAt: { gte: span.fromInstant, lt: span.toInstant } },
          { allDay: true, startDate: { lte: span.toDate }, OR: [{ endDateExclusive: null }, { endDateExclusive: { gt: span.fromDate } }] },
        ],
      },
      orderBy: [{ startsAt: 'asc' }, { startDate: 'asc' }],
    });
  }

  async forgetEvent(principal: WorkPrincipal, provider: WorkProvider, eventId: string): Promise<boolean> {
    const done = await this.prisma.workEvent.deleteMany({ where: { ...workScope(principal), provider, eventId } });
    return done.count === 1;
  }

  async upsertDocument(principal: WorkPrincipal, facts: DocumentFacts): Promise<string> {
    const scope = workScope(principal);
    const where = { ...scope, provider: facts.provider, fileId: facts.fileId };
    const fields = {
      name: facts.name ?? null,
      mimeType: facts.mimeType ?? null,
      ownerHashes: [...(facts.ownerHashes ?? [])],
      modifiedAt: facts.modifiedAt ?? null,
      webViewLink: facts.webViewLink ?? null,
      observedAt: facts.observedAt,
    };
    const existing = await this.prisma.workDocument.findFirst({ where });
    if (!existing) {
      const created = await this.prisma.workDocument.create({ data: { ...where, ...fields } });
      return created.id;
    }
    await this.prisma.workDocument.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  async documents(principal: WorkPrincipal, options: { readonly since?: Date; readonly limit?: number } = {}) {
    return this.prisma.workDocument.findMany({
      where: { ...workScope(principal), ...(options.since ? { modifiedAt: { gte: options.since } } : {}) },
      orderBy: { modifiedAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }
}
