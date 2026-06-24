// CustomerRepository — Sprint 4 (Real Data Layer).
//
// All Customer persistence goes through this class. The loop engine and demo
// store call these methods instead of pushing to an in-memory array. The
// repository owns the mapping between the loop's "name" concept and the
// schema's firstName/lastName columns, and serializes attributes/metadata
// into the JSON columns.

import type { PrismaClient, Customer } from '@prisma/client';
import type { CreateCustomerInput } from './types';

/** Split a single display name into first/last for the schema. */
function splitName(name?: string | null): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? null;
  if (parts.length <= 1) return { firstName: first, lastName: null };
  return {
    firstName: first,
    lastName: parts.slice(1).join(' '),
  };
}

/** Re-join first/last into a single display name for the UI/loop. */
export function customerDisplayName(c: Customer): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer';
}

export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a customer. Accepts either a pre-split firstName/lastName or a
   * single `name` (via createFromName) — this method takes the schema shape.
   */
  create(input: CreateCustomerInput): Promise<Customer> {
    return this.prisma.customer.create({
      data: {
        organizationId: input.organizationId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        externalId: input.externalId ?? null,
        tags: input.tags ?? [],
        attributes: (input.attributes ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  /** Convenience create that accepts a single display name. */
  createFromName(
    input: Omit<CreateCustomerInput, 'firstName' | 'lastName'> & {
      name?: string | null;
    },
  ): Promise<Customer> {
    const { name, ...rest } = input;
    const { firstName, lastName } = splitName(name);
    return this.create({ ...rest, firstName, lastName });
  }

  findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  /** Most recently created customer for an org — used as a timeline fallback. */
  findLatest(organizationId: string): Promise<Customer | null> {
    return this.prisma.customer.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  listByOrganization(organizationId: string): Promise<Customer[]> {
    return this.prisma.customer.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  countByOrganization(organizationId: string): Promise<number> {
    return this.prisma.customer.count({ where: { organizationId } });
  }

  /**
   * Idempotent upsert keyed on (organizationId, externalId). Lets the seed and
   * future ServicesInMyCity sync run repeatedly without creating duplicates.
   */
  upsertByExternalId(
    input: CreateCustomerInput & { externalId: string },
  ): Promise<Customer> {
    return this.prisma.customer.upsert({
      where: {
        organizationId_externalId: {
          organizationId: input.organizationId,
          externalId: input.externalId,
        },
      },
      create: {
        organizationId: input.organizationId,
        externalId: input.externalId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        tags: input.tags ?? [],
        attributes: (input.attributes ?? {}) as object,
        metadata: (input.metadata ?? {}) as object,
      },
      update: {
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        lastSeenAt: new Date(),
      },
    });
  }
}
