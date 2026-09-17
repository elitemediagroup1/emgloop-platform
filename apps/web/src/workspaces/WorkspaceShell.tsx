import Link from 'next/link';
import { logoutAction } from '../auth/actions';
import { EmgLoopWordmark } from '../app/crm/_brand/Logos';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { AuthSession } from '../auth/auth';
import { LOOP_NAV, myWorkHref } from './config';
import { navFor } from './nav-access';
import { AreaBar, ShellCrumb, ShellNav } from './ShellNav';
import { viewerTime } from '../time/viewer-time';
import { TimeZoneSync } from '../time/TimeZoneSync';

// Loop OS — the application shell.
//
// THE shell. Every signed-in page renders through this component: Loop Home, the
// role-guarded /app trees and the CRM under /crm. It always renders the one
// registry, LOOP_NAV; there is no prop to hand it another, so entering a module
// can never swap the sidebar.
//
// It is about the PERSON, not a role-branded workspace: their name and role in
// the sidebar foot, their name at the root of the breadcrumb, and only the items
// their permissions and role authority let them open.
//
// It renders CHROME ONLY (sidebar, header, breadcrumb, main slot). It never
// loads business data and is never the security boundary: hiding an item only
// removes a link, while each destination still enforces its own server-side
// authority on arrival.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || 'EM';
}

export default async function WorkspaceShell({
  session,
  children,
}: {
  session: AuthSession;
  children: React.ReactNode;
}) {
  // What this person may open is decided here, once, on the server. Which of
  // those items is ACTIVE is decided in the browser (ShellNav, ShellCrumb): the
  // layouts that mount this shell persist across client navigation, so a value
  // computed here would freeze on the page that was hard-loaded.
  const groups = await navFor(session);
  const workHref = myWorkHref(groups);
  // The zone this page's dates were rendered in; TimeZoneSync corrects it to the
  // device's zone on first visit or after travel. Presentation only.
  const time = viewerTime();

  return (
    <div className="loop-os">
      {/* Without this, a keyboard user tabs through every nav item on every page. */}
      <a className="loop-skip" href="#loop-main">Skip to content</a>
      <TimeZoneSync timeZone={time.timeZone} source={time.source} />
      <div className="loop-shell">
        <aside className="loop-sidebar">
          {/* Narrow screens fold the navigation behind Menu without JavaScript; the
             operating-area bar stays in reach. On wide screens both are inert. */}
          <input type="checkbox" id="loop-menu" className="loop-menu-toggle" />
          <div className="loop-sb__brand">
            <EmgLoopWordmark height={22} tone="onDark" />
            <span className="loop-sb__os">OS</span>
            <label htmlFor="loop-menu" className="loop-sb__menubtn">Menu</label>
          </div>
          <div className="loop-sb__menu">
          <ShellNav groups={groups} label={LOOP_NAV.label} />
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
          </div>
        </aside>
        <div className="loop-content">
          <header className="loop-appbar">
            {/* The breadcrumb leads with the SIGNED-IN person's name, then the
               active item: "Charlie / People". Never a role or workspace label. */}
            <nav className="loop-crumbs" aria-label="Breadcrumb">
              <Link href={LOOP_NAV.home}>
                <b>{session.name}</b>
              </Link>
              <span className="sep" aria-hidden="true">/</span>
              <ShellCrumb groups={groups} />
            </nav>
            {/* Notifications live in the person's Work OS queue. No fake unread
               badge: AuthSession carries no unread count. Someone without a Work
               OS queue is not offered a link that would send them away. */}
            {workHref ? (
              <Link className="loop-iconbtn" href={workHref} aria-label="View work notifications">
                <SidebarIcon name="bell" />
              </Link>
            ) : null}
          </header>
          <main className="loop-main" id="loop-main" tabIndex={-1}>{children}</main>
          {/* Narrow screens only (CSS): the five operating areas, always in reach. */}
          <AreaBar groups={groups} />
        </div>
      </div>
    </div>
  );
}
