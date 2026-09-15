// CrmRepository — Sprint 5 (Internal CRM, Phase 1) + Sprint 6 (Phase 2).
//
// Read/write queries that power the internal operations console (Customers
// list, Customer workspace, global Search). Everything goes through Prisma via
// this repository so the rest of the platform never touches the client
// directly, consistent with the Sprint 4 repository layer.
//
// The canonical Customer schema is intentionally generic: it has no first-class
// company/city/state/status/assignment columns. Per the schema's design rule,
// that operational shape lives in the JSON `attributes` column and the
// `tags` array. This repository owns the mapping between those JSON fields and
// the CRM view models, and derives "last interaction" from the Interaction
// timeline. No mock data, no in-memory state — every value is read from Neon.
//
// Sprint 6 (Phase 2) adds: editable customer fields, bulk list operations,
// the real assignee picker (backed by the User and AIEmployee tables), the
// activity inbox feed, and the pipeline kanban board — all through Prisma.

import { Prisma } from '@prisma/client';
import type { PrismaClient, Customer } from '@prisma/client';
import { customerDisplayName } from './customer.repository';
import { interactionActorType } from './interaction.repository';

export type PipelineStatus =
  | 'New'
  | 'Contacted'
  | 'Quoted'
  | 'Booked'
  | 'Completed'
  | 'Archived';

export const PIPELINE_STATUSES: PipelineStatus[] = [
  'New',
  'Contacted',
  'Quoted',
  'Booked',
  'Completed',
  'Archived',
];

export type CustomerSortKey =
  | 'createdAt'
  | 'lastSeenAt'
  | 'name'
  | 'status';

export interface CustomerListFilters {
  search?: string;
  status?: PipelineStatus | null;
  tag?: string | null;
  sort?: CustomerSortKey;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface CustomerListRow {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  status: PipelineStatus;
  tags: string[];
  assignedAI: string;
  assignedHuman: string;
  createdAt: string;
  lastInteractionAt: string | null;
  lastInteractionLabel: string | null;
}

export interface CustomerListResult {
  rows: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** A selectable assignee for the workspace picker (human user or AI employee). */
export interface AssigneeOption {
  id: string;
  name: string;
  subtitle: string;
}

export interface AssigneeOptions {
  humans: AssigneeOption[];
  ais: AssigneeOption[];
}

/** One row in the cross-org activity inbox feed. */
export interface InboxItem {
  id: string;
  customerId: string | null;
  customerName: string;
  kind: string;
  channel: string;
  direction: string;
  summary: string;
  actorType: string;
  occurredAt: string;
}

/** A single column of the pipeline kanban board. */
export interface KanbanColumn {
  status: PipelineStatus;
  /** Every person in this status: an exact count, not the number of cards. */
  count: number;
  /** The most recently active people in this status, at most KANBAN_CARD_LIMIT. */
  cards: {
    id: string;
    name: string;
    company: string;
    assignedHuman: string;
    assignedAI: string;
    lastInteractionAt: string | null;
  }[];
}

function attr<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object' && key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, T>)[key];
  }
  return undefined;
}

/** Inline display-name from first/last (mirrors customerDisplayName) for
   partial selects where the full Customer row is not loaded. */
function nameFromParts(
  c: { firstName: string | null; lastName: string | null },
): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer';
}

function readStatus(c: Pick<Customer, 'attributes'>): PipelineStatus {
  const s = attr<string>(c.attributes, 'pipelineStatus');
  if (s && (PIPELINE_STATUSES as string[]).includes(s)) return s as PipelineStatus;
  return 'New';
}

/** How a customer's intake status is read everywhere: a missing or unrecognised value is New. */
export const readPipelineStatus = readStatus;

/** Cards shown per Intake Board column. The column's count is always the full count. */
export const KANBAN_CARD_LIMIT = 50;

const STATUS_PATH = ['pipelineStatus'];
const statusEquals = (status: PipelineStatus): Prisma.CustomerWhereInput => ({
  attributes: { path: STATUS_PATH, equals: status },
});

/**
 * The database filter for "customers whose intake status reads as `status`" --
 * exactly the rows readPipelineStatus() maps to it, so a count, a filtered list
 * and a board column can all be computed in the database and agree.
 *
 * Status is a JSON attribute. Every status but New is a positive match on its
 * exact value. New is everything else, and that needs two branches: NOT(any
 * other status) alone drops customers with no pipelineStatus key at all,
 * because the JSON path is SQL NULL for them and NOT(NULL) is not true. So a
 * missing path (DbNull) is matched explicitly. Checked against Postgres for an
 * empty object, a JSON null, a lowercase value, a number, a nested object, an
 * array and a bare string: see test/crm-intake-counts.test.ts.
 */
export function customerStatusWhere(status: PipelineStatus): Prisma.CustomerWhereInput {
  if (status !== 'New') return statusEquals(status);
  return {
    OR: [
      { NOT: { OR: PIPELINE_STATUSES.filter((s) => s !== 'New').map(statusEquals) } },
      { attributes: { path: STATUS_PATH, equals: Prisma.DbNull } },
    ],
  };
}

export class CrmRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** The organization, search and tag part of a People query, shared by the list and its counts. */
  private customerWhere(
    organizationId: string,
    filters: Pick<CustomerListFilters, 'search' | 'tag'> = {},
  ): Prisma.CustomerWhereInput {
    const and: Prisma.CustomerWhereInput[] = [{ organizationId }];
    const q = (filters.search ?? '').trim();
    if (q) {
      and.push({
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { externalId: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (filters.tag) and.push({ tags: { has: filters.tag } });
    return { AND: and };
  }

  /**
   * Searchable, sortable, filterable, paginated customer list for an org.
   * Search spans name (first/last), email, phone and externalId; tag and status
   * filter in the database. `total` is an exact count of every matching
   * customer, never the size of a bounded read.
   *
   * Sorting by status walks the statuses in order with exact per-status counts
   * and pages within each, so it is exact and bounded at any size. (It used to
   * read the 2,000 newest customers and filter or sort those in memory, so a
   * status filter reported a partial population as the whole one.)
   */
  async listCustomers(
    organizationId: string,
    filters: CustomerListFilters = {},
  ): Promise<CustomerListResult> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
    const sort = filters.sort ?? 'createdAt';
    const direction = filters.direction ?? 'desc';
    const base = this.customerWhere(organizationId, filters);
    const result = (rows: CustomerListRow[], total: number): CustomerListResult => ({
      rows,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });

    if (filters.status || sort !== 'status') {
      // Within one status, a status sort has nothing to order by: newest first.
      const orderBy: Prisma.CustomerOrderByWithRelationInput =
        sort === 'name'
          ? { firstName: direction }
          : sort === 'lastSeenAt'
            ? { lastSeenAt: direction }
            : sort === 'createdAt'
              ? { createdAt: direction }
              : { createdAt: 'desc' };
      const where: Prisma.CustomerWhereInput = filters.status
        ? { AND: [base, customerStatusWhere(filters.status)] }
        : base;
      const [total, customers] = await this.prisma.$transaction([
        this.prisma.customer.count({ where }),
        this.prisma.customer.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      return result(await this.decorate(organizationId, customers), total);
    }

    const order = direction === 'asc' ? PIPELINE_STATUSES : [...PIPELINE_STATUSES].reverse();
    const whereFor = (status: PipelineStatus): Prisma.CustomerWhereInput => ({
      AND: [base, customerStatusWhere(status)],
    });
    const counts = await this.prisma.$transaction(
      order.map((status) => this.prisma.customer.count({ where: whereFor(status) })),
    );
    const total = counts.reduce((n, c) => n + c, 0);

    const slice: Customer[] = [];
    let skip = (page - 1) * pageSize;
    for (const [i, status] of order.entries()) {
      const inStatus = counts[i] ?? 0;
      if (slice.length >= pageSize) break;
      if (skip >= inStatus) {
        skip -= inStatus;
        continue;
      }
      const take = Math.min(pageSize - slice.length, inStatus - skip);
      slice.push(
        ...(await this.prisma.customer.findMany({
          where: whereFor(status),
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        })),
      );
      skip = 0;
    }
    return result(await this.decorate(organizationId, slice), total);
  }

  /** Attach last-interaction info to a page of customers (one extra query). */
  private async decorate(
    organizationId: string,
    customers: Customer[],
  ): Promise<CustomerListRow[]> {
    const ids = customers.map((c) => c.id);
    const lastByCustomer = new Map<
      string,
      { occurredAt: Date; summary: string | null; kind: string }
    >();

    if (ids.length > 0) {
      const interactions = await this.prisma.interaction.findMany({
        where: { organizationId, customerId: { in: ids } },
        orderBy: { occurredAt: 'desc' },
        select: { customerId: true, occurredAt: true, summary: true, kind: true },
      });
      for (const i of interactions) {
        if (!i.customerId) continue;
        if (!lastByCustomer.has(i.customerId)) {
          lastByCustomer.set(i.customerId, {
            occurredAt: i.occurredAt,
            summary: i.summary,
            kind: i.kind,
          });
        }
      }
    }

    return customers.map((c) => {
      const last = lastByCustomer.get(c.id);
      return {
        id: c.id,
        name: customerDisplayName(c),
        company: attr<string>(c.attributes, 'company') ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
        city: attr<string>(c.attributes, 'city') ?? '',
        state: attr<string>(c.attributes, 'state') ?? '',
        status: readStatus(c),
        tags: c.tags ?? [],
        assignedAI: attr<string>(c.attributes, 'assignedAIName') ?? '',
        assignedHuman: attr<string>(c.attributes, 'assignedHumanName') ?? '',
        createdAt: c.createdAt.toISOString(),
        lastInteractionAt: last ? last.occurredAt.toISOString() : null,
        lastInteractionLabel: last ? last.summary ?? last.kind : null,
      };
    });
  }

  /** Distinct tags across an org, for the filter dropdown. */
  async listTags(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.customer.findMany({
      where: { organizationId },
      select: { tags: true },
      take: 2000,
    });
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /**
   * How many customers are in each intake status: one exact database COUNT per
   * status, so the numbers sum to the organization's customer count at any
   * size. Pass the list's search and tag and each count is exactly the total
   * that status filter would show.
   *
   * (It used to read 5,000 customers in no particular order and count those, so
   * past 5,000 every figure described an arbitrary sample while reading as the
   * whole book.)
   */
  async statusCounts(
    organizationId: string,
    filters: Pick<CustomerListFilters, 'search' | 'tag'> = {},
  ): Promise<Record<PipelineStatus, number>> {
    const base = this.customerWhere(organizationId, filters);
    const counts = await this.prisma.$transaction(
      PIPELINE_STATUSES.map((status) =>
        this.prisma.customer.count({ where: { AND: [base, customerStatusWhere(status)] } }),
      ),
    );
    return Object.fromEntries(
      PIPELINE_STATUSES.map((status, i) => [status, counts[i] ?? 0]),
    ) as Record<PipelineStatus, number>;
  }

  /**
   * Windowed CRM counts for the Executive Brain's CRM sensor. COUNTs only —
   * never hydrates rows — over the half-open window `[since, until)`, org-scoped.
   * Pipeline status is deliberately NOT counted here: it lives in the JSON
   * `attributes` bag and cannot be a cheap COUNT, so this method reports only
   * facts that trace to real columns (new customers, conversations opened, and
   * how many of those carried an assignee — a real coverage signal).
   */
  async windowCounts(
    organizationId: string,
    since: Date,
    until: Date,
  ): Promise<{ newCustomers: number; conversations: number; conversationsAssigned: number }> {
    const customerWindow = { organizationId, createdAt: { gte: since, lt: until } };
    const convWindow = { organizationId, createdAt: { gte: since, lt: until } };
    const [newCustomers, conversations, conversationsAssigned] = await Promise.all([
      this.prisma.customer.count({ where: customerWindow }),
      this.prisma.conversation.count({ where: convWindow }),
      this.prisma.conversation.count({ where: { ...convWindow, assigneeId: { not: null } } }),
    ]);
    return { newCustomers, conversations, conversationsAssigned };
  }

  /**
   * Full customer workspace payload, read from Neon via Prisma.
   *
   * THE ORGANIZATION IS RESOLVED IN THE QUERY, not by the caller. `findFirst`
   * with both the id AND the organization is what makes a customer belonging to
   * another tenant indistinguishable from one that does not exist -- the caller
   * cannot widen it, and forgetting a guard at a call site can no longer leak a
   * row. Before this, the signature was `getWorkspace(id)` and every call site
   * was one forgotten `customerBelongsToOrg` away from a cross-tenant read.
   */
  async getWorkspace(organizationId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId },
    });
    if (!customer) return null;

    // Every ordering ends on id: rows that share a timestamp (a batch import,
    // one loop step) must not reorder between two renders of the same timeline.
    const [interactions, bookings, signals, conversations] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { organizationId, customerId: id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.booking.findMany({
        where: { organizationId, customerId: id },
        orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.signal.findMany({
        where: { organizationId, customerId: id },
        orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.conversation.findMany({
        where: { organizationId, customerId: id },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        include: { messages: { orderBy: [{ sentAt: 'asc' }, { id: 'asc' }] } },
      }),
    ]);

    return {
      customer,
      name: customerDisplayName(customer),
      status: readStatus(customer),
      company: attr<string>(customer.attributes, 'company') ?? '',
      city: attr<string>(customer.attributes, 'city') ?? '',
      state: attr<string>(customer.attributes, 'state') ?? '',
      serviceType: attr<string>(customer.attributes, 'serviceType') ?? '',
      source: attr<string>(customer.attributes, 'source') ?? '',
      assignedAIName: attr<string>(customer.attributes, 'assignedAIName') ?? '',
      assignedHumanName: attr<string>(customer.attributes, 'assignedHumanName') ?? '',
      interactions,
      bookings,
      signals,
      conversations,
    };
  }

  /**
   * Merge a patch into the customer's JSON attributes (assignment, status).
   *
   * RESOLVES WITHIN THE ORGANIZATION AND FAILS CLOSED TO NULL. A row in another
   * tenant is not found, so nothing is written and nothing is disclosed --
   * rather than the previous `update({ where: { id } })`, which would have
   * written across a tenant boundary the moment any caller forgot its guard.
   */
  private async patchAttributes(
    organizationId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Customer | null> {
    const existing = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      select: { id: true, attributes: true },
    });
    if (!existing) return null;
    const current =
      existing.attributes && typeof existing.attributes === 'object'
        ? (existing.attributes as Record<string, unknown>)
        : {};
    return this.prisma.customer.update({
      where: { id: existing.id },
      data: { attributes: { ...current, ...patch } as object },
    });
  }

  setPipelineStatus(
    organizationId: string,
    id: string,
    status: PipelineStatus,
  ): Promise<Customer | null> {
    return this.patchAttributes(organizationId, id, { pipelineStatus: status });
  }

  setAssignment(
    organizationId: string,
    id: string,
    args: { humanName?: string | null; aiName?: string | null },
  ): Promise<Customer | null> {
    const patch: Record<string, unknown> = {};
    if (args.humanName !== undefined) patch.assignedHumanName = args.humanName;
    if (args.aiName !== undefined) patch.assignedAIName = args.aiName;
    return this.patchAttributes(organizationId, id, patch);
  }

  async addTag(organizationId: string, id: string, tag: string): Promise<Customer | null> {
    const c = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      select: { id: true, tags: true },
    });
    if (!c) return null;
    const next = Array.from(new Set([...(c.tags ?? []), tag])).filter(Boolean);
    return this.prisma.customer.update({ where: { id: c.id }, data: { tags: next } });
  }

  async removeTag(organizationId: string, id: string, tag: string): Promise<Customer | null> {
    const c = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      select: { id: true, tags: true },
    });
    if (!c) return null;
    const next = (c.tags ?? []).filter((t) => t !== tag);
    return this.prisma.customer.update({ where: { id: c.id }, data: { tags: next } });
  }

  // ----------------------------------------------------------------------
  // Sprint 6 (Phase 2)
  // ----------------------------------------------------------------------

  /**
   * Update the editable, first-class customer fields plus the operational
   * fields that live in JSON attributes (company, city, state, service,
   * source). Only keys explicitly provided are changed; attributes are merged
   * so unrelated keys (status, assignments) are preserved.
   */
  async updateCustomerFields(
    organizationId: string,
    id: string,
    fields: {
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
      phone?: string | null;
      company?: string | null;
      city?: string | null;
      state?: string | null;
      serviceType?: string | null;
      source?: string | null;
    },
  ): Promise<Customer | null> {
    // RESOLVED WITHIN THE ORGANIZATION FIRST, like every other write here.
    const target = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      select: { id: true, attributes: true },
    });
    if (!target) return null;

    const data: Prisma.CustomerUpdateInput = {};
    if (fields.firstName !== undefined) data.firstName = fields.firstName;
    if (fields.lastName !== undefined) data.lastName = fields.lastName;
    if (fields.email !== undefined) data.email = fields.email;
    if (fields.phone !== undefined) data.phone = fields.phone;

    const attrPatch: Record<string, unknown> = {};
    for (const k of ['company', 'city', 'state', 'serviceType', 'source'] as const) {
      if (fields[k] !== undefined) attrPatch[k] = fields[k];
    }

    if (Object.keys(attrPatch).length > 0) {
      const current =
        target.attributes && typeof target.attributes === 'object'
          ? (target.attributes as Record<string, unknown>)
          : {};
      data.attributes = { ...current, ...attrPatch } as object;
    }

    return this.prisma.customer.update({ where: { id: target.id }, data });
  }

  /** Bulk: set pipeline status on many customers (scoped to the org). */
  async bulkSetStatus(
    organizationId: string,
    ids: string[],
    status: PipelineStatus,
  ): Promise<number> {
    const targets = await this.prisma.customer.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true },
    });
    let n = 0;
    for (const t of targets) {
      await this.setPipelineStatus(organizationId, t.id, status);
      n += 1;
    }
    return n;
  }

  /** Bulk: add a tag to many customers (scoped to the org, deduplicated). */
  async bulkAddTag(
    organizationId: string,
    ids: string[],
    tag: string,
  ): Promise<number> {
    const targets = await this.prisma.customer.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true },
    });
    let n = 0;
    for (const t of targets) {
      await this.addTag(organizationId, t.id, tag);
      n += 1;
    }
    return n;
  }

  /** Bulk: assign many customers to a human and/or AI employee (by name). */
  async bulkAssign(
    organizationId: string,
    ids: string[],
    args: { humanName?: string | null; aiName?: string | null },
  ): Promise<number> {
    const targets = await this.prisma.customer.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true },
    });
    let n = 0;
    for (const t of targets) {
      await this.setAssignment(organizationId, t.id, args);
      n += 1;
    }
    return n;
  }

  /**
   * The real assignee picker source: human Users and AI Employees that belong
   * to the organization, read straight from Neon. Replaces the Phase-1
   * free-text assignment inputs.
   */
  async listAssignees(organizationId: string): Promise<AssigneeOptions> {
    const [users, ais] = await Promise.all([
      this.prisma.user.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, email: true, status: true },
      }),
      this.prisma.aIEmployee.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, title: true, status: true },
      }),
    ]);

    return {
      humans: users.map((u) => ({
        id: u.id,
        name: u.name ?? u.email,
        subtitle: u.email + ' · ' + u.status,
      })),
      ais: ais.map((a) => ({
        id: a.id,
        name: a.name,
        subtitle: (a.title ?? 'AI Employee') + ' · ' + a.status,
      })),
    };
  }

  /**
   * The activity inbox: the most recent interactions across the whole org,
   * joined to the customer's display name. Powers /crm/inbox.
   */
  async inboxFeed(organizationId: string, take = 50): Promise<InboxItem[]> {
    const interactions = await this.prisma.interaction.findMany({
      where: { organizationId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.min(200, Math.max(1, take)),
      include: {
        customer: {
          select: { firstName: true, lastName: true },
        },
      },
    });

    return interactions.map((i) => {
      const c = i.customer;
      const name = c ? nameFromParts(c) : 'Unknown customer';
      const actorType = interactionActorType(i.payload) ?? 'SYSTEM';
      return {
        id: i.id,
        customerId: i.customerId,
        customerName: name,
        kind: i.kind,
        channel: i.channel,
        direction: i.direction,
        summary: i.summary ?? i.kind,
        actorType,
        occurredAt: i.occurredAt.toISOString(),
      };
    });
  }

  /**
   * The Intake Board: one column per intake status. Each column's `count` is an
   * exact database count of everyone in that status; its cards are the
   * KANBAN_CARD_LIMIT most recently active of them, so a column can show fewer
   * cards than its count and the page says so.
   *
   * (It used to read the 2,000 most recently active customers and count those,
   * so every column count and the board total described that slice.)
   */
  async kanbanBoard(organizationId: string): Promise<KanbanColumn[]> {
    const whereFor = (status: PipelineStatus): Prisma.CustomerWhereInput => ({
      AND: [{ organizationId }, customerStatusWhere(status)],
    });
    const [counts, perStatus] = await Promise.all([
      this.prisma.$transaction(PIPELINE_STATUSES.map((status) => this.prisma.customer.count({ where: whereFor(status) }))),
      this.prisma.$transaction(
        PIPELINE_STATUSES.map((status) =>
          this.prisma.customer.findMany({
            where: whereFor(status),
            orderBy: { lastSeenAt: 'desc' },
            take: KANBAN_CARD_LIMIT,
          }),
        ),
      ),
    ]);
    const customers = perStatus.flat();

    const lastByCustomer = new Map<string, Date>();
    const ids = customers.map((c) => c.id);
    if (ids.length > 0) {
      const interactions = await this.prisma.interaction.findMany({
        where: { organizationId, customerId: { in: ids } },
        orderBy: { occurredAt: 'desc' },
        select: { customerId: true, occurredAt: true },
      });
      for (const i of interactions) {
        if (i.customerId && !lastByCustomer.has(i.customerId)) {
          lastByCustomer.set(i.customerId, i.occurredAt);
        }
      }
    }

    return PIPELINE_STATUSES.map((status, i) => ({
      status,
      count: counts[i] ?? 0,
      cards: (perStatus[i] ?? []).map((c) => {
        const last = lastByCustomer.get(c.id);
        return {
          id: c.id,
          name: customerDisplayName(c),
          company: attr<string>(c.attributes, 'company') ?? '',
          assignedHuman: attr<string>(c.attributes, 'assignedHumanName') ?? '',
          assignedAI: attr<string>(c.attributes, 'assignedAIName') ?? '',
          lastInteractionAt: last ? last.toISOString() : null,
        };
      }),
    }));
  }
}
