import Link from 'next/link';
import type { NavGroup } from '../../../workspaces/config';
import { CONNECTIONS_PATH, LOOP_HOME } from '../../../auth/landing';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import type { TimeView } from '@emgloop/shared';
import { LoopPage, PageHead, Panel } from '../_loop-os/record';
import { HOME_PATHS, composeBriefing, dueTodayFromQueue, type QueueInstance } from './briefing';
import { BriefingLead, NeedsAttention, TodayPanel, WhatChanged } from './briefing-view';
import { RefreshCalendar } from './refresh-calendar';

// Loop Home for a person without the operational overview's authority, as the same daily briefing
// (approved design pass, 2026-09-24): what changed, what needs them, their day -- from their own
// sources only -- and then each area of Loop they can open.
//
// The groups arrive already resolved from their permissions and role authority
// (workspaces/nav-access.ts), so nothing here decides access, and nothing a person cannot open is
// shown. There is no executive review and no organization pulse for this seat: the briefing is
// composed from the viewer's own calendar, mailbox and "needs you" items, and says so.

export function ModuleHome({
  name,
  userId,
  groups,
  time,
  day,
  dayFailed,
  mail,
  mailFailed,
  needsYou,
  queue,
}: {
  name: string;
  /** The viewer, for the "due today" projection over their own queue rows. */
  userId: string;
  groups: readonly NavGroup[];
  /** The reader's clock and zone, from the page. */
  time: TimeView;
  day: YourDayView | null;
  dayFailed: boolean;
  mail: MailDashboard | null;
  mailFailed: boolean;
  /** The viewer's own items, from the one employee-private loader with the session principal. */
  needsYou: readonly NeedsYouItem[];
  /** The viewer's own work queue rows, read by the page for the employee seat only; empty otherwise. */
  queue: readonly QueueInstance[];
}) {
  const dayStart = time.startOfDay();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const briefing = composeBriefing({
    now: time.now,
    review: null,
    period: null,
    headlines: null,
    needsYou,
    day,
    dayFailed,
    mail,
    mailFailed,
    dashboard: null,
    workDue: dueTodayFromQueue(queue, userId, dayStart, dayEnd, (id) => `/app/employee/work/${encodeURIComponent(id)}`),
    connectionsHref: CONNECTIONS_PATH,
    headlinesHref: HOME_PATHS.headlines,
  });
  const areas = groups
    .map((group) => ({
      label: group.label || 'More',
      items: group.items.filter((item) => !item.soon && item.href !== LOOP_HOME),
    }))
    .filter((area) => area.items.length > 0);

  return (
    <LoopPage label="Loop Home">
      <PageHead trail={[{ label: 'Your Loop' }]} title={`${time.greeting()}, ${name}`} />
      <BriefingLead briefing={briefing} time={time} />
      <div className="loop-brief">
        <div className="loop-brief__main">
          {briefing.changes.length > 0 ? <WhatChanged briefing={briefing} time={time} /> : null}
          <NeedsAttention briefing={briefing} time={time} />
        </div>
        <aside className="loop-brief__side" aria-label="Your day">
          <TodayPanel today={briefing.today} time={time} refresh={<RefreshCalendar />} mailHref={HOME_PATHS.mail} />
        </aside>
      </div>
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
