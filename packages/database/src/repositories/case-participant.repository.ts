// CaseParticipantRepository — who is involved in an investigation, and what each
// of them is being asked for.
//
// PERSISTENCE ONLY. It stores involvement; it does not decide who should be
// involved, does not write to the investigation's log, and does not create work.
// The service above it owns those, so a caller cannot half-record a participant.
//
// TENANT-SCOPED ON EVERY METHOD, AND ON BOTH SIDES OF EVERY WRITE. The
// investigation is resolved WITHIN the organization before a participant row can
// name it, and the person is resolved within the organization before they can be
// added -- so a participant from another tenant is not-found rather than
// forbidden, and cannot be attached by a caller who guessed an id.
//
// NO STATUS, NO DUE DATE, NO COMPLETION. A participant is active exactly when
// `releasedAt` is null. Every field that would describe an execution obligation
// belongs to Work OS, and there is deliberately nothing here that could hold one.

import type { CaseParticipant, PrismaClient } from '@prisma/client';
import { isCaseContribution, type CaseContribution } from '@emgloop/shared';

export interface AddParticipantInput {
  userId: string;
  contribution: CaseContribution;
  /** Why this person, in the asker's words. Required. */
  request: string;
  addedByUserId?: string | null;
  addedAt?: Date;
}

export class CaseParticipantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Add somebody to an investigation, or re-state what an existing participant is
   * being asked for.
   *
   * IDEMPOTENT ON (case, person, contribution). Re-adding the same person for the
   * same contribution updates the request and clears any release, rather than
   * accumulating a second row -- so a retry converges instead of duplicating, and
   * bringing somebody back is the same operation as adding them.
   *
   * FAILS CLOSED TO NULL when the investigation or the person does not belong to
   * this organization. There is no path here that writes a row naming either
   * across a tenant boundary.
   */
  async add(
    organizationId: string,
    priorityId: string,
    input: AddParticipantInput,
  ): Promise<CaseParticipant | null> {
    if (!isCaseContribution(input.contribution)) {
      throw new Error(`Unknown contribution "${input.contribution}"`);
    }
    if (!input.request?.trim()) {
      throw new Error('A participant must carry a stated reason for being asked');
    }

    // BOTH SIDES RESOLVED WITHIN THE ORGANIZATION FIRST. This is the leak
    // boundary: without it, a caller supplying another tenant's user id would
    // create a row joining two organizations.
    const [priority, user] = await Promise.all([
      this.prisma.operationalPriority.findFirst({
        where: { id: priorityId, organizationId },
        select: { id: true },
      }),
      this.prisma.user.findFirst({
        where: { id: input.userId, organizationId },
        select: { id: true },
      }),
    ]);
    if (!priority || !user) return null;

    const addedBy = input.addedByUserId
      ? await this.prisma.user.findFirst({
          where: { id: input.addedByUserId, organizationId },
          select: { id: true },
        })
      : null;

    const addedAt = input.addedAt ?? new Date();
    return this.prisma.caseParticipant.upsert({
      where: {
        priorityId_userId_contribution: {
          priorityId,
          userId: input.userId,
          contribution: input.contribution,
        },
      },
      create: {
        organizationId,
        priorityId,
        userId: input.userId,
        contribution: input.contribution,
        request: input.request.trim(),
        addedByUserId: addedBy?.id ?? null,
        addedAt,
      },
      update: {
        request: input.request.trim(),
        // BRINGING SOMEBODY BACK CLEARS THE RELEASE. The fact that they were once
        // released is not lost -- it is on the investigation's own log, which is
        // append-only and is where every other lifecycle fact already lives.
        releasedAt: null,
        releasedByUserId: null,
        addedByUserId: addedBy?.id ?? null,
        addedAt,
      },
    });
  }

  /**
   * Release somebody from an investigation.
   *
   * THE ROW SURVIVES. Who was asked, for what, and why is history, and deleting
   * it would make a case that has been through three people look like it was
   * always handled by one.
   */
  async release(
    organizationId: string,
    priorityId: string,
    userId: string,
    contribution: CaseContribution,
    releasedByUserId: string | null,
    releasedAt: Date = new Date(),
  ): Promise<CaseParticipant | null> {
    const found = await this.prisma.caseParticipant.findFirst({
      where: { organizationId, priorityId, userId, contribution, releasedAt: null },
    });
    if (!found) return null;
    return this.prisma.caseParticipant.update({
      where: { id: found.id },
      data: { releasedAt, releasedByUserId: releasedByUserId || null },
    });
  }

  /** Everyone ever involved in one investigation, oldest first. */
  list(organizationId: string, priorityId: string): Promise<CaseParticipant[]> {
    return this.prisma.caseParticipant.findMany({
      where: { organizationId, priorityId },
      orderBy: { addedAt: 'asc' },
    });
  }

  /**
   * Whether this person is an ACTIVE participant on this investigation.
   *
   * THE RESOLUTION AN INSTANCE-SCOPED GRANT RESTS ON, and it is deliberately one
   * query with every scope in the WHERE clause: organization, case, person, and
   * not released. A version that fetched the participants and filtered in the
   * caller would be the same shape as the cross-tenant bugs this repository has
   * already paid for -- the safe call and the unsafe one look identical at the
   * call site.
   *
   * FALSE, NEVER AN ERROR. A case in another organization, a case that does not
   * exist and a person who was released all answer the same way.
   */
  async isActiveParticipant(
    organizationId: string,
    priorityId: string,
    userId: string,
  ): Promise<boolean> {
    if (!organizationId || !priorityId || !userId) return false;
    const found = await this.prisma.caseParticipant.findFirst({
      where: { organizationId, priorityId, userId, releasedAt: null },
      select: { id: true },
    });
    return found !== null;
  }

  /** One person's current involvements across the organization's investigations. */
  listForUser(
    organizationId: string,
    userId: string,
    opts: { includeReleased?: boolean; take?: number } = {},
  ): Promise<CaseParticipant[]> {
    return this.prisma.caseParticipant.findMany({
      where: {
        organizationId,
        userId,
        ...(opts.includeReleased ? {} : { releasedAt: null }),
      },
      orderBy: { addedAt: 'desc' },
      take: Math.min(200, Math.max(1, opts.take ?? 100)),
    });
  }
}
