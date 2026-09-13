// Customer -> Party links -- persistence. CRM Phase Zero P0.2e.
//
// Organization-first, fail-closed, append-only. Every method takes
// organizationId first and resolves inside it. A link is created as a new row and
// reversed by stamping that row; nothing here deletes, repoints or rewrites a link,
// so the history of who linked what, and who undid it and why, survives every
// change. Authorization is not decided here: `CustomerPartyLinkService` is the only
// caller and authorizes every write first.

import type { CustomerPartyLink, PrismaClient } from '@prisma/client';

export interface CreateCustomerPartyLinkInput {
  customerId: string;
  partyId: string;
  basis: 'MANUAL' | 'EXPLICIT_LINK';
  linkedByUserId: string;
  linkedAt: Date;
}

export class CustomerPartyLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Whether the Customer exists in the organization, and whether the legacy merge
   * marked it merged away. ONLY the id and that marker are read: no contact value,
   * name or external id ever informs a link.
   */
  async customerState(
    organizationId: string,
    customerId: string,
  ): Promise<{ id: string; mergedInto: boolean } | null> {
    const row = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { id: true, metadata: true },
    });
    if (!row) return null;
    const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {};
    const merged = meta['mergedInto'];
    return { id: row.id, mergedInto: typeof merged === 'string' && merged.length > 0 };
  }

  /** The Customer's active link, or null. */
  findActive(organizationId: string, customerId: string): Promise<CustomerPartyLink | null> {
    return this.prisma.customerPartyLink.findFirst({
      where: { organizationId, customerId, reversedAt: null },
    });
  }

  /** Every link the Customer has ever had, oldest first. */
  history(organizationId: string, customerId: string): Promise<CustomerPartyLink[]> {
    return this.prisma.customerPartyLink.findMany({
      where: { organizationId, customerId },
      orderBy: { linkedAt: 'asc' },
    });
  }

  /**
   * Write a new active link. The unique `activeCustomerId` makes a concurrent
   * second active link fail with P2002 rather than coexist; the caller re-reads.
   */
  create(organizationId: string, input: CreateCustomerPartyLinkInput): Promise<CustomerPartyLink> {
    return this.prisma.customerPartyLink.create({
      data: {
        organizationId,
        customerId: input.customerId,
        partyId: input.partyId,
        basis: input.basis,
        linkedByUserId: input.linkedByUserId,
        linkedAt: input.linkedAt,
        activeCustomerId: input.customerId,
      },
    });
  }

  /**
   * Reverse the Customer's active link. Conditional on it still being active, so
   * a concurrent reversal writes nothing and returns null.
   */
  async reverse(
    organizationId: string,
    linkId: string,
    input: { reversedByUserId: string; reason: string; at: Date },
  ): Promise<CustomerPartyLink | null> {
    const { count } = await this.prisma.customerPartyLink.updateMany({
      where: { id: linkId, organizationId, reversedAt: null },
      data: {
        reversedAt: input.at,
        reversedByUserId: input.reversedByUserId,
        reversalReason: input.reason,
        activeCustomerId: null,
      },
    });
    if (count === 0) return null;
    return this.prisma.customerPartyLink.findFirst({ where: { id: linkId, organizationId } });
  }
}
