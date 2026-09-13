// Removed-marker repair -- deterministic assessment of legacy resurrected members.
//
// THE STATE THIS EXISTS FOR. Until 2026-07-21 (#134) the demo bootstrap ran on
// every cold start and called `activateUser` on each seed member. When an
// administrator had removed one -- status DISABLED plus `metadata.removedAt` --
// the next cold start flipped it back to ACTIVE and left the marker in place.
// `listUsers` hides any row with the marker, so the person vanished from the
// Team page while keeping a working login and full authority, and no screen
// could remove them again.
//
// THE RULE, AND WHY IT IS NOT A GUESS. A row is repairable only when every one
// of these holds, read from rows that already exist:
//
//   1. it carries the removal marker and is not DISABLED;
//   2. an administrator's `user.removed` audit entry exists for it;
//   3. that removal is the LAST user-lifecycle audit entry for it -- no
//      `user.reactivated`, `user.invited` or `user.permission_changed` after it;
//   4. no invitation for its email was created or accepted after that removal.
//
// Then the most recent authority act on the member was removal, and nothing an
// authorized person did since restored them. The ACTIVE status came from a code
// path with no authority -- the defect #134 removed. Restoring the removal honours
// the recorded decision; it invents none. Anything else is REFUSED with a reason
// and left for a human.
//
// READS ONLY. This file assesses. The write is the existing governed removal
// (`IamRepository.softRemoveUser` + `AuthRepository.revokeAllForUser` + an audit
// entry), performed by the operations runner, never here.

import type { PrismaClient } from '@prisma/client';
import { hasRemovalMarker } from './membership.repository';

/** Lifecycle actions an authorized person takes on a member from the Team page. */
export const USER_LIFECYCLE_ACTIONS = [
  'user.removed',
  'user.reactivated',
  'user.disabled',
  'user.invited',
  'user.permission_changed',
] as const;

export const REPAIR_REFUSAL_REASONS = [
  'NO_REMOVAL_AUDIT',
  'HUMAN_ACT_AFTER_REMOVAL',
  'INVITATION_AFTER_REMOVAL',
] as const;
export type RepairRefusalReason = (typeof REPAIR_REFUSAL_REASONS)[number];

export type RemovedMarkerAssessment =
  | { userId: string; eligible: true; lastRemovalAt: Date; markerValue: unknown }
  | { userId: string; eligible: false; reason: RepairRefusalReason };

export class RemovedMarkerRepairRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Members of the organization who carry the removal marker but are not DISABLED. */
  async candidates(organizationId: string): Promise<Array<{ id: string; email: string; metadata: unknown }>> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId, status: { in: ['INVITED', 'ACTIVE'] } },
      select: { id: true, email: true, metadata: true },
    });
    return rows.filter((r) => hasRemovalMarker(r.metadata));
  }

  /** Apply the rule to one candidate. Organization-scoped throughout. */
  async assess(
    organizationId: string,
    user: { id: string; email: string; metadata: unknown },
  ): Promise<RemovedMarkerAssessment> {
    const events = await this.prisma.auditLog.findMany({
      where: {
        organizationId,
        entityType: 'user',
        entityId: user.id,
        action: { in: [...USER_LIFECYCLE_ACTIONS] },
      },
      select: { action: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const removals = events.filter((e) => e.action === 'user.removed');
    const lastRemoval = removals[removals.length - 1];
    if (!lastRemoval) return { userId: user.id, eligible: false, reason: 'NO_REMOVAL_AUDIT' };

    const humanActAfter = events.some(
      (e) => e.action !== 'user.removed' && e.createdAt.getTime() >= lastRemoval.createdAt.getTime(),
    );
    if (humanActAfter) return { userId: user.id, eligible: false, reason: 'HUMAN_ACT_AFTER_REMOVAL' };

    const invitationsAfter = await this.prisma.invitation.count({
      where: {
        organizationId,
        email: user.email,
        OR: [{ createdAt: { gt: lastRemoval.createdAt } }, { acceptedAt: { gt: lastRemoval.createdAt } }],
      },
    });
    if (invitationsAfter > 0) return { userId: user.id, eligible: false, reason: 'INVITATION_AFTER_REMOVAL' };

    const marker = (user.metadata as Record<string, unknown> | null)?.['removedAt'];
    return { userId: user.id, eligible: true, lastRemovalAt: lastRemoval.createdAt, markerValue: marker };
  }
}
