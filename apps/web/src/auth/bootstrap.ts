import 'server-only';

// Identity bootstrap — Sprint 7 (Identity, Authentication & Organizations).
//
// Resolves the organization the app runs against, and — ONLY in an explicitly
// enabled non-production environment — seeds demo identities (an OWNER login, a
// Manager and a Read-Only reviewer, a default AI Employee) so a review deploy is
// immediately usable without email delivery.
//
// PRODUCTION SAFETY (the reason this file was rewritten): the demo seed used to
// run on every cold start. Because it "ensured + activated" each user, it
// fabricated team members (Morgan Manager, Riley Viewer) and, worse, resurrected
// any member an admin had removed — the Team-page "deleted users keep returning"
// bug. Seeding is now fail-closed behind isDemoSeedEnabled(): production seeds
// nothing, and even in a review environment a deliberately removed/disabled user
// is never reactivated. The org upsert is kept unconditional — it only resolves
// the tenant the platform already runs on; it creates no people.

import { headers } from 'next/headers';
import { prisma, repositories } from '@emgloop/database';
import { SystemRole } from '@emgloop/database';
import { isDemoSeedEnabled, seedMayActivate } from '@emgloop/shared';
import { hashPassword } from './auth';

export const DEMO_ORG_SLUG = 'servicesinmycity-demo';
export const DEMO_OWNER_EMAIL = 'admin@emgloop.com';
export const DEMO_DEFAULT_PASSWORD = 'EmgLoop!2026';

let bootstrapped = false;

/**
 * Whether this runtime may seed demo identities. Fail-closed: requires the
 * explicit EMG_SEED_DEMO opt-in AND a non-production runtime (host / CONTEXT /
 * NODE_ENV). The host is read from request headers when available so a preview
 * deploy is correctly identified; if headers are unavailable we still fail closed
 * on CONTEXT/NODE_ENV.
 */
function demoSeedAllowed(): boolean {
  let host: string | null = null;
  try {
    const h = headers();
    host = h.get('x-forwarded-host') || h.get('host');
  } catch {
    host = null;
  }
  return isDemoSeedEnabled(process.env, host);
}

async function ensureUser(args: {
  organizationId: string;
  email: string;
  name: string;
  role: SystemRole;
  password?: string;
  activate?: boolean;
}): Promise<void> {
  // Idempotent: reuse the existing user if present, otherwise create it.
  // createUser() performs a plain insert, so a blind create would throw a
  // P2002 unique-constraint error on every cold start once the seed users
  // already exist in the shared database.
  let user = await repositories.auth.findUserByEmail(args.organizationId, args.email);
  const created = !user;
  if (!user) {
    user = await repositories.iam.createUser({
      organizationId: args.organizationId,
      email: args.email,
      name: args.name,
      systemRole: args.role,
    });
  }
  // Never resurrect a member an admin removed or disabled: only a freshly-created
  // or still-pending (INVITED) row may be activated. A DISABLED row is left as-is,
  // so re-running the seed cannot re-grant access an admin revoked.
  if (args.activate && seedMayActivate(user.status, created)) {
    await repositories.iam.activateUser(args.organizationId, user.id);
  }
  if (args.password) {
    const existing = await repositories.auth.getPasswordHash(user.id);
    if (!existing) {
      await repositories.auth.setPasswordHash(user.id, hashPassword(args.password));
    }
  }
}

/**
 * Ensure the demo org + seed identities exist. Safe to call on every login /
 * CRM load: it short-circuits after the first successful run per server
 * instance and every underlying write is an idempotent upsert.
 */
export async function ensureCrmIdentity(): Promise<{ organizationId: string }> {
  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: {
      name: 'ServicesInMyCity (Demo)',
      slug: DEMO_ORG_SLUG,
      industry: 'HOME_SERVICES',
      status: 'ACTIVE',
      sourceKey: 'servicesinmycity',
      timezone: 'America/Chicago',
    },
    select: { id: true },
  });

  if (bootstrapped) return { organizationId: org.id };
  bootstrapped = true;

  // Fail closed: outside an explicitly-enabled non-production environment, seed
  // NOTHING. Production never fabricates users/team members and never resurrects
  // a removed member. The tenant (org) is already resolved above.
  if (!demoSeedAllowed()) return { organizationId: org.id };

  await ensureUser({
    organizationId: org.id,
    email: DEMO_OWNER_EMAIL,
    name: 'EMG Admin',
    role: SystemRole.OWNER,
    password: DEMO_DEFAULT_PASSWORD,
    activate: true,
  });
  await ensureUser({
    organizationId: org.id,
    email: 'manager@emgloop.com',
    name: 'Morgan Manager',
    role: SystemRole.MANAGER,
    password: DEMO_DEFAULT_PASSWORD,
    activate: true,
  });
  await ensureUser({
    organizationId: org.id,
    email: 'viewer@emgloop.com',
    name: 'Riley Viewer',
    role: SystemRole.READ_ONLY,
    password: DEMO_DEFAULT_PASSWORD,
    activate: true,
  });

  // Ensure at least the default AI Employee exists for the picker.
  await repositories.aiEmployees.ensureDefault({
    organizationId: org.id,
    name: 'Ava',
    title: 'Front Desk AI Employee',
  });

  return { organizationId: org.id };
}
