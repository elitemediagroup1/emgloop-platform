// Manager-authorized shared mail sources. Never reads or replaces a person's private GoogleConnection.
import { randomUUID } from 'crypto';
import type {
  Prisma,
  PrismaClient,
  ManagedGoogleMailbox,
  ManagedGoogleOAuthState,
} from '@prisma/client';
import { membershipAuthority } from '../repositories/membership.repository';
import { AuditRepository } from '../repositories/audit.repository';
import type {
  GoogleSessionPrincipal,
  GooglePrincipal,
} from '../services/google/google-workspace.service';
import type { SealedGoogleToken } from '../services/google/google-token-sealer';
import { absentUntilMigrated } from './until-migrated';

type Db = Prisma.TransactionClient;
export const MANAGED_GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const MANAGED_MAILBOX_STATE_PREFIX = 'mm1_';
export type ManagedMailboxOutcome =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'DECLINED'
  | 'NOT_ALLOWED'
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'STATE_INVALID'
  | 'WRONG_ACCOUNT'
  | 'SCOPE_REFUSED'
  | 'CONFLICT'
  | 'FAILED'
  | 'TOO_MANY_ATTEMPTS';
export type ManagedMailboxSummary = Pick<
  ManagedGoogleMailbox,
  | 'id'
  | 'kind'
  | 'creatorProfileId'
  | 'expectedEmail'
  | 'status'
  | 'connectedAt'
  | 'lastFailureClass'
>;
export const normalizedMailboxEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)
    ? email
    : null;
};
function profileEmail(preferences: unknown): string | null {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return null;
  const value = (preferences as Record<string, unknown>).managedMailboxEmail;
  return typeof value === 'string' ? normalizedMailboxEmail(value) : null;
}
const summarySelect = {
  id: true,
  kind: true,
  creatorProfileId: true,
  expectedEmail: true,
  status: true,
  connectedAt: true,
  lastFailureClass: true,
} as const;

export class ManagedMailboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async permittedFor(principal: GooglePrincipal, action: 'view' | 'update'): Promise<boolean> {
    return this.permitted(this.prisma, principal, action);
  }

  async target(principal: GooglePrincipal, mailboxId: string) {
    if (!(await this.permitted(this.prisma, principal, 'view'))) return null;
    return this.prisma.managedGoogleMailbox.findFirst({
      where: { organizationId: principal.organizationId, id: mailboxId },
      select: summarySelect,
    });
  }

  async permitted(
    db: Db,
    principal: GooglePrincipal,
    action: 'view' | 'update',
    now = new Date(),
  ): Promise<boolean> {
    const member = await membershipAuthority(db, principal.organizationId, principal.userId, now);
    if (!member.granted || !['OWNER', 'ADMIN', 'MANAGER'].includes(member.systemRole)) return false;
    return !(await db.permission.findFirst({
      where: {
        organizationId: principal.organizationId,
        resource: { in: ['googleWorkspace', 'managedMailboxes'] },
        action,
        effect: 'DENY',
        OR: [{ userId: principal.userId }, { systemRole: member.systemRole }],
      },
      select: { id: true },
    }));
  }

  private async session(db: Db, principal: GoogleSessionPrincipal, now: Date): Promise<boolean> {
    return !!(await db.userSession.findFirst({
      where: {
        id: principal.sessionId,
        organizationId: principal.organizationId,
        userId: principal.userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    }));
  }

  private async assignment(
    db: Db,
    organizationId: string,
    profileId: string | null,
    email: string,
  ): Promise<boolean> {
    if (!profileId) return true;
    const profile = await db.creatorProfile.findFirst({
      where: { organizationId, id: profileId },
      select: { preferences: true },
    });
    return !!profile && profileEmail(profile.preferences) === email;
  }

  /** Credential-free inventory, scoped to managers. Null also honestly covers an unapplied migration. */
  async inventory(
    principal: GooglePrincipal,
    profileId: string | null,
  ): Promise<ManagedMailboxSummary[] | null> {
    if (!(await this.permitted(this.prisma, principal, 'view'))) return null;
    return absentUntilMigrated(
      this.prisma.managedGoogleMailbox.findMany({
        where: {
          organizationId: principal.organizationId,
          creatorProfileId: profileId,
          kind: profileId ? 'CREATOR' : 'STAFF',
        },
        select: summarySelect,
        orderBy: [{ expectedEmail: 'asc' }],
        take: 101,
      }),
    );
  }

  async creatorAddress(principal: GooglePrincipal, profileId: string): Promise<string | null> {
    if (!(await this.permitted(this.prisma, principal, 'view'))) return null;
    const profile = await this.prisma.creatorProfile.findFirst({
      where: { organizationId: principal.organizationId, id: profileId },
      select: { preferences: true },
    });
    return profile ? profileEmail(profile.preferences) : null;
  }

  async begin(
    principal: GoogleSessionPrincipal,
    input: {
      creatorProfileId: string | null;
      expectedEmail: string;
      stateHash: string;
      nonceHash: string;
      now: Date;
    },
  ): Promise<
    { outcome: 'OPENED'; mailboxId: string; email: string } | { outcome: ManagedMailboxOutcome }
  > {
    const email = normalizedMailboxEmail(input.expectedEmail);
    if (!email) return { outcome: 'INVALID_REQUEST' };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          if (
            !(await this.permitted(tx, principal, 'update', input.now)) ||
            !(await this.session(tx, principal, input.now)) ||
            !(await this.assignment(tx, principal.organizationId, input.creatorProfileId, email))
          )
            return { outcome: 'NOT_ALLOWED' as const };
          const kind = input.creatorProfileId ? 'CREATOR' : 'STAFF';
          const existing = await tx.managedGoogleMailbox.findFirst({
            where: {
              organizationId: principal.organizationId,
              OR: [
                { expectedEmail: email },
                ...(input.creatorProfileId ? [{ creatorProfileId: input.creatorProfileId }] : []),
              ],
            },
          });
          if (
            existing &&
            (existing.kind !== kind ||
              existing.creatorProfileId !== input.creatorProfileId ||
              (existing.expectedEmail !== email && existing.status === 'CONNECTED'))
          )
            return { outcome: 'CONFLICT' as const };
          await tx.managedGoogleOAuthState.deleteMany({
            where: {
              organizationId: principal.organizationId,
              userId: principal.userId,
              OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: input.now } }],
            },
          });
          if (
            (await tx.managedGoogleOAuthState.count({
              where: { organizationId: principal.organizationId, userId: principal.userId },
            })) >= 10
          )
            return { outcome: 'TOO_MANY_ATTEMPTS' as const };
          const row =
            existing && existing.expectedEmail === email
              ? existing
              : existing
                ? await tx.managedGoogleMailbox.update({
                    where: { id: existing.id },
                    data: {
                      expectedEmail: email,
                      revision: randomUUID(),
                      status: 'PENDING',
                      activeGoogleSubject: null,
                      googleSubject: null,
                      grantedScopes: [],
                      authorizedByUserId: principal.userId,
                    },
                  })
                : await tx.managedGoogleMailbox.create({
                    data: {
                      organizationId: principal.organizationId,
                      creatorProfileId: input.creatorProfileId,
                      authorizedByUserId: principal.userId,
                      expectedEmail: email,
                      kind,
                      status: 'PENDING',
                      revision: randomUUID(),
                    },
                  });
          await tx.managedGoogleOAuthState.create({
            data: {
              organizationId: principal.organizationId,
              userId: principal.userId,
              sessionId: principal.sessionId,
              mailboxId: row.id,
              expectedEmail: email,
              revision: row.revision,
              stateHash: input.stateHash,
              nonceHash: input.nonceHash,
              expiresAt: new Date(input.now.getTime() + 600_000),
            },
          });
          return { outcome: 'OPENED' as const, mailboxId: row.id, email };
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (['P2002', 'P2034'].includes(String((error as { code?: string }).code)))
        return { outcome: 'CONFLICT' };
      throw error;
    }
  }

  async consume(
    principal: GoogleSessionPrincipal,
    stateHash: string,
    now: Date,
  ): Promise<ManagedGoogleOAuthState | null> {
    if (
      !(await this.permitted(this.prisma, principal, 'update', now)) ||
      !(await this.session(this.prisma, principal, now))
    )
      return null;
    const where = {
      organizationId: principal.organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      stateHash,
    };
    const result = await this.prisma.managedGoogleOAuthState.updateMany({
      where: { ...where, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return result.count === 1 ? this.prisma.managedGoogleOAuthState.findFirst({ where }) : null;
  }

  async store(
    principal: GoogleSessionPrincipal,
    attempt: ManagedGoogleOAuthState,
    grant: { subject: string; email: string; sealed: SealedGoogleToken; now: Date },
  ): Promise<ManagedMailboxOutcome> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          if (
            !(await this.permitted(tx, principal, 'update', grant.now)) ||
            !(await this.session(tx, principal, grant.now))
          )
            return 'NOT_ALLOWED';
          const consumed = await tx.managedGoogleOAuthState.findFirst({
            where: {
              id: attempt.id,
              organizationId: principal.organizationId,
              userId: principal.userId,
              sessionId: principal.sessionId,
              mailboxId: attempt.mailboxId,
              stateHash: attempt.stateHash,
              revision: attempt.revision,
              expectedEmail: attempt.expectedEmail,
              consumedAt: { not: null },
              expiresAt: { gt: grant.now },
            },
            select: { id: true },
          });
          if (!consumed) return 'STATE_INVALID';
          const row = await tx.managedGoogleMailbox.findFirst({
            where: {
              organizationId: principal.organizationId,
              id: attempt.mailboxId,
              revision: attempt.revision,
              expectedEmail: attempt.expectedEmail,
            },
          });
          if (
            !row ||
            !(await this.assignment(
              tx,
              principal.organizationId,
              row.creatorProfileId,
              attempt.expectedEmail,
            ))
          )
            return 'CONFLICT';
          if (
            normalizedMailboxEmail(grant.email) !== row.expectedEmail ||
            (row.status === 'CONNECTED' && row.googleSubject !== grant.subject)
          )
            return 'WRONG_ACCOUNT';
          const other = await tx.managedGoogleMailbox.findFirst({
            where: {
              organizationId: principal.organizationId,
              activeGoogleSubject: grant.subject,
              NOT: { id: row.id },
            },
            select: { id: true },
          });
          if (other) return 'CONFLICT';
          const changed = await tx.managedGoogleMailbox.updateMany({
            where: {
              organizationId: principal.organizationId,
              id: row.id,
              revision: attempt.revision,
            },
            data: {
              googleSubject: grant.subject,
              activeGoogleSubject: grant.subject,
              status: 'CONNECTED',
              grantedScopes: [MANAGED_GMAIL_READ_SCOPE],
              refreshTokenSealed: Buffer.from(grant.sealed.sealed),
              sealVersion: grant.sealed.sealVersion,
              keyRef: grant.sealed.keyRef,
              connectedAt: grant.now,
              disconnectedAt: null,
              lastFailureClass: null,
              authorizedByUserId: principal.userId,
              revision: randomUUID(),
            },
          });
          if (changed.count !== 1) return 'CONFLICT';
          await new AuditRepository(this.prisma).record(
            {
              organizationId: principal.organizationId,
              userId: principal.userId,
              action: 'managed_mailbox.connected',
              entityType: 'managed_mailbox',
              entityId: row.id,
              metadata: { kind: row.kind, creatorProfileId: row.creatorProfileId, readOnly: true },
            },
            tx,
          );
          return 'CONNECTED';
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (['P2002', 'P2034'].includes(String((error as { code?: string }).code))) return 'CONFLICT';
      throw error;
    }
  }

  /** Authorizer standing and current assignment must hold for every later use. */
  async credential(
    principal: GooglePrincipal,
    mailboxId: string,
  ): Promise<ManagedGoogleMailbox | null> {
    if (!(await this.permitted(this.prisma, principal, 'view'))) return null;
    const row = await this.prisma.managedGoogleMailbox.findFirst({
      where: { organizationId: principal.organizationId, id: mailboxId, status: 'CONNECTED' },
    });
    if (
      !row?.refreshTokenSealed ||
      !row.googleSubject ||
      !(await this.permitted(
        this.prisma,
        { organizationId: row.organizationId, userId: row.authorizedByUserId },
        'update',
      )) ||
      !(await this.assignment(
        this.prisma,
        row.organizationId,
        row.creatorProfileId,
        row.expectedEmail,
      ))
    )
      return null;
    return row;
  }

  async expire(
    principal: GooglePrincipal,
    mailboxId: string,
    revision: string,
    failure: 'REFRESH_REFUSED' | 'TOKEN_UNOPENABLE',
  ): Promise<void> {
    if (!(await this.permitted(this.prisma, principal, 'view'))) return;
    await this.prisma.managedGoogleMailbox.updateMany({
      where: {
        organizationId: principal.organizationId,
        id: mailboxId,
        revision,
        status: 'CONNECTED',
      },
      data: {
        status: 'EXPIRED',
        refreshTokenSealed: null,
        sealVersion: null,
        keyRef: null,
        lastFailureClass: failure,
        revision: randomUUID(),
      },
    });
  }

  async disconnect(
    principal: GooglePrincipal,
    mailboxId: string,
    now: Date,
  ): Promise<ManagedMailboxOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        if (!(await this.permitted(tx, principal, 'update', now))) return 'NOT_ALLOWED';
        const row = await tx.managedGoogleMailbox.findFirst({
          where: { organizationId: principal.organizationId, id: mailboxId },
        });
        if (!row) return 'NOT_ALLOWED';
        await tx.managedGoogleMailbox.updateMany({
          where: { organizationId: principal.organizationId, id: mailboxId },
          data: {
            status: 'DISCONNECTED',
            refreshTokenSealed: null,
            sealVersion: null,
            keyRef: null,
            activeGoogleSubject: null,
            disconnectedAt: now,
            revision: randomUUID(),
          },
        });
        await tx.managedGoogleOAuthState.deleteMany({
          where: { organizationId: principal.organizationId, mailboxId },
        });
        await new AuditRepository(this.prisma).record(
          {
            organizationId: principal.organizationId,
            userId: principal.userId,
            action: 'managed_mailbox.disconnected',
            entityType: 'managed_mailbox',
            entityId: row.id,
          },
          tx,
        );
        return 'DISCONNECTED';
      },
      { isolationLevel: 'Serializable' },
    );
  }
}

/** Called by IAM inside the same offboarding transaction, only if the additive tables exist. */
export async function endManagedMailboxesInTx(
  tx: Db,
  organizationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  await tx.managedGoogleMailbox.updateMany({
    where: { organizationId, authorizedByUserId: userId },
    data: {
      status: 'DISCONNECTED',
      refreshTokenSealed: null,
      sealVersion: null,
      keyRef: null,
      activeGoogleSubject: null,
      disconnectedAt: now,
      revision: randomUUID(),
      lastFailureClass: 'AUTHORIZER_OFFBOARDED',
    },
  });
  await tx.managedGoogleOAuthState.deleteMany({ where: { organizationId, userId } });
}

export async function managedMailboxTablesPresent(
  prisma: PrismaClient,
  organizationId: string,
): Promise<boolean> {
  if (!('managedGoogleMailbox' in prisma)) return false;
  return (
    (await absentUntilMigrated(
      prisma.managedGoogleMailbox.findMany({
        where: { organizationId },
        select: { id: true },
        take: 1,
      }),
    )) !== null
  );
}

export async function endManagedCreatorMailboxInTx(
  tx: Db,
  organizationId: string,
  creatorProfileId: string,
  now: Date,
): Promise<void> {
  const rows = await tx.managedGoogleMailbox.findMany({
    where: { organizationId, creatorProfileId },
    select: { id: true },
  });
  if (!rows.length) return;
  await tx.managedGoogleMailbox.updateMany({
    where: { organizationId, creatorProfileId },
    data: {
      status: 'DISCONNECTED',
      refreshTokenSealed: null,
      sealVersion: null,
      keyRef: null,
      activeGoogleSubject: null,
      disconnectedAt: now,
      revision: randomUUID(),
      lastFailureClass: 'ASSIGNMENT_CHANGED',
    },
  });
  await tx.managedGoogleOAuthState.deleteMany({
    where: { organizationId, mailboxId: { in: rows.map((r) => r.id) } },
  });
}
