// Creator onboarding extends the existing invitation, identity and membership authorities.
// An EMG invitation may explicitly create a new Person; it never guesses identity from email/name.
import type { PrismaClient } from '@prisma/client';
import { IamRepository, userSystemRole } from '../repositories/iam.repository';
import { PartyService } from '../services/party.service';
export async function issueCreatorInvitation(prisma: PrismaClient, organizationId: string, inviterId: string, input: {
  email: string; name: string; partyId: string; tokenHash: string; expiresAt: Date;
}) {
  return prisma.$transaction(async tx => {
    const iam = new IamRepository(tx as PrismaClient);
    if (!(await iam.can({ organizationId, userId: inviterId, resource: 'users', action: 'create' }))) throw new Error('NOT_ALLOWED');
    const user = await tx.user.findFirst({ where: { organizationId, email: input.email.toLowerCase().trim(), status: 'INVITED' } });
    if (!user || userSystemRole(user) !== 'CREATOR') throw new Error('CREATOR_INVITATION_REQUIRED');
    let partyId = input.partyId;
    if (partyId === '__new__') {
      if (!input.name.trim()) throw new Error('CREATOR_NAME_REQUIRED');
      if (!(await iam.can({ organizationId, userId: inviterId, resource: 'identityResolution', action: 'create' })) || !(await iam.can({ organizationId, userId: inviterId, resource: 'identityResolution', action: 'approve' }))) throw new Error('NOT_ALLOWED');
      // The invitation form explicitly selects creation; the inviter needs the existing
      // create AND approve authorities. Neither the invitee nor an AI establishes identity.
      const parties = new PartyService(prisma, { iam });
      const created = await parties.create(organizationId, inviterId, { partyType: 'PERSON', displayName: input.name.trim() }, { tx });
      if (created.outcome !== 'RECORDED') throw new Error('NOT_ALLOWED');
      partyId = created.party.id;
      const established = await parties.establish(organizationId, inviterId, partyId, 'MANUAL', { tx });
      if (established.outcome !== 'RECORDED') throw new Error('NOT_ALLOWED');
    }
    return iam.createInvitation({ organizationId, inviterId, email: input.email, tokenHash: input.tokenHash, expiresAt: input.expiresAt, systemRole: 'CREATOR', creatorPartyId: partyId });
  }, { isolationLevel: 'Serializable' });
}
