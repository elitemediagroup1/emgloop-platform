import type { NavGroup } from '../../../workspaces/config';
import { CONNECTIONS_PATH } from '../../../auth/landing';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import type { TimeView } from '@emgloop/shared';
import { LoopPage, PageHead } from '../_loop-os/record';
import { HOME_PATHS, composeBriefing, dueTodayFromQueue, type QueueInstance } from './briefing';
import { BriefingLead, NeedsAttention, TodayPanel, WhatChanged } from './briefing-view';
import type { FrontDoorReads } from './front-door-data';
import { ToolsGrid } from './front-door-view';
import { RefreshCalendar } from './refresh-calendar';
import { projectTiles } from './tiles';

// Loop Home for a person without the operational overview's authority, as the same front door over
// their own sources only (2026-09-24): their briefing (what changed in their mail, calendar and
// chats), their day and what needs them, and the tools & spaces they can open. No KPI row, no
// Headlines, no organization activity: none of those is theirs to read, and nothing is faked.
//
// The groups arrive already resolved from their permissions and role authority
// (workspaces/nav-access.ts), so nothing here decides access, and nothing a person cannot open is
// shown. The additive reads (their own Telegram connection, the intake counts) were made by the page
// under the same gates (front-door-data.ts); this component composes and draws.

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
  front = null,
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
  /** The front door's additive reads for this seat, made by the page; null when none were made. */
  front?: FrontDoorReads | null;
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
    callgrid: null,
    workDue: dueTodayFromQueue(queue, userId, dayStart, dayEnd, (id) => `/app/employee/work/${encodeURIComponent(id)}`),
    connectionsHref: CONNECTIONS_PATH,
    headlinesHref: HOME_PATHS.headlines,
  });
  const tiles = projectTiles({
    groups,
    today: briefing.today,
    needsYouCount: needsYou.length,
    telegram: front?.telegram ?? null,
    work: { kind: 'EMPLOYEE', queue, userId },
    intake: front?.intake ?? null,
    creators: null,
    callgrid: null,
    time,
  });

  return (
    <LoopPage label="Loop Home">
      <div className="loop-front">
        <div className="loop-front__band">
          <PageHead trail={[{ label: 'Your Loop' }]} title={`${time.greeting()}, ${name}`} subtitle={time.date(time.now)} />
        </div>
        <div className="loop-front__cols">
          <div className="loop-front__main">
            <section className="loop-front__briefing" aria-label="Your briefing" id="your-briefing">
              <BriefingLead briefing={briefing} time={time} />
              {briefing.changes.length > 0 ? <WhatChanged briefing={briefing} time={time} /> : null}
            </section>
          </div>
          <aside className="loop-front__side" aria-label="Your day and what needs you">
            <TodayPanel today={briefing.today} time={time} refresh={<RefreshCalendar />} mailHref={HOME_PATHS.mail} />
            <NeedsAttention briefing={briefing} time={time} />
          </aside>
        </div>
        <ToolsGrid tiles={tiles} />
      </div>
    </LoopPage>
  );
}
