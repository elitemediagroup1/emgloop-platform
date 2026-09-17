'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import { areaEntries, areaOfItem, resolveActiveNav, type NavGroup, type NavItem, type OperatingArea } from './config';

// The Loop sidebar navigation and breadcrumb leaf, drawn from groups already
// resolved for one person on the server (see nav-access.ts).
//
// WHY THESE ARE CLIENT LEAVES. The shell is mounted by persistent layouts
// (/crm, /app/admin, ...). Next does not re-render a layout on client-side
// navigation, so an active item computed on the server froze on whatever page
// was hard-loaded: open People, click Conversations, and People stayed
// highlighted. The current path is client state; reading it with usePathname
// keeps the highlight and the breadcrumb on the page actually shown.
//
// Presentation only: they render exactly the groups they are given, hold no
// permission logic, and never become an authorization decision.

function useActiveItem(groups: readonly NavGroup[]): NavItem | null {
  return resolveActiveNav({ nav: [...groups] }, usePathname());
}

// One nav link, shared by the main list and the Administration foot — the
// sidebar has ONE link implementation, never per-route variants.
function NavLink({ item, active }: { item: NavItem; active: string | null }) {
  const isActive = item.href === active;
  const className = 'loop-sb__link' + (isActive ? ' is-active' : '') + (item.soon ? ' is-disabled' : '');
  const content = (
    <>
      <span className="loop-sb__ico">
        <SidebarIcon name={item.icon} />
      </span>
      <span>{item.label}</span>
      {item.soon ? <span className="loop-sb__soon">Soon</span> : null}
    </>
  );
  return item.soon ? (
    <span className={className} aria-disabled>
      {content}
    </span>
  ) : (
    <Link className={className} href={item.href} aria-current={isActive ? 'page' : undefined}>
      {content}
    </Link>
  );
}

function Group({ group, active }: { group: NavGroup; active: string | null }) {
  return (
    <div className="loop-sb__group">
      {group.label ? <div className="loop-sb__grouplabel">{group.label}</div> : null}
      {group.items.map((item) => (
        <NavLink item={item} active={active} key={item.href} />
      ))}
    </div>
  );
}

export function ShellNav({ groups, label }: { groups: readonly NavGroup[]; label: string }) {
  const active = useActiveItem(groups)?.href ?? null;
  const main = groups.filter((g) => !g.footer);
  const foot = groups.filter((g) => g.footer);
  return (
    <>
      <nav className="loop-sb__scroll" aria-label={label}>
        {main.map((group, i) => (
          <Group group={group} active={active} key={group.label || `g${i}`} />
        ))}
      </nav>
      {foot.length > 0 ? (
        <nav className="loop-sb__adminarea" aria-label="Administration">
          {foot.map((group, i) => (
            <Group group={group} active={active} key={group.label || `f${i}`} />
          ))}
        </nav>
      ) : null}
    </>
  );
}

/** The breadcrumb leaf: the item that owns the current path, never an empty crumb. */
export function ShellCrumb({ groups }: { groups: readonly NavGroup[] }) {
  return <span aria-current="page">{useActiveItem(groups)?.label ?? 'Overview'}</span>;
}

const AREA_ICON: Record<OperatingArea, string> = {
  HOME: 'grid',
  CRM: 'users',
  WORK: 'columns',
  INTELLIGENCE: 'chart',
  OPERATIONS: 'activity',
};

/**
 * The compact operating-area bar for narrow screens (handoff p. 15: mobile is action
 * first). One entry per area this person can open, leading to that area's first
 * item; the area of the page actually shown is marked current. Presentation only:
 * it draws the same server-resolved groups as the sidebar.
 */
export function AreaBar({ groups }: { groups: readonly NavGroup[] }) {
  const current = areaOfItem(groups, useActiveItem(groups));
  const entries = areaEntries(groups);
  if (entries.length === 0) return null;
  return (
    <nav className="loop-areabar" aria-label="Operating areas">
      {entries.map((entry) => {
        const isActive = entry.area === current;
        return (
          <Link
            key={entry.area}
            className={'loop-areabar__link' + (isActive ? ' is-active' : '')}
            href={entry.href}
            aria-current={isActive ? 'true' : undefined}
          >
            <span className="loop-areabar__ico" aria-hidden="true">
              <SidebarIcon name={AREA_ICON[entry.area]} />
            </span>
            <span>{entry.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
