// What Brain work may be about, and where each subject lives. Slice B5.
//
// A submission names a subject by type and id. Before anything is recorded, the subject
// must exist IN THE CALLER'S ORGANIZATION and be a kind of record Loop actually holds.
// A subject in another organization is simply not found; a subject type whose authority
// is not built (a Brain conversation, a Campaign) is never accepted.
//
// Links are the owners' own pages, which enforce their own guards. Brain never renders
// the record; it only says where it is.

import type { PrismaClient } from '@prisma/client';
import type { BrainResultSubjectType } from '@emgloop/shared';

export interface BrainSubject {
  readonly type: BrainResultSubjectType;
  readonly id: string;
}

export interface BrainSubjectResolver {
  /** Whether the subject is a live record of this organization that Brain may work on. */
  exists(organizationId: string, subject: BrainSubject): Promise<boolean>;
  /** The owner's page for the subject, or null where none exists. */
  href(subject: BrainSubject): string | null;
}

/** Subject types whose authority exists today. Everything else is refused. */
export const BRAIN_BUILT_SUBJECT_TYPES: readonly BrainResultSubjectType[] = Object.freeze([
  'CASE',
  'RELATIONSHIP',
  'CUSTOMER_CONVERSATION',
]);

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class PrismaBrainSubjectResolver implements BrainSubjectResolver {
  constructor(private readonly prisma: PrismaClient) {}

  async exists(organizationId: string, subject: BrainSubject): Promise<boolean> {
    if (!organizationId || !ID.test(subject.id)) return false;
    switch (subject.type) {
      case 'CASE':
        return (await this.prisma.operationalPriority.findFirst({ where: { id: subject.id, organizationId }, select: { id: true } })) !== null;
      case 'RELATIONSHIP':
        return (
          (await this.prisma.crmRelationship.findFirst({
            where: { id: subject.id, organizationId, state: { not: 'VOIDED' } },
            select: { id: true },
          })) !== null
        );
      case 'CUSTOMER_CONVERSATION':
        return (await this.prisma.conversation.findFirst({ where: { id: subject.id, organizationId }, select: { id: true } })) !== null;
      default:
        return false;
    }
  }

  href(subject: BrainSubject): string | null {
    return brainSubjectHref(subject);
  }
}

export function brainSubjectHref(subject: BrainSubject): string | null {
  if (!ID.test(subject.id)) return null;
  switch (subject.type) {
    case 'CASE':
      return `/app/admin/cases/${subject.id}`;
    case 'RELATIONSHIP':
      return `/crm/relationships/${subject.id}`;
    case 'CUSTOMER_CONVERSATION':
      return `/crm/conversations/${subject.id}`;
    default:
      return null;
  }
}
