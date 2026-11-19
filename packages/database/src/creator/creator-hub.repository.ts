import { validateCreatorContactDetails, type CreatorContactDetailsInput } from './creator-contact-details';
import { validCreatorBrandAliases } from './creator-brand-identity';
import { Prisma, type PrismaClient } from '@prisma/client';
import { membershipAuthority } from '../repositories/membership.repository';
import { IamRepository } from '../repositories/iam.repository';
import type { CreatorActor, EmgActor } from './creator-production.service';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const STAFF = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'];
export function creatorHubSettings(raw: unknown) {
  const p = object(raw),
    team = Array.isArray(p.creatorTeam)
      ? p.creatorTeam.filter((id): id is string => typeof id === 'string').slice(0, 4)
      : [];
  const aliases = object(p.creatorBrandAliases);
  return {
    team,
    aliases: Object.fromEntries(
      Object.entries(aliases).filter(
        ([a, b]) => a.length <= 120 && typeof b === 'string' && b.length <= 120,
      ),
    ) as Record<string, string>,
  };
}
/** Creator-private communications use the existing Work OS and its explicit comment visibility. */
export class CreatorHubRepository {
  constructor(private readonly db: PrismaClient) {}
  private async own(db: Prisma.TransactionClient | PrismaClient, p: CreatorActor) {
    const a = await membershipAuthority(db, p.organizationId, p.userId);
    if (!a.granted || a.systemRole !== 'CREATOR') return null;
    return db.creatorProfile.findFirst({
      where: { organizationId: p.organizationId, id: p.creatorProfileId, userId: p.userId },
    });
  }
  async ownContactDetails(p: CreatorActor) {
    if (!(await this.own(this.db, p))) return null;
    return this.db.creatorContactDetails.findFirst({
      where: { organizationId: p.organizationId, creatorProfileId: p.creatorProfileId },
    });
  }
  async managerContactDetails(p: { organizationId: string; userId: string }, profileId: string) {
    if (!(await this.manager(p))) return null;
    return this.db.creatorContactDetails.findFirst({
      where: { organizationId: p.organizationId, creatorProfileId: profileId },
    });
  }
  async saveContactDetails(p: CreatorActor, input: CreatorContactDetailsInput) {
    if (validateCreatorContactDetails(input)) return false;
    return this.db.$transaction(async (tx) => {
      if (!(await this.own(tx, p))) return false;
      await tx.creatorContactDetails.upsert({
        where: { creatorProfileId: p.creatorProfileId },
        create: { ...input, organizationId: p.organizationId, creatorProfileId: p.creatorProfileId },
        update: input,
      });
      return true;
    });
  }
  async health(p: EmgActor, profileId: string) {
    if (!(await this.manager(p))) return null;
    const profile = await this.db.creatorProfile.findFirst({
      where: { organizationId: p.organizationId, id: profileId },
    });
    if (!profile) return null;
    return this.db.creatorAnalyticsReview.findFirst({
      where: { organizationId: p.organizationId, creatorProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
      select: { state: true, failure: true, nextAttemptAt: true },
    });
  }
  async contacts(p: CreatorActor) {
    const profile = await this.own(this.db, p);
    if (!profile) return [];
    const out: { id: string; name: string; email: string }[] = [];
    for (const id of creatorHubSettings(profile.preferences).team) {
      const a = await membershipAuthority(this.db, p.organizationId, id);
      if (!a.granted || !STAFF.includes(a.systemRole)) continue;
      const user = await this.db.user.findFirst({
        where: { organizationId: p.organizationId, id, status: 'ACTIVE' },
        select: { id: true, name: true, email: true },
      });
      if (user) out.push({ ...user, name: user.name || 'EMG team member' });
    }
    return out;
  }
  async staffOptions(p: { organizationId: string; userId: string }) {
    if (!(await this.manager(p))) return [];
    const users = await this.db.user.findMany({
      where: { organizationId: p.organizationId, status: 'ACTIVE' },
      select: { id: true, name: true, email: true },
      take: 100,
      orderBy: { name: 'asc' },
    });
    const out: typeof users = [];
    for (const u of users) {
      const a = await membershipAuthority(this.db, p.organizationId, u.id);
      if (a.granted && STAFF.includes(a.systemRole)) out.push(u);
    }
    return out;
  }
  private async manager(p: { organizationId: string; userId: string }) {
    const a = await membershipAuthority(this.db, p.organizationId, p.userId);
    return (
      a.granted &&
      ['OWNER', 'ADMIN', 'MANAGER'].includes(a.systemRole) &&
      (await new IamRepository(this.db).can({ ...p, resource: 'work', action: 'update' }))
    );
  }
  async configure(
    p: { organizationId: string; userId: string },
    profileId: string,
    team: readonly string[],
    aliases: Record<string, string>,
  ) {
    if (
      !validCreatorBrandAliases(aliases) ||
      !(await this.manager(p)) ||
      team.length > 4 ||
      Object.keys(aliases).length > 100
    )
      return false;
    const options = await this.staffOptions(p);
    if (team.some((id) => !options.some((u) => u.id === id))) return false;
    if (
      Object.entries(aliases).some(
        ([a, b]) => !a.trim() || !b.trim() || a.length > 120 || b.length > 120,
      )
    )
      return false;
    return this.db.$transaction(
      async (tx) => {
        const a = await membershipAuthority(tx, p.organizationId, p.userId);
        if (
          !a.granted ||
          !['OWNER', 'ADMIN', 'MANAGER'].includes(a.systemRole) ||
          !(await new IamRepository(tx as PrismaClient).can({
            ...p,
            resource: 'work',
            action: 'update',
          }))
        )
          return false;
        const profile = await tx.creatorProfile.findFirst({
          where: { organizationId: p.organizationId, id: profileId },
        });
        if (!profile) return false;
        for (const id of team) {
          const member = await membershipAuthority(tx, p.organizationId, id);
          if (!member.granted || !STAFF.includes(member.systemRole)) return false;
        }
        await tx.creatorProfile.update({
          where: { id: profile.id },
          data: {
            preferences: {
              ...object(profile.preferences),
              creatorTeam: [...new Set(team)],
              creatorBrandAliases: aliases,
            } as Prisma.InputJsonValue,
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  private scope(p: CreatorActor) {
    return {
      organizationId: p.organizationId,
      createdByUserId: p.userId,
      AND: [
        { metadata: { path: ['creatorHubProfileId'], equals: p.creatorProfileId } },
        { metadata: { path: ['creatorHubKind'], equals: 'QUESTION' } },
      ],
    };
  }
  async alerts(p: CreatorActor) {
    if (!(await this.own(this.db, p))) return [];
    return this.db.workNotification.findMany({
      where: {
        organizationId: p.organizationId,
        userId: p.userId,
        type: 'creator_team_reply',
        readAt: null,
        workInstance: this.scope(p),
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, workInstanceId: true, createdAt: true },
    });
  }
  async markReplyRead(p: CreatorActor, id: string) {
    return this.db.$transaction(async (tx) => {
      if (!(await this.own(tx, p))) return false;
      const changed = await tx.workNotification.updateMany({
        where: {
          id,
          organizationId: p.organizationId,
          userId: p.userId,
          type: 'creator_team_reply',
          workInstance: this.scope(p),
        },
        data: { readAt: new Date() },
      });
      return changed.count === 1;
    });
  }
  async messages(p: CreatorActor) {
    if (!(await this.own(this.db, p))) return [];
    const rows = await this.db.workInstance.findMany({
      where: this.scope(p),
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        comments: {
          where: { visibility: 'creator_visible' },
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? 'Question for EMG',
      body: r.description ?? '',
      status: r.status,
      at: r.createdAt,
      brandId:
        typeof object(r.metadata).creatorBrandId === 'string'
          ? (object(r.metadata).creatorBrandId as string)
          : null,
      replies: r.comments.map((c) => ({
        id: c.id,
        body: c.body,
        at: c.createdAt,
        fromCreator: c.userId === p.userId,
      })),
    }));
  }
  async ask(
    p: CreatorActor,
    input: { body: string; brandId: string | null; brand: string | null; submission: string },
  ) {
    const body = input.body.trim();
    if (!body || body.length > 2000 || !/^[a-z0-9-]{16,80}$/i.test(input.submission)) return null;
    return this.db.$transaction(
      async (tx) => {
        const profile = await this.own(tx, p);
        if (!profile) return null;
        const where = this.scope(p),
          previous = await tx.workInstance.findFirst({
            where: {
              ...where,
              metadata: { path: ['creatorSubmission'], equals: input.submission },
            },
          });
        if (previous) return previous.id;
        if (
          (await tx.workInstance.count({
            where: { ...where, createdAt: { gte: new Date(Date.now() - 86400000) } },
          })) >= 10
        )
          return null;
        let blueprint = await tx.blueprint.findFirst({
          where: {
            organizationId: p.organizationId,
            metadata: { path: ['catalogKey'], equals: 'creator.team.question' },
          },
        });
        if (!blueprint)
          blueprint = await tx.blueprint.create({
            data: {
              organizationId: p.organizationId,
              name: 'Creator team questions',
              createdByUserId: p.userId,
              metadata: { catalogKey: 'creator.team.question', kind: 'work_type' },
            },
          });
        let owner: string | null = null;
        for (const id of creatorHubSettings(profile.preferences).team) {
          const a = await membershipAuthority(tx, p.organizationId, id);
          if (a.granted && STAFF.includes(a.systemRole)) {
            owner = id;
            break;
          }
        }
        const title = `${profile.displayName} · ${input.brand ? input.brand.slice(0, 120) : 'Question for EMG'}`;
        const row = await tx.workInstance.create({
          data: {
            organizationId: p.organizationId,
            blueprintId: blueprint.id,
            title,
            description: body,
            createdByUserId: p.userId,
            status: 'active',
            metadata: {
              kind: 'work_item',
              workTypeName: 'Creator team question',
              creatorHubKind: 'QUESTION',
              creatorHubProfileId: profile.id,
              creatorBrandId: input.brandId,
              creatorSubmission: input.submission,
              relatedRecord: { type: 'CREATOR', id: profile.id, label: profile.displayName },
              priority: 'normal',
            },
          },
        });
        const stage = await tx.workStage.create({
          data: {
            workInstanceId: row.id,
            name: 'Reply to creator',
            description: body,
            position: 1,
            status: 'ready',
            ownerUserId: owner,
            startedAt: new Date(),
          },
        });
        await tx.workInstance.update({ where: { id: row.id }, data: { currentStageId: stage.id } });
        if (owner)
          await tx.workNotification.create({
            data: {
              organizationId: p.organizationId,
              userId: owner,
              workInstanceId: row.id,
              workStageId: stage.id,
              type: 'next_action_ready',
              title: 'Creator question',
              body: title,
            },
          });
        return row.id;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  async managerMessages(p: EmgActor, profileId: string) {
    const a = await membershipAuthority(this.db, p.organizationId, p.userId);
    if (
      !a.granted ||
      !STAFF.includes(a.systemRole) ||
      (p.canActOnAnyStep &&
        !(await new IamRepository(this.db).can({ ...p, resource: 'work', action: 'view' })))
    )
      return [];
    const profile = await this.db.creatorProfile.findFirst({
      where: { organizationId: p.organizationId, id: profileId },
    });
    if (!profile?.userId) return [];
    if (!p.canActOnAnyStep && !creatorHubSettings(profile.preferences).team.includes(p.userId))
      return [];
    const rows = await this.db.workInstance.findMany({
      where: this.scope({
        organizationId: p.organizationId,
        userId: profile.userId,
        creatorProfileId: profile.id,
      }),
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        comments: {
          where: { visibility: 'creator_visible' },
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.description,
      status: r.status,
      at: r.createdAt,
      replies: r.comments.map((c) => ({ id: c.id, body: c.body, at: c.createdAt })),
    }));
  }
  async questionForWork(p: EmgActor, id: string) {
    const a = await membershipAuthority(this.db, p.organizationId, p.userId);
    if (!a.granted || !STAFF.includes(a.systemRole)) return null;
    const work = await this.db.workInstance.findFirst({
      where: { id, organizationId: p.organizationId },
      select: { metadata: true },
    });
    const metadata = object(work?.metadata);
    if (metadata.creatorHubKind !== 'QUESTION' || typeof metadata.creatorHubProfileId !== 'string')
      return null;
    const question = (await this.managerMessages(p, metadata.creatorHubProfileId)).find(
      (q) => q.id === id,
    );
    return question ? { ...question, profileId: metadata.creatorHubProfileId } : null;
  }
  async reply(p: EmgActor, profileId: string, id: string, body: string, complete: boolean) {
    if (!body.trim() || body.length > 2000) return false;
    const permitted = await this.managerMessages(p, profileId);
    if (!permitted.some((r) => r.id === id)) return false;
    return this.db.$transaction(
      async (tx) => {
        const a = await membershipAuthority(tx, p.organizationId, p.userId);
        if (
          !a.granted ||
          !STAFF.includes(a.systemRole) ||
          (p.canActOnAnyStep &&
            !(await new IamRepository(tx as PrismaClient).can({
              ...p,
              resource: 'work',
              action: 'update',
            })))
        )
          return false;
        const profile = await tx.creatorProfile.findFirst({
          where: { organizationId: p.organizationId, id: profileId },
        });
        if (
          !profile?.userId ||
          (!p.canActOnAnyStep && !creatorHubSettings(profile.preferences).team.includes(p.userId))
        )
          return false;
        const work = await tx.workInstance.findFirst({
          where: {
            ...this.scope({
              organizationId: p.organizationId,
              userId: profile.userId,
              creatorProfileId: profile.id,
            }),
            id,
          },
        });
        if (!work) return false;
        await tx.workComment.create({
          data: {
            workInstanceId: work.id,
            userId: p.userId,
            body: body.trim(),
            visibility: 'creator_visible',
          },
        });
        await tx.workNotification.create({
          data: {
            organizationId: p.organizationId,
            userId: profile.userId,
            workInstanceId: work.id,
            type: 'creator_team_reply',
            title: 'Your EMG team replied',
            body: 'A reply is available in your private creator conversation.',
          },
        });
        if (complete) {
          await tx.workStage.updateMany({
            where: { workInstanceId: work.id, status: { in: ['ready', 'in_progress'] } },
            data: { status: 'completed', completedAt: new Date() },
          });
          await tx.workInstance.update({
            where: { id: work.id },
            data: { status: 'completed', completedAt: new Date() },
          });
        }
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
