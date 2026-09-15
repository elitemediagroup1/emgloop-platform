import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { requireWorkspace } from '../../../workspaces/guard';

export const dynamic = 'force-dynamic';

// The creator route tree (CREATOR role authority).
//
// Guards the tree server-side and renders the one Loop shell. The guard here is
// defence in depth, not the boundary: every page in this tree also enforces
// requireWorkspace('CREATOR') itself, because a layout is never the only thing
// standing between a request and a page's data.

export default async function CREATORLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireWorkspace('CREATOR');
  return <WorkspaceShell session={session}>{children}</WorkspaceShell>;
}
