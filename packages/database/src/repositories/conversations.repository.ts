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

export interface MergeResult {
  canonicalId: string;
  mergedId: string;
  moved: {
    conversations: number;
    interactions: number;
    bookings: number;
    orders: number;
    serviceRequests: number;
    signals: number;
  };
}

export interface DuplicateGroup {
  key: string;
  field: 'email' | 'phone';
  value: string;
  customers: { id: string; name: string; createdAt: string }[];
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
  async getWorkspace(id: string): Promise<ConversationWorkspace | null> {
    const c = await this.prisma.conversation.findUnique({
      where: { id },
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

  // --- Duplicate detection & customer merge --------------------------

  /** Detect duplicate customers in an org by shared email or phone. */
  async findDuplicates(organizationId: string): Promise<DuplicateGroup[]> {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId },
      select: {
        id: true, firstName: true, lastName: true,
        email: true, phone: true, createdAt: true,
      },
      take: 5000,
    });

    const byEmail = new Map<string, typeof customers>();
    const byPhone = new Map<string, typeof customers>();
    for (const c of customers) {
      const email = (c.email ?? '').toLowerCase().trim();
      const phone = (c.phone ?? '').replace(/[^0-9]/g, '');
      if (email) {
        const arr = byEmail.get(email) ?? [];
        arr.push(c);
        byEmail.set(email, arr);
      }
      if (phone && phone.length >= 7) {
        const arr = byPhone.get(phone) ?? [];
        arr.push(c);
        byPhone.set(phone, arr);
      }
    }

    const groups: DuplicateGroup[] = [];
    const emit = (
      field: 'email' | 'phone',
      map: Map<string, typeof customers>,
    ) => {
      for (const [value, arr] of map) {
        if (arr.length < 2) continue;
        groups.push({
          key: field + ':' + value,
          field,
          value,
          customers: arr.map((c) => ({
            id: c.id,
            name: nameFromParts(c),
            createdAt: c.createdAt.toISOString(),
          })),
        });
      }
    };
    emit('email', byEmail);
    emit('phone', byPhone);
    return groups;
  }

  /**
   * Merge the `mergedId` customer into the `canonicalId` customer. All
   * related rows (conversations, interactions, bookings, orders, service
   * requests, signals) are re-pointed to the canonical customer; tags are
   * unioned; the merged customer's row is soft-archived (kept for audit,
   * never hard-deleted) with a pointer to the canonical id. Runs in a
   * single transaction so a partial merge can never occur.
   */
  async mergeCustomers(args: {
    organizationId: string;
    canonicalId: string;
    mergedId: string;
  }): Promise<MergeResult> {
    const { organizationId, canonicalId, mergedId } = args;
    if (canonicalId === mergedId) {
      throw new Error('Cannot merge a customer into itself.');
    }

    return this.prisma.$transaction(async (tx) => {
      const canonical = await tx.customer.findFirst({
        where: { id: canonicalId, organizationId },
      });
      const merged = await tx.customer.findFirst({
        where: { id: mergedId, organizationId },
      });
      if (!canonical || !merged) {
        throw new Error('Both customers must exist in the organization.');
      }

      const scope = { organizationId, customerId: mergedId };
      const target = { customerId: canonicalId };

      const conversations = await tx.conversation.updateMany({
        where: scope, data: target,
      });
      const interactions = await tx.interaction.updateMany({
        where: scope, data: target,
      });
      const bookings = await tx.booking.updateMany({
        where: scope, data: target,
      });
      const orders = await tx.order.updateMany({
        where: scope, data: target,
      });
      const serviceRequests = await tx.serviceRequest.updateMany({
        where: scope, data: target,
      });
      const signals = await tx.signal.updateMany({
        where: scope, data: target,
      });

      const unionTags = Array.from(
        new Set([...(canonical.tags ?? []), ...(merged.tags ?? [])]),
      ).filter(Boolean);
      await tx.customer.update({
        where: { id: canonicalId },
        data: { tags: unionTags },
      });

      const mergedMeta =
        merged.metadata && typeof merged.metadata === 'object'
          ? (merged.metadata as Record<string, unknown>)
          : {};
      await tx.customer.update({
        where: { id: mergedId },
        data: {
          tags: [],
          metadata: {
            ...mergedMeta,
            mergedInto: canonicalId,
            mergedAt: new Date().toISOString(),
          } as object,
        },
      });

      return {
        canonicalId,
        mergedId,
        moved: {
          conversations: conversations.count,
          interactions: interactions.count,
          bookings: bookings.count,
          orders: orders.count,
          serviceRequests: serviceRequests.count,
          signals: signals.count,
        },
      };
    });
  }

  // --- Per-customer activity / audit view ----------------------------

  /** Surface the AuditLog + DomainEvent rows that concern a customer,
      merged into one reverse-chronological activity stream. */
  async customerActivity(
    organizationId: string,
    customerId: string,
    take = 100,
  ): Promise<{ id: string; kind: 'audit' | 'event'; label: string; actor: string; at: string }[]> {
    const [audits, events] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { organizationId, entityType: 'customer', entityId: customerId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.domainEvent.findMany({
        where: { organizationId, aggregateType: 'customer', aggregateId: customerId },
        orderBy: { occurredAt: 'desc' },
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
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return rows.slice(0, take);
  }
}
