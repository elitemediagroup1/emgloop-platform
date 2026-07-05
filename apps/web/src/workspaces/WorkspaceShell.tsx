import Link from 'next/link';
import { logoutAction } from '../auth/actions';
import { hasPermission } from '../auth/guard';
import { EmgLoopWordmark } from '../app/crm/_brand/Logos';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { AuthSession } from '../auth/auth';
import type { WorkspaceConfig, NavItem } from './config';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'EM';
}

export default async function WorkspaceShell({
  workspace,
  session,
  children,
}: {
  workspace: WorkspaceConfig;
  session: AuthSession;
  children: React.ReactNode;
}) {
  const permitted = new Map<string, boolean>();
  await Promise.all(
    workspace.nav.flatMap((group) =>
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
            {workspace.nav.map((group) => (
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
            <div className="loop-sb__stat">
              <span>Brain</span>
              <span><span className="loop-dot" /> <b>Online</b></span>
            </div>
            <div className="loop-sb__stat">
              <span>System</span>
              <b>Operational</b>
            </div>
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
              <b>{workspace.label}</b>
              <span className="sep">/</span>
              <span>Overview</span>
            </div>
            <div className="loop-search">
              <SidebarIcon name="search" />
              <span>Search Loop…</span>
              <span className="kbd">⌘K</span>
            </div>
            <button className="loop-iconbtn" type="button" aria-label="Notifications">
              <SidebarIcon name="bell" />
              <span className="badge" />
            </button>
            <button className="loop-iconbtn" type="button" aria-label="Activity">
              <SidebarIcon name="activity" />
            </button>
          </header>
          <main className="loop-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
