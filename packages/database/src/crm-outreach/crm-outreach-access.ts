// Who may act on the CRM outreach authority (CRM slice 6). Three refusals, as every CRM authority:
//   1. an ACTIVE membership in this organization;
//   2. the coarse `identityResolution:view` gate -- the gate People and Contact Points already use
//      (AI_EMPLOYEE hard-denied; a creator login holds nothing);
//   3. the act table `CRM_OUTREACH_ACT_ROLES`, which no Permission row widens.

import type { PrismaClient } from '@prisma/client';
import { crmOutreachActPermitted, type CrmOutreachAct } from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';

/** Who is acting: the signed session's user, or the operator a command authenticated. */
export interface CrmOutreachActor {
  readonly organizationId: string;
  readonly userId: string;
}

export async function crmOutreachRole(prisma: PrismaClient, iam: Pick<IamRepository, 'canEach'>, actor: CrmOutreachActor): Promise<string | null> {
  if (!actor.organizationId?.trim() || !actor.userId?.trim()) return null;
  const authority = await membershipAuthority(prisma, actor.organizationId, actor.userId);
  if (!authority.granted) return null;
  const [canView] = await iam.canEach(actor.organizationId, actor.userId, [{ resource: 'identityResolution', action: 'view' }]);
  if (canView !== true) return null;
  return authority.systemRole;
}

export async function crmOutreachPermits(prisma: PrismaClient, iam: Pick<IamRepository, 'canEach'>, actor: CrmOutreachActor, act: CrmOutreachAct): Promise<boolean> {
  const role = await crmOutreachRole(prisma, iam, actor);
  return role !== null && crmOutreachActPermitted({ act, role, actorType: 'HUMAN' });
}
