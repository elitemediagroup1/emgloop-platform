import Link from 'next/link';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import type { NavGroup, NavItem } from './config';

// The Loop sidebar navigation, drawn from groups already resolved for one person
// (see nav-access.ts). Presentation only: it renders exactly what it is given,
// so it holds no permission logic and never becomes an authorization decision.

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

export function ShellNav({
  groups,
  active,
  label,
}: {
  groups: readonly NavGroup[];
  active: string | null;
  label: string;
}) {
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
