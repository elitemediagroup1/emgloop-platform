import { redirect } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { requirePermission } from '../../../auth/guard';
import { SetupWizard } from './SetupWizard';
import './setup.css';

// Sprint 21 — Owner Setup Wizard (first-login experience).
//
// Server-gated route. Only organization owners/admins may enter setup: the
// guard performs a deny-by-default 'settings:manage' check (OWNER and ADMIN
// hold that grant; MANAGER/EMPLOYEE/READ_ONLY do not and are redirected to
// /crm/unauthorized). If the organization has already completed setup, the
// wizard is skipped and the user is sent to the canonical workspace. This
// route does not implement an admin edit mode.
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // Re-derive the actor from the session and enforce owner/admin access.
  const session = await requirePermission('settings', 'manage');
  const orgId = session.organizationId;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, slug: true, industry: true, timezone: true, settings: true },
  });

  const settings = (org?.settings ?? {}) as {
    onboarding?: { completedAt?: string };
    workspace?: Record<string, unknown>;
  };

  const owner = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true, metadata: true },
  });
  const ownerName = owner?.name ?? '';
  const savedProfile =
    owner?.metadata && typeof owner.metadata === 'object'
      ? ((owner.metadata as Record<string, unknown>).profile as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const str = (v: unknown): string =>
    typeof v === 'string' ? v : '';
  const [derivedFirst, ...derivedRest] = ownerName.trim().split(/\s+/);
  const profile = {
    firstName: savedProfile ? str(savedProfile.firstName) : (derivedFirst ?? ''),
    lastName: savedProfile
      ? str(savedProfile.lastName)
      : derivedRest.join(' '),
    preferredName: savedProfile ? str(savedProfile.preferredName) : '',
    jobTitle: savedProfile ? str(savedProfile.jobTitle) : '',
    phone: savedProfile ? str(savedProfile.phone) : '',
    timezone: savedProfile ? str(savedProfile.timezone) : '',
  };

  // Prefer the organization's own primary email (persisted under
  // settings.workspace.primaryEmail) so the Organization step defaults to the
  // company address rather than the logged-in owner's personal email.
  const orgEmail = str(settings.workspace?.primaryEmail);

  // Completed organizations never see the wizard again.
  if (settings.onboarding?.completedAt) {
    redirect('/crm');
  }

  const initial = {
    orgName: org?.name ?? '',
    orgSlug: org?.slug ?? '',
    orgEmail,
    orgIndustry: org?.industry ?? 'GENERIC',
    orgTimezone: org?.timezone ?? 'UTC',
    userName: session.name ?? '',
    userEmail: session.email ?? '',
    firstName: profile.firstName,
    lastName: profile.lastName,
    preferredName: profile.preferredName,
    jobTitle: profile.jobTitle,
    userPhone: profile.phone,
    userTimezone: profile.timezone,
  };

  return <SetupWizard initial={initial} />;
}
