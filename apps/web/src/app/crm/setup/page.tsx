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

  // Completed organizations never see the wizard again.
  if (settings.onboarding?.completedAt) {
    redirect('/crm');
  }

  const initial = {
    orgName: org?.name ?? '',
    orgSlug: org?.slug ?? '',
    orgIndustry: org?.industry ?? 'GENERIC',
    orgTimezone: org?.timezone ?? 'UTC',
    userName: session.name ?? '',
    userEmail: session.email ?? '',
  };

  return <SetupWizard initial={initial} />;
}
