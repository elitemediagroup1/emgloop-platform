import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { requireWorkspace } from '../../../workspaces/guard';

export const dynamic = 'force-dynamic';

// The employee route tree (EMPLOYEE role authority).
//
// Guards the tree server-side and renders the one Loop shell. The guard here is
// defence in depth, not the boundary: every page in this tree also enforces
// requireWorkspace('EMPLOYEE') itself, because a layout is never the only thing
// standing between a request and a page's data.

export default async function EMPLOYEELayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireWorkspace('EMPLOYEE');
  return <WorkspaceShell session={session}>{children}</WorkspaceShell>;
}
