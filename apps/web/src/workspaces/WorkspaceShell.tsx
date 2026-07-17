import Link from 'next/link';
import { headers } from 'next/headers';
import { logoutAction } from '../auth/actions';
import { hasPermission } from '../auth/guard';
import { EmgLoopWordmark } from '../app/crm/_brand/Logos';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { AuthSession } from '../auth/auth';
import type { ShellConfig, NavItem } from './config';
import { resolveNavLabel } from './config';

// Loop OS — WorkspaceShell.
//
// Sprint 29B: THE application shell. Every signed-in surface renders through
// this component — the five role workspaces under /app AND the CRM under /crm.
// It takes a ShellConfig (label + nav) and a session; it has no role branching
// and no knowledge of which surface it is drawing. Adding a surface is a config
// entry, never a new shell.
//
// It renders CHROME ONLY (sidebar, header, breadcrumb, main slot). It never
// loads data, never decides authorization, and is never the security boundary:
// `requires` here only greys out a nav link, while each destination still
// enforces its own server-side gate on arrival.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'EM';
}

export default async function WorkspaceShell({
  shell,
  session,
  children,
}: {
  shell: ShellConfig;
  session: AuthSession;
  children: React.ReactNode;
}) {
  // Breadcrumb leaf, resolved from the path the middleware forwards. Falls back
  // to the shell root's own label so an unmatched path never renders an empty
  // crumb.
  const pathname = headers().get('x-pathname');
  const crumb = resolveNavLabel(shell, pathname) ?? 'Overview';

  const permitted = new Map<string, boolean>();
  await Promise.all(
    shell.nav.flatMap((group) =>
      group.items.map(async (item: NavItem) => {
        if (!item.requires) {
          permitted.set(item.href, true);
          return;
        }
        permitted.set(
          item.href,
          await hasPermission(item.requires.resource, item.requires.action),
        );
      }),
    ),
  );

  return (
    <div className="loop-os">
      <div className="loop-shell">
        <aside className="loop-sidebar">
          <div className="loop-sb__brand">
            <EmgLoopWordmark height={22} />
            <span className="loop-sb__os">OS</span>
          </div>
          <div className="loop-sb__scroll">
            {shell.nav.map((group) => (
              <div className="loop-sb__group" key={group.label}>
                <div className="loop-sb__grouplabel">{group.label}</div>
                {group.items.map((item) => {
                  const allowed = permitted.get(item.href) ?? true;
                  const disabled = !allowed || item.soon;
                  const className = 'loop-sb__link' + (disabled ? ' is-disabled' : '');
                  const content = (
                    <>
                      <span className="loop-sb__ico">
                        <SidebarIcon name={item.icon} />
                      </span>
                      <span>{item.label}</span>
                      {item.soon ? <span className="loop-sb__soon">Soon</span> : null}
                    </>
                  );
                  return disabled ? (
                    <span className={className} key={item.href} aria-disabled>
                      {content}
                    </span>
                  ) : (
                    <Link className={className} href={item.href} key={item.href}>
                      {content}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="loop-sb__foot">
            <div className="loop-sb__user">
              <span className="loop-sb__avatar">{initials(session.name)}</span>
              <span>
                <span className="loop-sb__uname">{session.name}</span>
                <br />
                <span className="loop-sb__urole">{session.roleLabel}</span>
              </span>
              <form action={logoutAction}>
                <button className="loop-sb__signout" type="submit">Sign out</button>
              </form>
            </div>
          </div>
        </aside>
        <div className="loop-content">
          <header className="loop-appbar">
            <div className="loop-crumbs">
              <Link href={shell.home}>
                <b>{shell.label}</b>
              </Link>
              <span className="sep">/</span>
              <span>{crumb}</span>
            </div>
            {/* Sprint 27: Search + Activity removed (no session-scoped
               backend wired to the shell yet). Notifications links to the
               real Work OS notifications; no fake unread badge is shown
               because AuthSession carries no unread count and this sprint
               adds no new notification query. */}
            <Link className="loop-iconbtn" href="/app/admin/work" aria-label="View work notifications">
              <SidebarIcon name="bell" />
            </Link>
          </header>
          <main className="loop-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
