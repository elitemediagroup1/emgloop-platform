import 'server-only';

// Identity bootstrap — Sprint 7 (Identity, Authentication & Organizations).
//
// Idempotently provisions the identity layer for the seeded demo organization
// so the CRM is immediately usable: the demo org, a Super Admin (OWNER) login,
// a Manager and a Read-Only user, and a couple of AI Employees for the picker.
// There is no email delivery, so a default password is set on the seed users
// for first sign-in; this runs only against the demo org and is safe to call
// repeatedly. All writes go through the @emgloop/database repository layer.
//
// The default credentials are surfaced on the login screen of the demo org so
// reviewers can sign in. They can be rotated via the password-reset flow.

import { prisma, repositories } from '@emgloop/database';
import { SystemRole } from '@emgloop/database';
import { hashPassword } from './auth';

export const DEMO_ORG_SLUG = 'servicesinmycity-demo';
export const DEMO_OWNER_EMAIL = 'admin@emgloop.com';
export const DEMO_DEFAULT_PASSWORD = 'EmgLoop!2026';

let bootstrapped = false;

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
  if (!user) {
    user = await repositories.iam.createUser({
      organizationId: args.organizationId,
      email: args.email,
      name: args.name,
      systemRole: args.role,
    });
  }
  if (args.activate) {
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

  bootstrapped = true;
  return { organizationId: org.id };
}
