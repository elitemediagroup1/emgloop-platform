import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { requireWorkspaceSession } from '../../../workspaces/guard';

export const dynamic = 'force-dynamic';

// The CRM area under /app/crm (handoff 2026-09-16; D1 prefix). It holds the
// redesigned CRM slice; the rest of the CRM still lives under /crm, in the same shell.
//
// The layout only requires a signed-in session and renders the one Loop shell. It
// is not the boundary: every page here enforces its own permission before reading.

export default async function CrmAreaLayout({ children }: { children: React.ReactNode }) {
  const session = await requireWorkspaceSession();
  return <WorkspaceShell session={session}>{children}</WorkspaceShell>;
}
