// EMG Creator Operations: the two login reads the creator-hub pages need (Creator Hub, 2026-09-22).
// SERVER ONLY. Both go through IamRepository, scoped to the organization the caller's session
// named; nothing here touches Prisma. Nothing else lives here.

import 'server-only';

import { repositories } from '@emgloop/database';

export interface CreatorLogin {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/** ACTIVE logins in this organization that hold the CREATOR role: the only ones a profile may be bound to. */
export async function listCreatorLogins(organizationId: string): Promise<CreatorLogin[]> {
  const users = await repositories.iam.listUsers(organizationId);
  return users
    .filter((u) => u.status === 'ACTIVE' && u.systemRole === 'CREATOR')
    .map((u) => ({ id: u.id, name: u.name, email: u.email }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.email.localeCompare(b.email));
}

/** The login bound to a profile, within this organization, or null. */
export async function loginOf(organizationId: string, userId: string | null): Promise<(CreatorLogin & { status: string }) | null> {
  if (!userId) return null;
  const u = await repositories.iam.getUser(organizationId, userId);
  return u ? { id: u.id, name: u.name, email: u.email, status: u.status } : null;
}
