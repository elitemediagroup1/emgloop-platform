import { redirect } from 'next/navigation';
import { getSession } from '../../auth/auth';
import { LOOP_HOME, loginPathFor } from '../../auth/landing';
import WorkspaceShell from '../../workspaces/WorkspaceShell';
import { workspaceFor } from '../../workspaces/config';
import { resolveWorkspaceRole } from '../../workspaces/role-router';
import { AdminHome } from './_home/admin-home';
import { WorkspacePlaceholderHome } from './_home/workspace-home';

// Loop Home — the first destination after sign-in, for every role.
//
// It renders here rather than redirecting to a role-specific URL. Until the
// single Loop shell lands, each role still sees its existing workspace shell
// and home content; the role decides WHICH content, never a different address.
// The Owner/Admin/Manager home enforces its own workspace authority.

export const dynamic = 'force-dynamic';

export default async function LoopHome() {
  const session = await getSession();
  if (!session) redirect(loginPathFor(LOOP_HOME));

  const role = resolveWorkspaceRole(session);
  return (
    <WorkspaceShell shell={workspaceFor(role)} session={session}>
      {role === 'ADMIN' ? <AdminHome /> : <WorkspacePlaceholderHome role={role} />}
    </WorkspaceShell>
  );
}
