import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { requireWorkspace } from '../../../workspaces/guard';
import { workspaceFor } from '../../../workspaces/config';

export const dynamic = 'force-dynamic';

// Loop OS — CREATOR workspace layout (Phase 2, PR #47).
//
// Guards the workspace (server-side, fail-closed via requireWorkspace) and wraps
// every page in the shared WorkspaceShell with THIS workspace's config. Same
// design language as the operating system; nav + permissions come from config.

export default async function CREATORLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireWorkspace('CREATOR');
  return (
    <WorkspaceShell shell={workspaceFor('CREATOR')} session={session}>
      {children}
    </WorkspaceShell>
  );
}
