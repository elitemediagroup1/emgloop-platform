import type { NavGroup } from '../../../workspaces/config';
import { CONNECTIONS_PATH } from '../../../auth/landing';
import { composeChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import { mailDomainIntelligence, type TimeView } from '@emgloop/shared';
import { LoopPage, PageHead } from '../_loop-os/record';
import { HOME_PATHS, composeBriefing, dueTodayFromQueue, workPostureFromQueue, type QueueInstance } from './briefing';
import { BriefingCard, YourDayCard } from './briefing-view';
import { navOffers, type FrontDoorReads } from './front-door-data';
import { ToolsGrid } from './front-door-view';
import { briefingNarrative } from './narrative';
import { RefreshCalendar } from './refresh-calendar';
import { TILE_PATHS, projectTiles } from './tiles';

// Loop Home for a person without the operational overview's authority: the same front door over
// their own sources only (2026-09-24; the composition correction, the same day). Top to bottom: their
// briefing (the synthesis of their mail, chats, calendar and work, in prose), their day with what
// needs them, and the tools & spaces they can open. No KPI row, no Headlines, no organization
// activity: none of those is theirs to read, and nothing is faked.
//
// The groups arrive already resolved from their permissions and role authority
// (workspaces/nav-access.ts), so nothing here decides access, and nothing a person cannot open is
// shown. The additive reads (their own chats, the intake counts) were made by the page under the same
// gates (front-door-data.ts); this component composes and draws.

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
  const mailReading = briefing.today.mail.state === 'READ' && mail ? mailDomainIntelligence(mail.rows.map((r) => r.insight), mail.summary, mail.now) : null;
  const chatsRead = front?.chats ?? null;
  const chats = chatsRead === null ? null : chatsRead.ok ? { ok: true as const, value: composeChatsIntelligence(chatsRead.value) } : { ok: false as const };
  // The work posture only where the person's own queue is offered: a seat without My Work has no work read.
  const work = navOffers(groups, TILE_PATHS.employeeWork) ? { ok: true as const, value: workPostureFromQueue(queue, userId, time.now, dayEnd) } : null;
  const offer = (href: string) => (navOffers(groups, href) ? href : null);

  const narrative = briefingNarrative({
    time,
    business: null,
    headlines: null,
    today: briefing.today,
    mail: mailReading,
    chats,
    work,
    hrefs: {
      callgrid: null,
      headlines: null,
      mail: offer(TILE_PATHS.mail),
      chats: offer(TILE_PATHS.chats),
      calendar: offer(TILE_PATHS.calendar),
      work: offer(TILE_PATHS.employeeWork),
    },
  });
  const tiles = projectTiles({
    groups,
    today: briefing.today,
    mail: mailReading,
    chats,
    work: work ? { kind: 'EMPLOYEE', posture: work } : null,
    intake: front?.intake ?? null,
    creators: null,
    callgrid: null,
    callgridBrief: null,
    time,
  });

  return (
    <LoopPage label="Loop Home">
      <div className="loop-front">
        <div className="loop-front__band">
          <PageHead trail={[{ label: 'Your Loop' }]} title={`${time.greeting()}, ${name}`} subtitle={time.date(time.now)} />
        </div>
        <BriefingCard narrative={narrative} briefing={briefing} time={time} />
        <YourDayCard today={briefing.today} briefing={briefing} time={time} refresh={<RefreshCalendar />} calendarHref={offer(TILE_PATHS.calendar)} />
        <ToolsGrid tiles={tiles} />
      </div>
    </LoopPage>
  );
}
