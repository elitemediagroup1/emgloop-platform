// AIEmployeeRepository — Sprint 4 (Real Data Layer).
//
// The loop assigns an AI Employee ("Ava") to each new customer. Sprint 3 held
// this in memory; now it is persisted. ensureDefault() idempotently provisions
// a default ACTIVE front-desk AI Employee for an organization so the loop and
// seed can run repeatedly without duplicating rows.

import type { PrismaClient, AIEmployee } from '@prisma/client';

export class AIEmployeeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findActive(organizationId: string): Promise<AIEmployee | null> {
    return this.prisma.aIEmployee.findFirst({
      where: { organizationId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Ensure a default front-desk AI Employee exists for the org. Returns the
   * existing one if present, otherwise creates "Ava".
   */
  async ensureDefault(args: {
    organizationId: string;
    name?: string;
    title?: string;
  }): Promise<AIEmployee> {
    const existing = await this.findActive(args.organizationId);
    if (existing) return existing;
    return this.prisma.aIEmployee.create({
      data: {
        organizationId: args.organizationId,
        name: args.name ?? 'Ava',
        title: args.title ?? 'Front Desk AI Employee',
        status: 'ACTIVE',
        channels: ['SMS', 'WEB_CHAT'],
      },
    });
  }

  listByOrganization(organizationId: string): Promise<AIEmployee[]> {
    return this.prisma.aIEmployee.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
