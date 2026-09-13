// OrganizationMembership -- CRM Phase Zero P0.2b.
//
// An authenticated User belongs to, and may act within, an Organization under a
// governed system role. Separate from the login (`User`, the authentication
// principal and the stable actor id every attribution column points at) and
// separate from identity (a membership never creates or implies a Party).
//
// THE AUTHORITY SINCE P0.2c. Session resolution and `IamRepository.can()` read a
// User's standing and system role from membership (`resolveMembershipAuthority`).
//
// DERIVED FROM THE USER ROW, IN ONE PLACE. Every lifecycle write the IamRepository makes to a User is followed, in the
// same transaction, by `syncMembershipFromUser`, which recomputes the membership
// from that row with `membershipFromUser` -- the same rule the migration's
// backfill applies in SQL. One derivation, applied after every write, is what
// keeps the two from drifting; per-call-site bookkeeping would not.
//
// THE DERIVATION IS EXACTLY WHAT THE USER ROW ALREADY MEANS -- no more.
//   role    `metadata.systemRole` when it is a string naming a real SystemRole;
//           EMPLOYEE when it is absent or not a string (what `userSystemRole`
//           has always answered); UNDERIVABLE when it is a string that is not a
//           role, because today's resolver cannot grant anything from it either.
//           An underivable user gets no membership: fail closed, and counted.
//   status  REMOVED when the user is DISABLED and carries a truthy
//           `metadata.removedAt` (what `softRemoveUser` writes and `listUsers`
//           reads); otherwise the User status verbatim. A removed marker on a
//           user who is not DISABLED is NOT read as removal -- `can()` has never
//           honoured it -- and is counted, not guessed about.
//
// ORGANIZATION FIRST, FAIL CLOSED. Every read takes organizationId first and
// resolves inside it. A membership in another organization is not-found.

import { SystemRole, MembershipStatus } from '@prisma/client';
import type { OrganizationMembership, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

const SYSTEM_ROLE_VALUES = Object.values(SystemRole) as string[];

export interface MembershipSourceUser {
  id: string;
  organizationId: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
}

export type MembershipDerivation =
  | {
      derivable: true;
      systemRole: SystemRole;
      status: MembershipStatus;
      /** The recorded removal time, when the row is REMOVED and it is a real instant. */
      removedAt: Date | null;
    }
  | { derivable: false; reason: 'UNKNOWN_SYSTEM_ROLE' | 'UNKNOWN_USER_STATUS' };

function metaOf(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * Whether a User row carries the soft-removal marker `softRemoveUser` writes.
 * JavaScript truthiness of `metadata.removedAt`, which is what `listUsers` has
 * always applied to hide a removed member. The one definition every reader of
 * the marker uses.
 */
export function hasRemovalMarker(metadata: unknown): boolean {
  return Boolean(metaOf(metadata)['removedAt']);
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;

/**
 * A recorded instant, or null. Parse-or-NULL, exactly like the migration's
 * backfill: `new Date('2026-02-30T00:00:00Z')` silently rolls over to March 2,
 * where Postgres refuses the value, so every calendar field is checked back.
 */
function recordedInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parts = ISO_INSTANT.exec(value);
  if (!parts) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const [, y, mo, da, h, mi, se] = parts.map(Number);
  const same =
    d.getUTCFullYear() === y && d.getUTCMonth() + 1 === mo && d.getUTCDate() === da &&
    d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === se;
  return same ? d : null;
}

/** The membership a User row already implies. Pure. */
export function membershipFromUser(user: Pick<MembershipSourceUser, 'status' | 'metadata'>): MembershipDerivation {
  const m = metaOf(user.metadata);
  const rawRole = m['systemRole'];
  let systemRole: SystemRole;
  if (typeof rawRole !== 'string') systemRole = SystemRole.EMPLOYEE;
  else if (SYSTEM_ROLE_VALUES.includes(rawRole)) systemRole = rawRole as SystemRole;
  else return { derivable: false, reason: 'UNKNOWN_SYSTEM_ROLE' };

  if (user.status !== 'INVITED' && user.status !== 'ACTIVE' && user.status !== 'DISABLED') {
    return { derivable: false, reason: 'UNKNOWN_USER_STATUS' };
  }
  const removed = user.status === 'DISABLED' && hasRemovalMarker(user.metadata);
  return {
    derivable: true,
    systemRole,
    status: removed ? MembershipStatus.REMOVED : (user.status as MembershipStatus),
    removedAt: removed ? recordedInstant(m['removedAt']) : null,
  };
}

/**
 * Bring the membership for this User row into line with it. Call inside the same
 * transaction as the User write, with the row as written.
 *
 * Effective dates follow the membership's own lifecycle: a new membership starts
 * at the User row's creation; leaving REMOVED starts a new period; entering
 * REMOVED ends the current one at the recorded removal time (or now, when the
 * marker is not a real instant). `invitedByUserId` is written only when the
 * caller establishes it from the session, and never cleared by a later write.
 */
export async function syncMembershipFromUser(
  db: Db,
  user: MembershipSourceUser,
  opts: { invitedByUserId?: string | null; now?: Date } = {},
): Promise<OrganizationMembership | null> {
  const derived = membershipFromUser(user);
  if (!derived.derivable) return null;
  const now = opts.now ?? new Date();
  const inviter = opts.invitedByUserId ? { invitedByUserId: opts.invitedByUserId } : {};

  const existing = await db.organizationMembership.findFirst({
    where: { userId: user.id, organizationId: user.organizationId },
  });
  if (!existing) {
    return db.organizationMembership.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        systemRole: derived.systemRole,
        status: derived.status,
        effectiveFrom: user.createdAt,
        effectiveTo: derived.status === MembershipStatus.REMOVED ? derived.removedAt ?? now : null,
        ...inviter,
      },
    });
  }

  const wasRemoved = existing.status === MembershipStatus.REMOVED;
  const isRemoved = derived.status === MembershipStatus.REMOVED;
  const period =
    wasRemoved && !isRemoved
      ? { effectiveFrom: now, effectiveTo: null }
      : !wasRemoved && isRemoved
        ? { effectiveTo: derived.removedAt ?? now }
        : {};
  const unchanged =
    existing.systemRole === derived.systemRole &&
    existing.status === derived.status &&
    Object.keys(period).length === 0 &&
    (!opts.invitedByUserId || existing.invitedByUserId === opts.invitedByUserId);
  if (unchanged) return existing;
  return db.organizationMembership.update({
    where: { id: existing.id },
    data: { systemRole: derived.systemRole, status: derived.status, ...period, ...inviter },
  });
}

/** Whether a membership lets its User act in the organization at `now`. Fails closed. */
export function isActiveMembership(
  membership: Pick<OrganizationMembership, 'status' | 'effectiveFrom' | 'effectiveTo'> | null,
  now: Date,
): boolean {
  if (!membership) return false;
  if (membership.status !== MembershipStatus.ACTIVE) return false;
  if (!(membership.effectiveFrom instanceof Date) || membership.effectiveFrom.getTime() > now.getTime()) return false;
  if (membership.effectiveTo && membership.effectiveTo.getTime() <= now.getTime()) return false;
  return true;
}

// ---- Authority (CRM P0.2c) --------------------------------------------------
//
// Membership is where a User's authority in an organization now comes from:
// whether they may act there at all, and under which system role. Session
// resolution and `IamRepository.can()` both read it through this one function.
//
// THE USER ROW STAYS A COMPATIBILITY GUARD, FAIL-CLOSED. Until `User.organizationId`
// and `metadata.systemRole` are retired (a later, separately approved cleanup),
// every membership is kept in step with its User row in the same transaction. If
// the two ever disagree -- a write that bypassed the repository, a deploy-window
// gap -- that is DRIFT, and drift denies. Authority can therefore narrow on a
// broken invariant but can never widen: nothing a membership says grants more
// than the User row it was derived from.
//
// ONE ORGANIZATION PER LOGIN, STILL. A membership in an organization the login
// does not belong to grants nothing until multi-organization sign-in is designed
// and approved. No authority is discoverable across organizations.

export const MEMBERSHIP_AUTHORITY_DENIALS = [
  'NO_USER',
  'WRONG_ORGANIZATION',
  'NO_MEMBERSHIP',
  'INACTIVE_MEMBERSHIP',
  'DRIFT',
] as const;
export type MembershipAuthorityDenial = (typeof MEMBERSHIP_AUTHORITY_DENIALS)[number];

export type MembershipAuthority =
  | { granted: true; systemRole: SystemRole; membershipId: string }
  | { granted: false; reason: MembershipAuthorityDenial };

/** Pure: may this User act in this organization now, and as what? Fails closed. */
export function resolveMembershipAuthority(args: {
  organizationId: string;
  user: Pick<MembershipSourceUser, 'id' | 'organizationId' | 'status' | 'metadata'> | null;
  membership: Pick<
    OrganizationMembership,
    'id' | 'organizationId' | 'userId' | 'systemRole' | 'status' | 'effectiveFrom' | 'effectiveTo'
  > | null;
  now: Date;
}): MembershipAuthority {
  const { organizationId, user, membership, now } = args;
  if (!user) return { granted: false, reason: 'NO_USER' };
  if (user.organizationId !== organizationId) return { granted: false, reason: 'WRONG_ORGANIZATION' };
  if (!membership || membership.organizationId !== organizationId || membership.userId !== user.id) {
    return { granted: false, reason: 'NO_MEMBERSHIP' };
  }
  if (!isActiveMembership(membership, now)) return { granted: false, reason: 'INACTIVE_MEMBERSHIP' };
  const derived = membershipFromUser(user);
  if (!derived.derivable || derived.status !== membership.status || derived.systemRole !== membership.systemRole) {
    return { granted: false, reason: 'DRIFT' };
  }
  return { granted: true, systemRole: membership.systemRole, membershipId: membership.id };
}

/** Load and resolve authority for (organizationId, userId). Organization-scoped reads only. */
export async function membershipAuthority(
  db: Db,
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<MembershipAuthority> {
  const [user, membership] = await Promise.all([
    db.user.findFirst({ where: { id: userId, organizationId } }),
    db.organizationMembership.findFirst({ where: { organizationId, userId } }),
  ]);
  return resolveMembershipAuthority({ organizationId, user, membership, now });
}

// ---- Backfill coverage (counts only) ----------------------------------------

export interface MembershipCoverage {
  users: number;
  memberships: number;
  /** Users whose row implies a membership that does not exist. */
  missingMemberships: number;
  /** Memberships whose role or status disagrees with their User row. */
  roleMismatches: number;
  statusMismatches: number;
  /** Users with a `metadata.systemRole` string that is not a role. No membership by design. */
  underivableRole: number;
  /** Users with a User status outside INVITED / ACTIVE / DISABLED. */
  underivableStatus: number;
  /** A removed marker on a user who is not DISABLED -- not read as removal. */
  removedMarkerNotDisabled: number;
  /** Memberships in this organization whose User is not a member row of it. */
  orphanMemberships: number;
}

/** Compare User rows with membership rows for one organization. Pure; counts only. */
export function compareMembershipCoverage(
  users: readonly Pick<MembershipSourceUser, 'id' | 'status' | 'metadata'>[],
  memberships: readonly Pick<OrganizationMembership, 'userId' | 'systemRole' | 'status'>[],
): MembershipCoverage {
  const byUser = new Map(memberships.map((m) => [m.userId, m]));
  const userIds = new Set(users.map((u) => u.id));
  const c: MembershipCoverage = {
    users: users.length,
    memberships: memberships.length,
    missingMemberships: 0,
    roleMismatches: 0,
    statusMismatches: 0,
    underivableRole: 0,
    underivableStatus: 0,
    removedMarkerNotDisabled: 0,
    orphanMemberships: memberships.filter((m) => !userIds.has(m.userId)).length,
  };
  for (const u of users) {
    if (u.status !== 'DISABLED' && hasRemovalMarker(u.metadata)) c.removedMarkerNotDisabled += 1;
    const d = membershipFromUser(u);
    if (!d.derivable) {
      if (d.reason === 'UNKNOWN_SYSTEM_ROLE') c.underivableRole += 1;
      else c.underivableStatus += 1;
      continue;
    }
    const m = byUser.get(u.id);
    if (!m) {
      c.missingMemberships += 1;
      continue;
    }
    if (m.systemRole !== d.systemRole) c.roleMismatches += 1;
    if (m.status !== d.status) c.statusMismatches += 1;
  }
  return c;
}

export class MembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** The membership of a User in the organization, or null. */
  findMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    return this.prisma.organizationMembership.findFirst({ where: { organizationId, userId } });
  }

  /** The membership only if it lets the User act in the organization now; otherwise null. */
  async activeMembership(
    organizationId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<OrganizationMembership | null> {
    const m = await this.findMembership(organizationId, userId);
    return isActiveMembership(m, now) ? m : null;
  }

  /** The authority a User holds in the organization now. See `resolveMembershipAuthority`. */
  authority(organizationId: string, userId: string, now: Date = new Date()): Promise<MembershipAuthority> {
    return membershipAuthority(this.prisma, organizationId, userId, now);
  }

  /** Counts only: does every User row in the organization have the membership it implies? */
  async coverage(organizationId: string): Promise<MembershipCoverage> {
    const [users, memberships] = await Promise.all([
      this.prisma.user.findMany({
        where: { organizationId },
        select: { id: true, status: true, metadata: true },
      }),
      this.prisma.organizationMembership.findMany({
        where: { organizationId },
        select: { userId: true, systemRole: true, status: true },
      }),
    ]);
    return compareMembershipCoverage(users, memberships);
  }
}
