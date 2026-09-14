import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { LOOP_HOME } from '../../../auth/landing';
import type { NavGroup } from '../../../workspaces/config';

// Loop Home for a person without the operational overview's authority.
//
// It is the same navigation the shell offers them, laid out as a starting point:
// each operating area they can open, and inside it each surface they can open.
// The groups arrive already resolved from their permissions and role authority
// (workspaces/nav-access.ts), so nothing here decides access, and nothing a
// person cannot open is shown. It shows no business data, so it invents none.

export function ModuleHome({ name, groups }: { name: string; groups: readonly NavGroup[] }) {
  const areas = groups
    .map((group) => ({
      label: group.label || 'More',
      items: group.items.filter((item) => !item.soon && item.href !== LOOP_HOME),
    }))
    .filter((area) => area.items.length > 0);

  return (
    <div className="loop-grid__content">
      <div className="loop-pagehead">
        <div className="loop-eyebrow">Loop Home</div>
        <h1 className="loop-title">Welcome, {name}</h1>
        <p className="loop-subtitle">Everything you have access to in Loop.</p>
      </div>
      {areas.map((area) => (
        <section className="loop-card" key={area.label} aria-label={area.label}>
          <div className="loop-card__head">
            <h2 className="loop-card__title">{area.label}</h2>
          </div>
          <div className="loop-launchers">
            {area.items.map((item) => (
              <Link href={item.href} className="loop-launch" key={item.href}>
                <span className="loop-launch__icon">
                  <SidebarIcon name={item.icon} />
                </span>
                <span className="loop-launch__title">{item.label}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
