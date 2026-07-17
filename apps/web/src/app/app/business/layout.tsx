import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { requireWorkspace } from '../../../workspaces/guard';
import { workspaceFor } from '../../../workspaces/config';

export const dynamic = 'force-dynamic';

// Loop OS — BUSINESS_OWNER workspace layout (Phase 2, PR #47).
//
// Guards the workspace (server-side, fail-closed via requireWorkspace) and wraps
// every page in the shared WorkspaceShell with THIS workspace's config. Same
// design language as the operating system; nav + permissions come from config.

export default async function BUSINESSOWNERLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireWorkspace('BUSINESS_OWNER');
  return (
    <WorkspaceShell shell={workspaceFor('BUSINESS_OWNER')} session={session}>
      {children}
    </WorkspaceShell>
  );
}
