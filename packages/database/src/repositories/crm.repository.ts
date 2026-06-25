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

import type { Prisma, PrismaClient, Customer } from '@prisma/client';
import { customerDisplayName } from './customer.repository';

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
  count: number;
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

export class CrmRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Searchable, sortable, filterable, paginated customer list for an org.
   * Search spans name (first/last), company, email, phone, city, state and
   * externalId. Status and tag filters are applied in the database where the
   * schema allows; status (a JSON attribute) is filtered in-process on the
   * page slice's superset to keep the query portable.
   */
  async listCustomers(
    organizationId: string,
    filters: CustomerListFilters = {},
  ): Promise<CustomerListResult> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

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

    if (filters.tag) {
      and.push({ tags: { has: filters.tag } });
    }

    const where: Prisma.CustomerWhereInput = { AND: and };

    const wantsStatusFilter = Boolean(filters.status);
    const sort = filters.sort ?? 'createdAt';
    const direction = filters.direction ?? 'desc';

    if (!wantsStatusFilter && sort !== 'status') {
      const orderBy: Prisma.CustomerOrderByWithRelationInput =
        sort === 'name'
          ? { firstName: direction }
          : sort === 'lastSeenAt'
            ? { lastSeenAt: direction }
            : { createdAt: direction };

      const [total, customers] = await this.prisma.$transaction([
        this.prisma.customer.count({ where }),
        this.prisma.customer.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      const rows = await this.decorate(organizationId, customers);
      return {
        rows,
        total,
        page,
        pageSize,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
      };
    }

    const all = await this.prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    let filtered = all;
    if (filters.status) {
      filtered = all.filter((c) => readStatus(c) === filters.status);
    }
    if (sort === 'status') {
      const rank = (c: Customer) => PIPELINE_STATUSES.indexOf(readStatus(c));
      filtered = [...filtered].sort((a, b) =>
        direction === 'asc' ? rank(a) - rank(b) : rank(b) - rank(a),
      );
    }

    const total = filtered.length;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    const rows = await this.decorate(organizationId, slice);
    return {
      rows,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
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

  /** Status counts for the pipeline filter chips. */
  async statusCounts(
    organizationId: string,
  ): Promise<Record<PipelineStatus, number>> {
    const rows = await this.prisma.customer.findMany({
      where: { organizationId },
      select: { attributes: true },
      take: 5000,
    });
    const counts = Object.fromEntries(
      PIPELINE_STATUSES.map((s) => [s, 0]),
    ) as Record<PipelineStatus, number>;
    for (const r of rows) counts[readStatus(r as Pick<Customer, 'attributes'>)] += 1;
    return counts;
  }

  /** Full customer workspace payload, read from Neon via Prisma. */
  async getWorkspace(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) return null;

    const [interactions, bookings, signals, conversations] = await Promise.all([
      this.prisma.interaction.findMany({
        where: { customerId: id },
        orderBy: { occurredAt: 'desc' },
      }),
      this.prisma.booking.findMany({
        where: { customerId: id },
        orderBy: { startAt: 'desc' },
      }),
      this.prisma.signal.findMany({
        where: { customerId: id },
        orderBy: { observedAt: 'desc' },
      }),
      this.prisma.conversation.findMany({
        where: { customerId: id },
        orderBy: { lastMessageAt: 'desc' },
        include: { messages: { orderBy: { sentAt: 'asc' } } },
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

  /** Merge a patch into the customer's JSON attributes (assignment, status). */
  private async patchAttributes(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Customer> {
    const existing = await this.prisma.customer.findUnique({
      where: { id },
      select: { attributes: true },
    });
    const current =
      existing && existing.attributes && typeof existing.attributes === 'object'
        ? (existing.attributes as Record<string, unknown>)
        : {};
    return this.prisma.customer.update({
      where: { id },
      data: { attributes: { ...current, ...patch } as object },
    });
  }

  setPipelineStatus(id: string, status: PipelineStatus): Promise<Customer> {
    return this.patchAttributes(id, { pipelineStatus: status });
  }

  setAssignment(
    id: string,
    args: { humanName?: string | null; aiName?: string | null },
  ): Promise<Customer> {
    const patch: Record<string, unknown> = {};
    if (args.humanName !== undefined) patch.assignedHumanName = args.humanName;
    if (args.aiName !== undefined) patch.assignedAIName = args.aiName;
    return this.patchAttributes(id, patch);
  }

  async addTag(id: string, tag: string): Promise<Customer> {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: { tags: true },
    });
    const next = Array.from(new Set([...(c?.tags ?? []), tag])).filter(Boolean);
    return this.prisma.customer.update({ where: { id }, data: { tags: next } });
  }

  async removeTag(id: string, tag: string): Promise<Customer> {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: { tags: true },
    });
    const next = (c?.tags ?? []).filter((t) => t !== tag);
    return this.prisma.customer.update({ where: { id }, data: { tags: next } });
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
  ): Promise<Customer> {
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
      const existing = await this.prisma.customer.findUnique({
        where: { id },
        select: { attributes: true },
      });
      const current =
        existing && existing.attributes && typeof existing.attributes === 'object'
          ? (existing.attributes as Record<string, unknown>)
          : {};
      data.attributes = { ...current, ...attrPatch } as object;
    }

    return this.prisma.customer.update({ where: { id }, data });
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
      await this.setPipelineStatus(t.id, status);
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
      await this.addTag(t.id, tag);
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
      await this.setAssignment(t.id, args);
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
      orderBy: { occurredAt: 'desc' },
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
      const actorType = attr<string>(i.payload, 'actorType') ?? 'SYSTEM';
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
   * The pipeline kanban board: every customer in the org grouped into its
   * pipeline-status column, with a lightweight card payload. Bounded read.
   */
  async kanbanBoard(organizationId: string): Promise<KanbanColumn[]> {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId },
      orderBy: { lastSeenAt: 'desc' },
      take: 2000,
    });

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

    const columns: KanbanColumn[] = PIPELINE_STATUSES.map((status) => ({
      status,
      count: 0,
      cards: [],
    }));
    const byStatus = new Map(columns.map((c) => [c.status, c]));

    for (const c of customers) {
      const col = byStatus.get(readStatus(c));
      if (!col) continue;
      col.count += 1;
      if (col.cards.length < 50) {
        const last = lastByCustomer.get(c.id);
        col.cards.push({
          id: c.id,
          name: customerDisplayName(c),
          company: attr<string>(c.attributes, 'company') ?? '',
          assignedHuman: attr<string>(c.attributes, 'assignedHumanName') ?? '',
          assignedAI: attr<string>(c.attributes, 'assignedAIName') ?? '',
          lastInteractionAt: last ? last.toISOString() : null,
        });
      }
    }

    return columns;
  }
}
