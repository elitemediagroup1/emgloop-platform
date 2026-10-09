// CRM-owned projection for prioritizing Mail intelligence discovery.
//
// This service is deliberately OUTSIDE the intelligence/AI boundary. It performs the same exact
// Contact Point hash linkage as the People command center, then returns only Loop WorkThread ids.
// No Contact Point value, address, name, domain, body, or note crosses the boundary.
//
// The Mail producer may use these ids only to ORDER which already-governed Gmail threads it considers
// first. It still owns governance, authorization, transient body reads, model calls, and digest writes.

import type { PrismaClient } from '@prisma/client';

import { CrmContactPointRepository } from '../repositories/crm-contact-point.repository';
import { linkCorrespondents } from './crm-outreach-mail-link';

const DEFAULT_SCAN_LIMIT = 5_000;

export class CrmMailPriorityService {
  constructor(private readonly prisma: PrismaClient) {}

  async recentThreadIds(
    principal: { readonly organizationId: string; readonly userId: string },
    opts: { readonly since: Date; readonly limit: number },
  ): Promise<string[]> {
    const limit = Math.min(Math.max(opts.limit, 1), 500);
    const [index, correspondents] = await Promise.all([
      new CrmContactPointRepository(this.prisma).matchIndex(principal.organizationId, ['EMAIL']),
      this.prisma.workCorrespondent.findMany({
        where: principal,
        select: { addressHash: true, displayAddress: true },
        take: DEFAULT_SCAN_LIMIT,
      }),
    ]);
    if (index.length === 0 || correspondents.length === 0) return [];

    const links = linkCorrespondents(principal.organizationId, correspondents, index);
    const personHashes = [...links.byCorrespondent.entries()]
      .filter(([, link]) => link.kind === 'PERSON')
      .map(([hash]) => hash);
    if (personHashes.length === 0) return [];

    const messages = await this.prisma.workMessage.findMany({
      where: {
        ...principal,
        internalDate: { gte: opts.since },
        OR: [
          { fromHash: { in: personHashes } },
          { toHashes: { hasSome: personHashes } },
          { ccHashes: { hasSome: personHashes } },
        ],
      },
      select: { threadId: true },
      orderBy: [{ internalDate: 'desc' }, { messageId: 'desc' }],
      take: DEFAULT_SCAN_LIMIT,
    });

    return [...new Set(messages.map((m) => m.threadId))].slice(0, limit);
  }
}
