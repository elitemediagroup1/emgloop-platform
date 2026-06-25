// AuditRepository — Sprint 7 (Identity, Authentication & Organizations).
//
// The security spine: every identity-relevant action (login, logout, user
// created/updated/disabled, permission changes, AI Employee changes, org
// changes) writes an immutable AuditLog row through this repository. Reads
// power the /crm/audit page. Built on the Sprint 1 AuditLog table — not a new
// design. Persisted to Neon; never mocked.

import type { PrismaClient, AuditLog, ActorType } from '@prisma/client';

export interface AuditView {
  id: string;
  action: string;
  actorType: string;
  actorName: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Record an audit entry. actorName is denormalized into metadata so the
      log reads cleanly even after a user is removed. */
  async record(args: {
    organizationId: string;
    action: string;
    userId?: string | null;
    actorType?: ActorType;
    actorName?: string;
    entityType?: string | null;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        organizationId: args.organizationId,
        userId: args.userId ?? null,
        actorType: args.actorType ?? 'HUMAN_AGENT',
        action: args.action,
        entityType: args.entityType ?? null,
        entityId: args.entityId ?? null,
        before: (args.before ?? undefined) as object | undefined,
        after: (args.after ?? undefined) as object | undefined,
        metadata: {
          ...(args.metadata ?? {}),
          actorName: args.actorName ?? 'System',
        } as object,
      },
    });
  }

  /** Most recent audit entries for an org, optionally filtered by action
      prefix (e.g. 'user.' or 'organization.'). */
  async list(
    organizationId: string,
    opts: { actionPrefix?: string; take?: number } = {},
  ): Promise<AuditView[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, opts.take ?? 200)),
    });
    const prefix = opts.actionPrefix;
    const filtered = prefix ? rows.filter((r) => r.action.startsWith(prefix)) : rows;
    return filtered.map((r) => {
      const meta = jsonObj(r.metadata);
      const actorName = typeof meta.actorName === 'string' ? meta.actorName : 'System';
      return {
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actorName,
        entityType: r.entityType,
        entityId: r.entityId,
        createdAt: r.createdAt.toISOString(),
        metadata: meta,
      };
    });
  }

  /** Distinct action categories present in the log (for filter chips). */
  async actionCategories(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { organizationId },
      select: { action: true },
      take: 1000,
    });
    const set = new Set<string>();
    for (const r of rows) {
      const category = r.action.split('.')[0];
      if (category) set.add(category);
    }
    return [...set].sort();
  }
}
