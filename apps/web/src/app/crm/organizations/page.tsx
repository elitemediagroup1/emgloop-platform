import { redirect } from 'next/navigation';
import { requirePermission } from '../../../auth/guard';

// Workspace organization entry point.
//
// The current release is tenant-local: a session belongs to exactly one
// organization, and a tenant must not discover any other. This route therefore
// lists nothing and looks nothing up. It authorizes, then sends the user to their
// own session organization's record, where the id is checked again.

export const dynamic = 'force-dynamic';

export default async function OrganizationsPage() {
  const session = await requirePermission('organizations', 'view');
  redirect(`/crm/organizations/${encodeURIComponent(session.organizationId)}`);
}
