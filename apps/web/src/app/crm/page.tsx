import { redirect } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { requireSession } from '../../auth/guard';

export const dynamic = 'force-dynamic';

// Sprint 24 — /crm dashboard root is retired as a competing dashboard.
//
// The canonical Workspace Home is /app/admin (config-driven via the role
// router). This root now does exactly two things and nothing else:
//   1. Preserve the Sprint 21 Owner Setup Wizard gate: an OWNER/ADMIN whose
//      organization has not completed onboarding is sent to /crm/setup.
//   2. Otherwise hand off to /app, the single role-router entry, so every role
//      lands on ITS OWN workspace home (employees are NOT forced to /app/admin).
//
// All functional CRM feature routes (/crm/customers, /crm/conversations,
// /crm/users, /crm/settings, /crm/audit, ...) are untouched — only this
// dashboard root redirects.
export default async function CrmRootRedirect() {
  // requireSession redirects unauthenticated visitors to /crm/login (unchanged).
  const session = await requireSession('/crm');

  // Preserve the owner onboarding gate before handing off to the role router.
  const role = session.systemRole;
  if (role === 'OWNER' || role === 'ADMIN') {
    const org = await prisma.organization.findUnique({
      where: { id: session.organizationId },
      select: { settings: true },
    });
    const onboarding = (org?.settings as { onboarding?: { completedAt?: string } } | null)
      ?.onboarding;
    if (!onboarding?.completedAt) {
      redirect('/crm/setup');
    }
  }

  // Config-driven role routing decides the correct home for every role.
  redirect('/app');
}
