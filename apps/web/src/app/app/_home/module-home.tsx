import Link from 'next/link';
import type { ReactNode } from 'react';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { LOOP_HOME } from '../../../auth/landing';
import type { NavGroup } from '../../../workspaces/config';
import { LoopPage, PageHead, Panel } from '../_loop-os/record';

// Loop Home for a person without the operational overview's authority.
//
// It is the same navigation the shell offers them, laid out as a starting point:
// each operating area they can open, and inside it each surface they can open.
// The groups arrive already resolved from their permissions and role authority
// (workspaces/nav-access.ts), so nothing here decides access, and nothing a
// person cannot open is shown. It shows no business data, so it invents none.
// Drawn with the Loop design system's shared primitives.

export function ModuleHome({ name, groups, day }: { name: string; groups: readonly NavGroup[]; day?: ReactNode }) {
  const areas = groups
    .map((group) => ({
      label: group.label || 'More',
      items: group.items.filter((item) => !item.soon && item.href !== LOOP_HOME),
    }))
    .filter((area) => area.items.length > 0);

  return (
    <LoopPage label="Loop Home">
      <PageHead trail={[{ label: 'Your Loop' }]} title={`Welcome, ${name}`} subtitle="Everything you have access to in Loop." />
      {/* YOUR DAY (DL-4): this person's own calendar, above the areas they can open. */}
      {day}
      <div className="loop-home">
        {areas.map((area) => (
          <Panel title={area.label} key={area.label}>
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
          </Panel>
        ))}
      </div>
    </LoopPage>
  );
}
