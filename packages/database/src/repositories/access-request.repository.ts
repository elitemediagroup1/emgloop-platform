import type { PrismaClient } from '@prisma/client';
import { AuditRepository } from './audit.repository';

export const ACCESS_REQUEST_TYPES = ['Employee', 'Company Administrator', 'Creator', 'Partner / Vendor', 'Other'] as const;
export interface AccessRequestSubmission { fullName: string; email: string; company: string; accessType: string }
export function cleanAccessRequest(input: AccessRequestSubmission): AccessRequestSubmission {
  const fullName = input.fullName.trim();
  const email = input.email.trim().toLowerCase();
  const company = input.company.trim();
  if (!fullName || fullName.length > 100 || !company || company.length > 150 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\u0000-\u001f\u007f]/.test(fullName + email + company) || !ACCESS_REQUEST_TYPES.some(t => t === input.accessType)) throw new Error('INVALID_ACCESS_REQUEST');
  return { fullName, email, company, accessType: input.accessType };
}

/** Public intake records intent only. Every subsequent read/decision is explicitly org-scoped. */
export class AccessRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async submit(organizationId: string, input: AccessRequestSubmission) {
    const data = cleanAccessRequest(input);
    const organization = await this.prisma.organization.findFirst({ where: { id: organizationId, status: { in: ['ACTIVE', 'TRIAL'] } }, select: { id: true } });
    if (!organization) throw new Error('ACCESS_INTAKE_UNAVAILABLE');
    // A repeat cannot overwrite the original identity, requested role or an administrator's decision.
    return this.prisma.accessRequest.upsert({ where: { organizationId_email: { organizationId, email: data.email } }, create: { organizationId, ...data }, update: {} });
  }

  get(organizationId: string, id: string) { return this.prisma.accessRequest.findFirst({ where: { organizationId, id } }); }
  forInvitation(organizationId: string, invitationId: string) { return this.prisma.accessRequest.findFirst({ where: { organizationId, invitationId } }); }
  async replaceInvitation(organizationId: string, id: string, previousId: string, invitationId: string) {
    const request = await this.get(organizationId, id);
    if (!request) return false;
    const invitation = await this.prisma.invitation.findFirst({ where: { organizationId, id: invitationId, email: request.email, metadata: { path: ['accessRequestId'], equals: id } } });
    if (!invitation) return false;
    return (await this.prisma.accessRequest.updateMany({ where: { organizationId, id, invitationId: previousId, status: 'INVITED' }, data: { invitationId } })).count === 1;
  }
  list(organizationId: string, pending: boolean, cursor?: string) {
    return this.prisma.accessRequest.findMany({ where: { organizationId, status: pending ? { in: ['PENDING', 'PROCESSING', 'FAILED'] } : { in: ['INVITED', 'REJECTED', 'RESOLVED'] }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 51, include: { invitation: { select: { status: true, expiresAt: true } } } });
  }

  async claim(organizationId: string, id: string, userId: string, claimId: string, now: Date) {
    const result = await this.prisma.accessRequest.updateMany({ where: { organizationId, id, OR: [{ status: { in: ['PENDING', 'FAILED'] } }, { status: 'PROCESSING', processingAt: { lt: new Date(now.getTime() - 5 * 60_000) } }] }, data: { status: 'PROCESSING', claimId, processingAt: now, decidedById: userId } });
    return result.count ? this.get(organizationId, id) : null;
  }

  ownedInvitation(organizationId: string, requestId: string, email: string) {
    return this.prisma.invitation.findFirst({ where: { organizationId, email, status: 'PENDING', metadata: { path: ['accessRequestId'], equals: requestId } }, orderBy: { createdAt: 'desc' } });
  }

  async attach(organizationId: string, id: string, claimId: string, invitationId: string) {
    const request = await this.get(organizationId, id);
    if (!request) return false;
    const invitation = await this.prisma.invitation.findFirst({ where: { organizationId, id: invitationId, email: request.email, metadata: { path: ['accessRequestId'], equals: id } } });
    if (!invitation) return false;
    const result = await this.prisma.accessRequest.updateMany({ where: { organizationId, id, claimId, status: 'PROCESSING' }, data: { invitationId } });
    return result.count === 1;
  }

  async finish(organizationId: string, id: string, claimId: string, status: 'INVITED' | 'FAILED' | 'RESOLVED', now: Date) {
    return this.prisma.$transaction(async tx => {
      const request = await tx.accessRequest.findFirst({ where: { organizationId, id, claimId, status: 'PROCESSING' } });
      if (!request) return false;
      if (status === 'INVITED' && !request.invitationId) return false;
      const result = await tx.accessRequest.updateMany({ where: { organizationId, id, claimId, status: 'PROCESSING' }, data: { status, claimId: null, processingAt: null, decidedAt: now } });
      if (!result.count) return false;
      await new AuditRepository(this.prisma).record({ organizationId, userId: request.decidedById, action: `access_request.${status.toLowerCase()}`, entityType: 'accessRequest', entityId: id }, tx);
      return true;
    });
  }

  async reject(organizationId: string, id: string, userId: string, now: Date) {
    return this.prisma.$transaction(async tx => {
      const request = await tx.accessRequest.findFirst({ where: { organizationId, id, status: { in: ['PENDING', 'FAILED'] } } });
      if (!request) return false;
      const changed = await tx.accessRequest.updateMany({ where: { organizationId, id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'REJECTED', decidedById: userId, decidedAt: now, claimId: null, processingAt: null } });
      if (!changed.count) return false;
      // A failed/uncertain delivery may have issued a link. Rejecting withdraws only this request's links.
      await tx.invitation.updateMany({ where: { organizationId, email: request.email, status: 'PENDING', metadata: { path: ['accessRequestId'], equals: id } }, data: { status: 'REVOKED' } });
      await new AuditRepository(this.prisma).record({ organizationId, userId, action: 'access_request.rejected', entityType: 'accessRequest', entityId: id }, tx);
      return true;
    }, { isolationLevel: 'Serializable' });
  }
}
