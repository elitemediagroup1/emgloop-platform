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
import { isStandalonePath } from '../../workspaces/config';

// CRM layout.
//
// The CRM owns no shell. This layout resolves the session, decides whether the
// route is a public auth screen, and otherwise renders the one Loop shell: the
// same sidebar, breadcrumb and navigation as every other signed-in page, with
// CRM as one area of it. Entering the CRM never swaps the sidebar.
//
// It is not a guard: every /crm page enforces its own session and permission.
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
    <WorkspaceShell session={session}>
      <div className="crm crm--embedded">{children}</div>
    </WorkspaceShell>
  );
}
