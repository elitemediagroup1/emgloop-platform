// Who may act on the CRM import authority (CRM slice 5). Three refusals, as every CRM authority:
//   1. an ACTIVE membership in this organization;
//   2. the coarse `crmImports:view` gate (AI_EMPLOYEE hard-denied; a creator login holds nothing);
//   3. the act table `CRM_IMPORT_ACT_ROLES` (decided 2026-10-07), which no Permission row widens.

import type { PrismaClient } from '@prisma/client';
import { crmImportActPermitted, type CrmImportAct } from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';

/** Who is acting: the signed session's user, or the operator a command authenticated. Never a system user. */
export interface CrmImportActor {
  readonly organizationId: string;
  readonly userId: string;
}

export async function crmImportRole(prisma: PrismaClient, iam: Pick<IamRepository, 'canEach'>, actor: CrmImportActor): Promise<string | null> {
  if (!actor.organizationId?.trim() || !actor.userId?.trim()) return null;
  const authority = await membershipAuthority(prisma, actor.organizationId, actor.userId);
  if (!authority.granted) return null;
  const [canView] = await iam.canEach(actor.organizationId, actor.userId, [{ resource: 'crmImports', action: 'view' }]);
  if (canView !== true) return null;
  return authority.systemRole;
}

export async function crmImportPermits(prisma: PrismaClient, iam: Pick<IamRepository, 'canEach'>, actor: CrmImportActor, act: CrmImportAct): Promise<boolean> {
  const role = await crmImportRole(prisma, iam, actor);
  return role !== null && crmImportActPermitted({ act, role, actorType: 'HUMAN' });
}
