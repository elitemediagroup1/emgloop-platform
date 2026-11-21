import { isDeepStrictEqual } from 'node:util';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  intakeTemplate,
  readIntakeTemplate,
  intakeContent,
  validateIntakeContent,
  INTAKE_TRANSITIONS,
  type IntakeState,
  type IntakeContent,
  type IntakeTemplate,
} from '@emgloop/shared';
import { IamRepository, type Action } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { membershipAuthority } from '../repositories/membership.repository';

type Result =
  | { ok: true; id: string }
  | { ok: false; reason: 'DENIED' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT'; errors?: string[] };
export class QualificationIntakeRepository {
  constructor(private readonly db: PrismaClient) {}
  private async allowed(organizationId: string, userId: string, action: Action) {
    const iam = new IamRepository(this.db);
    return (
      (await iam.can({ organizationId, userId, resource: 'intakes', action })) &&
      (await iam.can({ organizationId, userId, resource: 'identityResolution', action: 'view' }))
    );
  }
  async partyOptions(organizationId: string, userId: string, query = '', peopleOnly = false) {
    if (!(await this.allowed(organizationId, userId, 'view'))) return null;
    const rows = await this.db.cognitiveIdentity.findMany({
      where: {
        organizationId,
        entityType: { in: peopleOnly ? ['PERSON'] : ['PERSON', 'COMPANY'] },
        archivedAt: null,
        supersededByIdentityId: null,
        establishedAt: { not: null },
        ...(query
          ? { displayName: { contains: query.slice(0, 100), mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 201,
      select: { id: true, entityType: true, displayName: true },
    });
    const refs = new PartyReferenceRepository(this.db);
    const resolutions = await refs.resolveMany(
      organizationId,
      rows.map((r) => r.id),
    );
    const identities = rows
      .slice(0, 200)
      .filter((r) => resolutions.get(r.id)?.state === 'ESTABLISHED');
    return { identities, truncated: rows.length > 200 };
  }
  async options(organizationId: string, userId: string, query = '') {
    if (!(await this.allowed(organizationId, userId, 'view'))) return null;
    const found = await this.partyOptions(organizationId, userId, query);
    if (!found) return null;
    const { identities } = found;
    const users = await this.db.user.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const owners: typeof users = [];
    for (const user of users) {
      if (await this.allowed(organizationId, user.id, 'update')) owners.push(user);
    }
    return { identities, owners, truncated: found.truncated };
  }
  async subject(organizationId: string, userId: string, partyId: string) {
    if (!(await this.allowed(organizationId, userId, 'view'))) return null;
    const resolved = await new PartyReferenceRepository(this.db).requireReferenceable(
      organizationId,
      partyId,
    );
    if (!resolved.ok) return null;
    return this.db.cognitiveIdentity.findFirst({
      where: { organizationId, id: partyId },
      select: { id: true, displayName: true, entityType: true },
    });
  }
  async opportunities(organizationId: string, userId: string, partyId: string) {
    if (
      !(await this.allowed(organizationId, userId, 'view')) ||
      !(await new IamRepository(this.db).can({
        organizationId,
        userId,
        resource: 'opportunities',
        action: 'view',
      }))
    )
      return [];
    return this.db.crmOpportunity.findMany({
      where: {
        organizationId,
        OR: [
          { creatorPartyId: partyId },
          { participants: { some: { organizationId, partyId, state: 'ACTIVE' } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, title: true },
    });
  }
  async list(
    organizationId: string,
    userId: string,
    filters: { state?: string; partyId?: string; page?: number } = {},
  ) {
    if (!(await this.allowed(organizationId, userId, 'view'))) return null;
    const page = Number.isSafeInteger(filters.page) && filters.page! > 0 ? filters.page! : 1;
    const where = {
      organizationId,
      ...(filters.state ? { state: filters.state } : {}),
      ...(filters.partyId ? { partyId: filters.partyId } : {}),
    };
    const [rows, count] = await Promise.all([
      this.db.qualificationIntake.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 30,
        take: 30,
        include: { revisions: { orderBy: { number: 'desc' }, take: 1 } },
      }),
      this.db.qualificationIntake.count({ where }),
    ]);
    const parties = await this.db.cognitiveIdentity.findMany({
      where: { organizationId, id: { in: rows.map((r) => r.partyId) } },
      select: { id: true, displayName: true },
    });
    return {
      rows: rows.map((r) => ({
        ...r,
        partyName: parties.find((p) => p.id === r.partyId)?.displayName ?? 'Identity record',
      })),
      count,
      page,
    };
  }
  async read(organizationId: string, userId: string, id: string) {
    if (!(await this.allowed(organizationId, userId, 'view'))) return null;
    const intake = await this.db.qualificationIntake.findFirst({
      where: { organizationId, id },
      include: { revisions: { orderBy: { number: 'desc' } } },
    });
    if (!intake) return null;
    const contents = intake.revisions
      .map((r) => intakeContent(r.content))
      .filter((c): c is IntakeContent => c !== null);
    const [staffNames, contactNames] = await Promise.all([
      this.db.user.findMany({
        where: {
          organizationId,
          id: {
            in: [
              ...intake.revisions.map((r) => r.recordedByUserId),
              ...contents.flatMap((c) =>
                c.nextActionOwnerUserId ? [c.nextActionOwnerUserId] : [],
              ),
            ],
          },
        },
        select: { id: true, name: true },
      }),
      this.db.cognitiveIdentity.findMany({
        where: {
          organizationId,
          id: {
            in: contents.flatMap((c) => (c.decisionMakerPartyId ? [c.decisionMakerPartyId] : [])),
          },
        },
        select: { id: true, displayName: true },
      }),
    ]);
    const canViewOpportunity = await new IamRepository(this.db).can({
      organizationId,
      userId,
      resource: 'opportunities',
      action: 'view',
    });
    const [party, opportunity, creatorProfile] = await Promise.all([
      this.db.cognitiveIdentity.findFirst({
        where: { organizationId, id: intake.partyId },
        select: { id: true, displayName: true, entityType: true },
      }),
      intake.opportunityId && canViewOpportunity
        ? this.db.crmOpportunity.findFirst({
            where: { organizationId, id: intake.opportunityId },
            select: { id: true, title: true },
          })
        : null,
      this.db.creatorProfile.findFirst({
        where: { organizationId, partyId: intake.partyId },
        select: { id: true },
      }),
    ]);
    return { ...intake, party, opportunity, creatorProfile, staffNames, contactNames };
  }
  private async references(
    organizationId: string,
    userId: string,
    partyId: string,
    opportunityId: string | null,
    template: IntakeTemplate,
    content: IntakeContent,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const refs = new PartyReferenceRepository(this.db);
    const party = await refs.requireReferenceable(organizationId, partyId, tx);
    if (!party.ok || (template.key === 'CREATOR_REPRESENTATION' && party.partyType !== 'PERSON'))
      return 'Choose an established, active CRM identity for this engagement.';
    if (content.relationshipRoles.includes('CREATOR') && party.partyType !== 'PERSON')
      return 'A creator classification requires a Person record.';
    if (content.decisionMakerPartyId) {
      const decisionMaker = await refs.requireReferenceable(
        organizationId,
        content.decisionMakerPartyId,
        tx,
      );
      if (!decisionMaker.ok || decisionMaker.partyType !== 'PERSON')
        return 'Choose an established Person as the decision-maker.';
    }
    if (opportunityId) {
      const canView = await new IamRepository(this.db).can({
        organizationId,
        userId,
        resource: 'opportunities',
        action: 'view',
      });
      const opportunity = canView
        ? await tx.crmOpportunity.findFirst({
            where: {
              organizationId,
              id: opportunityId,
              OR: [
                { creatorPartyId: partyId },
                { participants: { some: { organizationId, partyId, state: 'ACTIVE' } } },
              ],
            },
          })
        : null;
      if (!opportunity) return 'Choose an opportunity already linked to this CRM identity.';
    }
    if (content.nextActionOwnerUserId) {
      const authority = await membershipAuthority(
        tx,
        organizationId,
        content.nextActionOwnerUserId,
      );
      if (
        !authority.granted ||
        !(await this.allowed(organizationId, content.nextActionOwnerUserId, 'update'))
      )
        return 'Choose an active staff member who can work intakes.';
    }
    return null;
  }
  async create(
    organizationId: string,
    userId: string,
    input: {
      partyId: string;
      opportunityId: string | null;
      templateKey: string;
      subtype: string;
      requestKey: string;
      content: unknown;
    },
  ): Promise<Result> {
    if (!(await this.allowed(organizationId, userId, 'create')))
      return { ok: false, reason: 'DENIED' };
    const template = intakeTemplate(input.templateKey, input.subtype),
      content = intakeContent(input.content);
    if (
      !template ||
      !content ||
      input.opportunityId !== content.opportunityId ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestKey)
    )
      return { ok: false, reason: 'INVALID' };
    const errors = validateIntakeContent(template, content, 'DRAFT');
    if (errors.length) return { ok: false, reason: 'INVALID', errors };
    try {
      return await this.db.$transaction(async (tx) => {
        const duplicate = await tx.qualificationIntake.findUnique({
          where: { organizationId_requestKey: { organizationId, requestKey: input.requestKey } },
          include: { revisions: { where: { number: 1 } } },
        });
        if (duplicate) {
          const same =
            duplicate.partyId === input.partyId &&
            duplicate.templateKey === input.templateKey &&
            duplicate.subtype === input.subtype &&
            isDeepStrictEqual(duplicate.revisions[0]?.content, content);
          return same
            ? { ok: true as const, id: duplicate.id }
            : { ok: false as const, reason: 'CONFLICT' as const };
        }
        const refused = await this.references(
          organizationId,
          userId,
          input.partyId,
          input.opportunityId,
          template,
          content,
          tx,
        );
        if (refused) return { ok: false as const, reason: 'INVALID' as const, errors: [refused] };
        const row = await tx.qualificationIntake.create({
          data: {
            organizationId,
            partyId: input.partyId,
            opportunityId: input.opportunityId,
            templateKey: template.key,
            subtype: template.subtype,
            templateVersion: template.version,
            templateSnapshot: template as unknown as Prisma.InputJsonValue,
            requestKey: input.requestKey,
            createdByUserId: userId,
            revisions: {
              create: {
                number: 1,
                state: 'DRAFT',
                content: content as unknown as Prisma.InputJsonValue,
                recordedByUserId: userId,
              },
            },
          },
        });
        return { ok: true as const, id: row.id };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      )
        return { ok: false, reason: 'CONFLICT' };
      throw error;
    }
  }
  async revise(
    organizationId: string,
    userId: string,
    id: string,
    expectedRevision: number,
    state: IntakeState,
    raw: unknown,
  ): Promise<Result> {
    if (
      !(await this.allowed(organizationId, userId, 'update')) ||
      (state === 'QUALIFIED' && !(await this.allowed(organizationId, userId, 'approve')))
    )
      return { ok: false, reason: 'DENIED' };
    const content = intakeContent(raw);
    if (!content || !Number.isSafeInteger(expectedRevision) || !INTAKE_TRANSITIONS[state])
      return { ok: false, reason: 'INVALID' };
    try {
      return await this.db.$transaction(async (tx) => {
        const record = await tx.qualificationIntake.findFirst({ where: { organizationId, id } });
        if (!record) return { ok: false as const, reason: 'NOT_FOUND' as const };
        if (record.currentRevision !== expectedRevision)
          return { ok: false as const, reason: 'CONFLICT' as const };
        const template = readIntakeTemplate(record.templateSnapshot);
        if (!template || !INTAKE_TRANSITIONS[record.state as IntakeState]?.includes(state))
          return { ok: false as const, reason: 'INVALID' as const };
        const errors = validateIntakeContent(template, content, state);
        const refused = await this.references(
          organizationId,
          userId,
          record.partyId,
          content.opportunityId,
          template,
          content,
          tx,
        );
        if (refused) errors.push(refused);
        if (errors.length) return { ok: false as const, reason: 'INVALID' as const, errors };
        const changed = await tx.qualificationIntake.updateMany({
          where: { organizationId, id, currentRevision: expectedRevision },
          data: {
            currentRevision: expectedRevision + 1,
            state,
            opportunityId: content.opportunityId,
          },
        });
        if (!changed.count) return { ok: false as const, reason: 'CONFLICT' as const };
        await tx.qualificationIntakeRevision.create({
          data: {
            organizationId,
            intakeId: id,
            number: expectedRevision + 1,
            state,
            content: content as unknown as Prisma.InputJsonValue,
            recordedByUserId: userId,
          },
        });
        return { ok: true as const, id };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      )
        return { ok: false, reason: 'CONFLICT' };
      throw error;
    }
  }
}
