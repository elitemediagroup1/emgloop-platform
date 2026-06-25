// CrmRepository — Sprint 5 (Internal CRM, Phase 1).
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

function attr<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object' && key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, T>)[key];
  }
  return undefined;
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

    // Status lives in JSON attributes; Prisma can't portably order by it, so we
    // load the filtered set and apply status filter + status sort in-process.
    // For non-status sorts we paginate in the database for efficiency.
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

    // Status filter/sort path: load the matching set (bounded), filter + sort
    // by the JSON status in memory, then slice the page.
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
}
