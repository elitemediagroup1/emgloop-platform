// ConversationsRepository — Sprint 8 (Conversations & the Unified Inbox).
//
// Phase 3 of the internal CRM. Read/write queries that power the unified
// inbox (/crm/conversations), the conversation workspace (full message
// thread + compose/send), assignment and status controls, per-user saved
// views, and customer merge. Everything goes through Prisma via this
// repository so the rest of the platform never touches the client directly,
// consistent with the Sprint 4 repository layer. No mock data, no in-memory
// state, no provider sends — composed messages are persisted as Message rows
// on the canonical timeline only.

import type {
  Prisma,
  PrismaClient,
  Conversation,
  Message,
  ConversationStatus,
  ChannelType,
} from '@prisma/client';
import { customerDisplayName } from './customer.repository';

export const CONVERSATION_STATUSES: ConversationStatus[] = [
  'OPEN',
  'PENDING',
  'SNOOZED',
  'CLOSED',
];

export interface InboxFilters {
  status?: ConversationStatus | null;
  assigneeId?: string | null;
  channel?: ChannelType | null;
  search?: string | null;
}

export interface ConversationListItem {
  id: string;
  customerId: string | null;
  customerName: string;
  subject: string;
  channel: string;
  status: ConversationStatus;
  assigneeId: string | null;
  assigneeName: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  messageCount: number;
}

export interface ConversationListResult {
  rows: ConversationListItem[];
  counts: Record<string, number>;
  total: number;
}

export interface ThreadMessage {
  id: string;
  actorType: string;
  actorName: string;
  body: string;
  sentAt: string;
}

export interface ConversationWorkspace {
  id: string;
  customerId: string | null;
  customerName: string;
  subject: string;
  channel: string;
  status: ConversationStatus;
  assigneeId: string | null;
  assigneeName: string;
  createdAt: string;
  lastMessageAt: string | null;
  messages: ThreadMessage[];
}

export interface SavedView {
  id: string;
  name: string;
  status?: string | null;
  assigneeId?: string | null;
  channel?: string | null;
}

function nameFromParts(
  c: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!c) return 'Unknown customer';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer';
}

function actorLabelFor(actorType: string): string {
  switch (actorType) {
    case 'AI_AGENT': return 'AI Employee';
    case 'HUMAN_AGENT': return 'Agent';
    case 'CUSTOMER': return 'Customer';
    default: return 'System';
  }
}

export class ConversationsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Unified inbox --------------------------------------------------

  /**
   * The unified inbox: conversations for an org, filterable by status,
   * assignee and channel, with a per-status count summary for the filter
   * chips. Each row carries the customer's display name, the assignee's
   * name, a last-message preview and the message count. Bounded read.
   */
  async listConversations(
    organizationId: string,
    filters: InboxFilters = {},
  ): Promise<ConversationListResult> {
    const and: Prisma.ConversationWhereInput[] = [{ organizationId }];
    if (filters.status) and.push({ status: filters.status });
    if (filters.assigneeId) and.push({ assigneeId: filters.assigneeId });
    if (filters.channel) and.push({ channel: filters.channel });
    const q = (filters.search ?? '').trim();
    if (q) {
      and.push({
        OR: [
          { subject: { contains: q, mode: 'insensitive' } },
          { customer: { firstName: { contains: q, mode: 'insensitive' } } },
          { customer: { lastName: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.ConversationWhereInput = { AND: and };

    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        customer: { select: { firstName: true, lastName: true } },
        assignee: { select: { name: true, email: true } },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
    });

    const list: ConversationListItem[] = rows.map((c) => {
      const last = c.messages[0];
      const assignee = c.assignee;
      return {
        id: c.id,
        customerId: c.customerId,
        customerName: nameFromParts(c.customer),
        subject: c.subject ?? '(no subject)',
        channel: c.channel,
        status: c.status,
        assigneeId: c.assigneeId,
        assigneeName: assignee ? (assignee.name ?? assignee.email) : 'Unassigned',
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        lastMessagePreview: last && last.body ? last.body.slice(0, 120) : '',
        messageCount: c._count.messages,
      };
    });

    const grouped = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = { ALL: 0 };
    for (const s of CONVERSATION_STATUSES) counts[s] = 0;
    let allCount = 0;
    for (const g of grouped) {
      counts[g.status] = g._count._all;
      allCount += g._count._all;
    }
    counts.ALL = allCount;

    return { rows: list, counts, total: list.length };
  }

  // --- Conversation workspace ----------------------------------------

  /** Full conversation workspace: the conversation plus its complete
      message thread (oldest-first), with denormalized actor names. */
  async getWorkspace(
    organizationId: string,
    id: string,
  ): Promise<ConversationWorkspace | null> {
    // THE ORGANIZATION IS IN THE QUERY. A conversation in another tenant is
    // not-found, indistinguishable from one that never existed, rather than
    // relying on the page to compare an id after the fact.
    const c = await this.prisma.conversation.findFirst({
      where: { id, organizationId },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        assignee: { select: { name: true, email: true } },
        messages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!c) return null;

    const actorIds = Array.from(
      new Set(
        c.messages
          .filter((m) => m.actorType === 'HUMAN_AGENT' && m.actorId)
          .map((m) => m.actorId as string),
      ),
    );
    const users = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u.name ?? u.email]));
    const customerName = nameFromParts(c.customer);

    const messages: ThreadMessage[] = c.messages.map((m) => {
      let actorName = actorLabelFor(m.actorType);
      if (m.actorType === 'HUMAN_AGENT' && m.actorId) {
        actorName = userById.get(m.actorId) ?? 'Agent';
      } else if (m.actorType === 'CUSTOMER') {
        actorName = customerName;
      }
      return {
        id: m.id,
        actorType: m.actorType,
        actorName,
        body: m.body ?? '',
        sentAt: m.sentAt.toISOString(),
      };
    });

    return {
      id: c.id,
      customerId: c.customerId,
      customerName,
      subject: c.subject ?? '(no subject)',
      channel: c.channel,
      status: c.status,
      assigneeId: c.assigneeId,
      assigneeName: c.assignee ? (c.assignee.name ?? c.assignee.email) : 'Unassigned',
      createdAt: c.createdAt.toISOString(),
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      messages,
    };
  }

  /**
   * Compose and persist a human agent message into a conversation. The
   * message is written as a Message row on the canonical timeline and the
   * conversation's lastMessageAt is advanced. This is a DB/timeline write
   * only — no real provider send happens in this sprint.
   */
  async sendAgentMessage(args: {
    organizationId: string;
    conversationId: string;
    actorId: string;
    body: string;
  }): Promise<Message> {
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          organizationId: args.organizationId,
          conversationId: args.conversationId,
          actorType: 'HUMAN_AGENT',
          actorId: args.actorId,
          body: args.body,
          metadata: { composedInInbox: true } as object,
        },
      });
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: { lastMessageAt: message.sentAt },
      });
      return message;
    });
  }

  setStatus(
    id: string,
    status: ConversationStatus,
  ): Promise<Conversation> {
    return this.prisma.conversation.update({
      where: { id },
      data: { status },
    });
  }

  setAssignee(
    id: string,
    assigneeId: string | null,
  ): Promise<Conversation> {
    return this.prisma.conversation.update({
      where: { id },
      data: { assigneeId },
    });
  }

  // --- Saved views (per user, stored in User.metadata.savedViews) -----

  private metaOf(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }

  async listSavedViews(userId: string): Promise<SavedView[]> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    const raw = this.metaOf(u?.metadata).savedViews;
    return Array.isArray(raw) ? (raw as SavedView[]) : [];
  }

  async addSavedView(userId: string, view: Omit<SavedView, 'id'>): Promise<SavedView> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    const meta = this.metaOf(u?.metadata);
    const existing = Array.isArray(meta.savedViews)
      ? (meta.savedViews as SavedView[])
      : [];
    const created: SavedView = {
      id: 'view_' + Date.now().toString(36),
      name: view.name,
      status: view.status ?? null,
      assigneeId: view.assigneeId ?? null,
      channel: view.channel ?? null,
    };
    const next = [...existing, created];
    await this.prisma.user.update({
      where: { id: userId },
      data: { metadata: { ...meta, savedViews: next } as object },
    });
    return created;
  }

  async removeSavedView(userId: string, viewId: string): Promise<void> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    const meta = this.metaOf(u?.metadata);
    const existing = Array.isArray(meta.savedViews)
      ? (meta.savedViews as SavedView[])
      : [];
    const next = existing.filter((v) => v.id !== viewId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { metadata: { ...meta, savedViews: next } as object },
    });
  }

  // Customer duplicate detection and merge were removed (PD-I2-05, 2026-09-15). A
  // merge repointed a record's history onto another irreversibly, keyed on shared
  // email or phone -- contact values are not identity -- and is never Party
  // resolution. Historical `metadata.mergedInto` markers are kept, and
  // CustomerPartyLinkService still refuses a merged-away record.

  // --- Per-customer activity / audit view ----------------------------

  /** Surface the DomainEvent rows — and, only for a caller holding audit:view,
      the AuditLog rows — that concern a customer, merged into one
      reverse-chronological activity stream. `includeAudit` is required so the
      audit read is a decision every caller makes, not a default. */
  async customerActivity(
    organizationId: string,
    customerId: string,
    take: number,
    access: { includeAudit: boolean },
  ): Promise<{ id: string; kind: 'audit' | 'event'; label: string; actor: string; at: string }[]> {
    const [audits, events] = await Promise.all([
      access.includeAudit
        ? this.prisma.auditLog.findMany({
            where: { organizationId, entityType: 'customer', entityId: customerId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          })
        : Promise.resolve([]),
      this.prisma.domainEvent.findMany({
        where: { organizationId, aggregateType: 'customer', aggregateId: customerId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take,
      }),
    ]);

    const rows = [
      ...audits.map((a) => {
        const meta =
          a.metadata && typeof a.metadata === 'object'
            ? (a.metadata as Record<string, unknown>)
            : {};
        const actor = typeof meta.actorName === 'string' ? meta.actorName : 'System';
        return {
          id: a.id,
          kind: 'audit' as const,
          label: a.action,
          actor,
          at: a.createdAt.toISOString(),
        };
      }),
      ...events.map((e) => ({
        id: e.id,
        kind: 'event' as const,
        label: e.name,
        actor: 'System',
        at: e.occurredAt.toISOString(),
      })),
    ];
    // Newest first; equal timestamps fall back to id so the order is total.
    rows.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1));
    return rows.slice(0, take);
  }
}
