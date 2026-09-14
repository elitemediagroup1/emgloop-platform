// CustomerRepository — Sprint 4 (Real Data Layer).
//
// Customer persistence. Serializes attributes/metadata into the JSON columns.
// Reads here are organization-scoped; there is deliberately no lookup by id
// alone, because nothing may resolve a customer outside its organization.

import type { PrismaClient, Customer } from '@prisma/client';
import type { CreateCustomerInput } from './types';

/** Re-join first/last into a single display name for the UI. */
export function customerDisplayName(c: Customer): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Customer';
}

export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Create a customer from the schema shape (pre-split firstName/lastName). */
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
