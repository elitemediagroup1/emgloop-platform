// AuthRepository — Sprint 7 (Identity, Authentication & Organizations).
//
// Persistence for the identity layer: looking up users for login, recording
// login timestamps, and managing UserSession + PasswordReset rows. All access
// goes through Prisma here so the web app's auth library never touches the
// client directly, consistent with the Sprint 4 repository layer.
//
// Password HASHES are stored in User.metadata.passwordHash (the schema keeps
// auth provider-agnostic and stores no raw passwords). Hashing/verification +
// token signing live in the web app's auth lib using Node's built-in crypto;
// this repository only reads/writes the stored values.

import type { PrismaClient, User, UserSession } from '@prisma/client';

export interface SessionWithUser {
  session: UserSession;
  user: User;
}

function meta(u: { metadata: unknown }): Record<string, unknown> {
  return u.metadata && typeof u.metadata === 'object'
    ? (u.metadata as Record<string, unknown>)
    : {};
}

export class AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Find a user by organization + email (login lookup). */
  findUserByEmail(organizationId: string, email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { organizationId_email: { organizationId, email: email.toLowerCase().trim() } },
    });
  }

  /** Find the first user across all orgs with this email (org-less login). */
  findAnyUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { email: email.toLowerCase().trim() },
      orderBy: { createdAt: 'asc' },
    });
  }

  findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Read the stored password hash for a user (null if none set). */
  async getPasswordHash(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    if (!u) return null;
    const h = meta(u).passwordHash;
    return typeof h === 'string' ? h : null;
  }

  /** Store a password hash in user.metadata (merging, never clobbering). */
  async setPasswordHash(userId: string, hash: string): Promise<User> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    const current = u ? meta(u) : {};
    return this.prisma.user.update({
      where: { id: userId },
      data: { metadata: { ...current, passwordHash: hash } as object },
    });
  }

  recordLogin(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date(), status: 'ACTIVE' },
    });
  }

  // --- Sessions ---------------------------------------------------------

  createSession(args: {
    organizationId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<UserSession> {
    return this.prisma.userSession.create({
      data: {
        organizationId: args.organizationId,
        userId: args.userId,
        authProvider: 'PASSWORD',
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
        lastUsedAt: new Date(),
      },
    });
  }

  /** Resolve a session by token hash -> session + user, or null if missing,
      revoked, or expired. Touches lastUsedAt on success. */
  async resolveSession(tokenHash: string): Promise<SessionWithUser | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) return null;
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return null;
    if (user.status === 'DISABLED') return null;
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
    return { session, user };
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // --- Password resets --------------------------------------------------

  createPasswordReset(args: {
    organizationId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string }> {
    return this.prisma.passwordReset.create({
      data: {
        organizationId: args.organizationId,
        userId: args.userId,
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
      },
      select: { id: true },
    });
  }

  async consumePasswordReset(
    tokenHash: string,
  ): Promise<{ userId: string; organizationId: string } | null> {
    const row = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!row) return null;
    if (row.usedAt) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    await this.prisma.passwordReset.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    return { userId: row.userId, organizationId: row.organizationId };
  }
}
