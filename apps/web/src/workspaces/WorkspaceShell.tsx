import Link from 'next/link';
import { logoutAction } from '../auth/actions';
import { hasPermission } from '../auth/guard';
import { EmgLoopWordmark } from '../app/crm/_brand/Logos';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { AuthSession } from '../auth/auth';
import type { WorkspaceConfig, NavItem } from './config';

// Loop OS — Workspace Shell (Phase 2, PR #47).
//
// The one navigation shell every workspace shares. Same design language as the
// operating system (it reuses the existing brand wordmark, sidebar icon set,
// and the crm-* / ds-* presentation classes) — only the NAV differs, driven
// entirely by the WorkspaceConfig passed in. There is deliberately no role
// branching here: Admin, Employee, Business, Creator, and Client all render
// through this same component with a different config.
//
// Security note: hiding a nav item is a UX convenience, NEVER the security
// boundary. Each destination page enforces its own server-side guard
// (requireSession / requireWorkspacePermission) against the existing IAM
// matrix. Here we merely DIM items whose permission the session lacks, so the
// shell tells the truth without becoming the gate.

/** Render one nav item, dimmed when the session lacks its required permission. */
async function renderItem(item: NavItem, key: string) {
  const permitted = item.requires
    ? await hasPermission(item.requires.resource, item.requires.action)
    : true;

  const inner = (
    <>
      <span className="ico">
        <SidebarIcon name={item.icon} />
      </span>
      <span className="lbl">{item.label}</span>
      {item.soon ? <span className="crm-sb-pill">Shell</span> : null}
    </>
  );

  if (!permitted || item.soon) {
    return (
      <span key={key} className="crm-sb-link soon" aria-disabled="true">
        {inner}
      </span>
    );
  }
  return (
    <Link key={key} href={item.href} className="crm-sb-link">
      {inner}
    </Link>
  );
}

function initials(name?: string | null, email?: string | null): string {
  const src = (name ?? email ?? '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const combined = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
  return combined || src.slice(0, 2).toUpperCase();
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
  // Resolve permission-dimming for every item up front (server-side).
  const groups = await Promise.all(
    workspace.nav.map(async (group) => ({
      label: group.label,
      items: await Promise.all(
        group.items.map((item, i) => renderItem(item, group.label + ':' + i)),
      ),
    })),
  );

  return (
    <div className="crm">
      <div className="crm-shell">
        <aside className="crm-sidebar">
          <div className="crm-sb-brand">
            <Link href={workspace.home} aria-label="EMG Loop home">
              <EmgLoopWordmark height={24} />
            </Link>
            <span className="badge">{workspace.label}</span>
          </div>

          <nav className="crm-sb-scroll" aria-label="Primary">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="crm-sb-group-label">{group.label}</div>
                {group.items}
              </div>
            ))}
          </nav>

          <div className="crm-sb-foot">
            <div className="crm-sb-stat">
              <span className="crm-dot-live" />
              <span className="label">Brain Status</span>
              <span className="val">Online</span>
            </div>
            <div className="crm-sb-stat">
              <span className="ds-status-dot ok" />
              <span className="label">System Health</span>
              <span className="val">Operational</span>
            </div>
            <div className="crm-sb-user">
              <span className="crm-sb-avatar">{initials(session.name, session.email)}</span>
              <span className="who">
                <div className="nm">{session.name ?? session.email ?? 'Account'}</div>
                <div className="rl">{workspace.label} · {session.roleLabel ?? 'Member'}</div>
              </span>
              <form action={logoutAction}>
                <button type="submit" className="crm-signout">Exit</button>
              </form>
            </div>
          </div>
        </aside>

        <div className="crm-content">
          <header className="crm-appbar">
            <div className="crm-cmdk" role="button" aria-label="Search (Command K)">
              <SidebarIcon name="search" />
              <span>Search {workspace.label.toLowerCase()} workspace…</span>
              <span className="kbd">
                <span className="crm-kbd">⌘</span>
                <span className="crm-kbd">K</span>
              </span>
            </div>
            <div className="crm-appbar-right">
              <span className="crm-icon-btn" aria-label="Notifications"><SidebarIcon name="bell" /></span>
              <span className="crm-icon-btn" aria-label="Activity"><SidebarIcon name="activity" /></span>
            </div>
          </header>
          <main className="crm-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
