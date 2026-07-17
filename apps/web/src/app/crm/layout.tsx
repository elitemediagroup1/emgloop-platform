import { headers } from 'next/headers';
import './crm.css';
import './sprint7.css';
import './sprint8.css';
import './sprint9.css';
import './sprint10.css';
import './design-system.css';
import './sprint16.css';
import '../loop-os.css';
import { getSession } from '../../auth/auth';
import WorkspaceShell from '../../workspaces/WorkspaceShell';
import { CRM_SHELL, isStandalonePath } from '../../workspaces/config';

// CRM layout — Sprint 29B (Unified Workspace Foundation).
//
// This layout no longer owns a shell. It is an ADAPTER: it resolves the
// session, decides whether the route is a public auth screen, and otherwise
// hands off to the one WorkspaceShell with the CRM's ShellConfig. The sidebar,
// header, breadcrumb and nav it used to hand-render now come from the shared
// shell, so /crm and /app are one application framework.
//
// What deliberately did NOT change: every route still renders in the same
// content slot, the session read is unchanged, and no page, action, query or
// permission was touched. Business logic was not moved.
//
// The .crm wrapper stays around the CONTENT (not the shell chrome) because the
// --crm-* design tokens are scoped to .crm and every CRM page depends on them.
// It must not be hoisted onto the shell root: `.crm a { color: inherit }` is
// more specific than `.loop-sb__link`, so hoisting it would silently break the
// sidebar link colours.

export const metadata = {
  title: 'EMG Loop — Operating System',
};

export default async function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const pathname = headers().get('x-pathname');

  // Public auth screens: standalone, no app shell (keeps the .crm theme wrapper
  // so scoped auth styles still apply). Auth behavior is unchanged.
  if (isStandalonePath(pathname)) {
    return <div className="crm crm--standalone">{children}</div>;
  }

  // No session on a protected route: render bare. Every /crm page resolves its
  // own context via requireCrmContext() and redirects to login, so this state
  // never paints — but the shell requires a session, so we must not build one
  // here. Behaviour is unchanged: previously the shell rendered with the user
  // block hidden, and the page redirected out from under it either way.
  if (!session) {
    return <div className="crm crm--standalone">{children}</div>;
  }

  return (
    <WorkspaceShell shell={CRM_SHELL} session={session}>
      <div className="crm crm--embedded">{children}</div>
    </WorkspaceShell>
  );
}
