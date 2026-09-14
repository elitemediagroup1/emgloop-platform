import Link from 'next/link';
import { headers } from 'next/headers';
import { logoutAction } from '../auth/actions';
import { hasPermission } from '../auth/guard';
import { EmgLoopWordmark } from '../app/crm/_brand/Logos';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { AuthSession } from '../auth/auth';
import type { ShellConfig, NavItem, WorkspaceRole } from './config';
import { navItemVisible, resolveActiveNav } from './config';
import { resolveWorkspaceRole } from './role-router';

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

// One nav link, shared by the main list and the footer (Administration) — the
// sidebar has ONE link implementation, never per-route variants.
function renderNavLink(
  item: NavItem,
  permitted: Map<string, boolean>,
  active: string | null,
  workspace: WorkspaceRole,
) {
  // An item the user is denied, or whose workspace they are not in, is HIDDEN,
  // not greyed — we never render a control the user cannot use. Server guards
  // still enforce access on arrival; this only removes the link.
  if (!navItemVisible(item, { permitted: permitted.get(item.href) ?? true, workspace })) return null;
  const disabled = Boolean(item.soon);
  const isActive = item.href === active;
  const className = 'loop-sb__link' + (isActive ? ' is-active' : '') + (disabled ? ' is-disabled' : '');
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
    <Link
      className={className}
      href={item.href}
      key={item.href}
      aria-current={isActive ? 'page' : undefined}
    >
      {content}
    </Link>
  );
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
  // ONE resolver for both the breadcrumb product AND the active sidebar item.
  const activeItem = resolveActiveNav(shell, pathname);
  const crumb = activeItem?.label ?? 'Overview';
  const active = activeItem?.href ?? null;

  const workspace = resolveWorkspaceRole(session);
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
      {/* Without this, a keyboard user tabs through every nav item on every page. */}
      <a className="loop-skip" href="#loop-main">Skip to content</a>
      <div className="loop-shell">
        <aside className="loop-sidebar">
          <div className="loop-sb__brand">
            <EmgLoopWordmark height={22} />
            <span className="loop-sb__os">OS</span>
          </div>
          <nav className="loop-sb__scroll" aria-label={`${shell.label} navigation`}>
            {shell.nav.filter((g) => !g.footer).map((group, gi) => (
              <div className="loop-sb__group" key={group.label || `g${gi}`}>
                {group.label ? <div className="loop-sb__grouplabel">{group.label}</div> : null}
                {group.items.map((item) => renderNavLink(item, permitted, active, workspace))}
              </div>
            ))}
          </nav>
          {shell.nav.some((g) => g.footer) ? (
            <nav className="loop-sb__adminarea" aria-label="Administration">
              {shell.nav.filter((g) => g.footer).map((group, gi) => (
                <div key={group.label || `f${gi}`}>
                  {group.label ? <div className="loop-sb__grouplabel">{group.label}</div> : null}
                  {group.items.map((item) => renderNavLink(item, permitted, active, workspace))}
                </div>
              ))}
            </nav>
          ) : null}
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
            {/* The breadcrumb leads with the SIGNED-IN user's display name, then
               the active product — "Charlie / Dashboard", "Matt / Administration".
               Never the shell label ("Admin"), so the header is always personal. */}
            <nav className="loop-crumbs" aria-label="Breadcrumb">
              <Link href={shell.home}>
                <b>{session.name}</b>
              </Link>
              <span className="sep" aria-hidden="true">/</span>
              <span aria-current="page">{crumb}</span>
            </nav>
            {/* Sprint 27: Search + Activity removed (no session-scoped
               backend wired to the shell yet). Notifications links to the
               real Work OS notifications; no fake unread badge is shown
               because AuthSession carries no unread count and this sprint
               adds no new notification query. */}
            <Link className="loop-iconbtn" href="/app/admin/work" aria-label="View work notifications">
              <SidebarIcon name="bell" />
            </Link>
          </header>
          <main className="loop-main" id="loop-main" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </div>
  );
}
