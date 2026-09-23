import type { WorkPrincipal } from '@emgloop/database';
import type { AuthSession } from '../../../auth/auth';
import { CONNECTIONS_PATH } from '../../../auth/landing';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import { viewerTime } from '../../../time/viewer-time';
import { requireWorkspace } from '../../../workspaces/guard';
import { loadDashboard } from '../admin/dashboard-data';
import { LoopPage, PageHead } from '../_loop-os/record';
import { composeBriefing, dueTodayFromWork } from './briefing';
import { BriefingLead, NeedsAttention, PulsePanel, SourceUnavailable, TodayPanel, WhatChanged } from './briefing-view';
import { RefreshCalendar } from './refresh-calendar';
import { loadExecutiveReview } from './review-data';
import { settle } from './settle';

// The executive Home of Elite Media Group, as a daily briefing (approved design pass, 2026-09-24).
//
// THE SAME READS AS BEFORE, ONE COMPOSITION. The dashboard (CallGrid and Loop work) and the
// executive review (mail, calendar, CallGrid, work, Headlines) are loaded here exactly as they
// were; the viewer's own day, mail and "needs you" items arrive from the page, which loaded each
// once with the session principal. `composeBriefing` -- a pure function -- projects all of it
// into four sections in a fixed order: what changed, what needs you, today, and movement. Nothing
// here computes a fact of its own.
//
// NEEDS YOU STAYS THE VIEWER'S OWN. The employee-private items are handed in as data, ranked for
// display beside the executive attention rows, and rendered with their source on every row. They
// are never counted into an organization metric and never read by the review.
//
// EVERY SOURCE FAILS ON ITS OWN: a review or dashboard that cannot be read leaves its own section
// saying so; the rest of Home stays current.

export const HEADLINES_PATH = '/app/admin/headlines';
export const MAIL_PATH = '/app/mail';
export const BRAIN_PATH = '/app/admin/brain';

export async function AdminHome({
  session,
  principal,
  day,
  dayFailed,
  mail,
  mailFailed,
  needsYou,
}: {
  session: AuthSession;
  principal: WorkPrincipal;
  /** The viewer's own calendar and mailbox, read once by the page for Home and Mail alike. */
  day: YourDayView | null;
  dayFailed: boolean;
  mail: MailDashboard | null;
  mailFailed: boolean;
  /**
   * The viewer's own "Needs you" items (content-triage), loaded by the page from the SAME
   * employee-private loader and session principal the module Home uses. This Home only composes
   * them for display; it neither loads nor widens them.
   */
  needsYou: readonly NeedsYouItem[];
}) {
  // The Owner/Admin/Manager home renders at /app, so it states its authority itself.
  await requireWorkspace('ADMIN');
  const time = viewerTime();
  const dashboardResult = await settle(() => loadDashboard());
  const dashboard = dashboardResult.ok ? dashboardResult.value : null;
  const reviewResult = await settle(() => loadExecutiveReview({ session, principal, time, timeZone: time.timeZone, mail, day, dashboard }));
  const review = reviewResult.ok ? reviewResult.value : null;

  const dayStart = time.startOfDay();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const briefing = composeBriefing({
    now: time.now,
    review: review?.review ?? null,
    period: review?.period ?? null,
    headlines: review?.headlines ?? null,
    needsYou,
    day,
    dayFailed,
    mail,
    mailFailed,
    dashboard,
    workDue: dashboard ? dueTodayFromWork(dashboard.home.workspace.myWork, dayStart, dayEnd) : [],
    connectionsHref: CONNECTIONS_PATH,
    headlinesHref: HEADLINES_PATH,
  });

  const header = dashboard?.home.workspace.header;
  return (
    <LoopPage label="Loop Home">
      <PageHead
        trail={[{ label: 'Your Loop' }]}
        title={`${header?.greeting ?? time.greeting()}, ${header?.displayName ?? session.name}`}
        subtitle={header?.organizationName}
        actions={
          <form className="loop-searchform" method="get" action="/crm/search" role="search">
            <input type="search" name="q" className="loop-input" placeholder="Search intake records and conversations" aria-label="Search the CRM" />
          </form>
        }
      />
      <BriefingLead briefing={briefing} time={time} />
      {!reviewResult.ok ? <SourceUnavailable what="today’s review" /> : null}

      <div className="loop-brief">
        <div className="loop-brief__main">
          <WhatChanged briefing={briefing} time={time} />
          <NeedsAttention briefing={briefing} time={time} />
        </div>
        {/* TODAY: the signed-in person's own calendar, their work due today, and their own mailbox --
            and nobody else's. */}
        <aside className="loop-brief__side" aria-label="Your day">
          <TodayPanel today={briefing.today} time={time} refresh={<RefreshCalendar />} mailHref={MAIL_PATH} />
        </aside>
        <div className="loop-brief__pulse">
          {briefing.pulse ? <PulsePanel pulse={briefing.pulse} brainHref={dashboard ? BRAIN_PATH : null} /> : null}
          {!dashboardResult.ok ? <SourceUnavailable what="CallGrid and work" /> : null}
        </div>
      </div>
    </LoopPage>
  );
}
