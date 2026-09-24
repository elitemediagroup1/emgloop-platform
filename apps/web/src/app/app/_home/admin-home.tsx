import type { WorkPrincipal } from '@emgloop/database';
import type { AuthSession } from '../../../auth/auth';
import { CONNECTIONS_PATH } from '../../../auth/landing';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import { viewerTime } from '../../../time/viewer-time';
import { requireWorkspace } from '../../../workspaces/guard';
import type { NavGroup } from '../../../workspaces/config';
import { loadHome } from '../admin/home-data';
import { LoopPage, PageHead } from '../_loop-os/record';
import { HOME_PATHS, composeBriefing, dueTodayFromWork } from './briefing';
import { BriefingLead, NeedsAttention, SourceUnavailable, TodayPanel, WhatChanged } from './briefing-view';
import { loadFrontDoor, loadHeadlineCases, navOffers } from './front-door-data';
import { HEADLINES_ON_HOME, HeadlinesPanel, KpiStrip, RecentActivityPanel, ToolsGrid } from './front-door-view';
import { RefreshCalendar } from './refresh-calendar';
import { loadExecutiveReview } from './review-data';
import { settle } from './settle';
import { projectTiles } from './tiles';

// The executive Home, as the front door to the operating system (Matt, 2026-09-24). It COMPOSES
// existing authorities and never becomes one. Top to bottom: the executive KPI row (the Command
// Center's own figures and its own comparison), the briefing (what changed), Headlines (the
// Headline authority, non-dismissed, with each one's investigation state), then the viewer's own day
// and what needs them beside recent business activity, and last the tools & spaces this person can
// open. Different information products, kept apart; nothing here computes a fact of its own.
//
// THE READS. The operational home (work, attention, activity, the Brain) and the executive review
// (mail, calendar, CallGrid, work, Headlines) are loaded here as before; the front door's additive
// reads (front-door-data.ts) are gated by the navigation this person was offered. The viewer's own
// day, mail and "needs you" items arrive from the page, which loaded each once with the session
// principal. `composeBriefing` and the tile/KPI projections are pure.
//
// NEEDS YOU STAYS THE VIEWER'S OWN. The employee-private items are handed in as data, ranked for
// display beside the executive attention rows, and rendered with their source on every row. They
// are never counted into an organization metric and never read by the review.
//
// EVERY SOURCE FAILS ON ITS OWN: a review, work or CallGrid read that cannot be made leaves its own
// section saying so; the rest of Home stays current.

const AUDIT_PATH = '/crm/audit';

export async function AdminHome({
  session,
  principal,
  day,
  dayFailed,
  mail,
  mailFailed,
  needsYou,
  groups,
}: {
  session: AuthSession;
  principal: WorkPrincipal;
  /** The navigation this person is offered (resolved by the page), so Home links only where the rail would. */
  groups: readonly NavGroup[];
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
  const [homeResult, front] = await Promise.all([settle(() => loadHome('assigned')), loadFrontDoor({ session, principal, groups, time, executive: true })]);
  const home = homeResult.ok ? homeResult.value : null;
  const callgrid = front.callgrid?.ok ? front.callgrid.value : null;
  const reviewResult = await settle(() =>
    loadExecutiveReview({ session, principal, time, timeZone: time.timeZone, mail, day, home, callgrid: { offered: front.callgrid !== null, strip: callgrid } }),
  );
  const review = reviewResult.ok ? reviewResult.value : null;
  // Headlines get their own panel exactly when this seat may open them; the review's aggregate row
  // is then withheld from Needs you rather than said twice.
  const showHeadlines = review?.headlinesOffered === true;
  const cases = showHeadlines && review?.headlines ? await loadHeadlineCases(principal.organizationId, review.headlines.slice(0, HEADLINES_ON_HOME).map((h) => h.id)) : new Map();

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
    callgrid,
    workDue: home ? dueTodayFromWork(home.workspace.myWork, dayStart, dayEnd) : [],
    connectionsHref: CONNECTIONS_PATH,
    headlinesHref: HOME_PATHS.headlines,
    headlinesPanel: showHeadlines,
  });
  const tiles = projectTiles({
    groups,
    today: briefing.today,
    needsYou,
    mailInflow: mail?.summary?.inflow ? { needsReply: mail.summary.inflow.needsReply, followUps: mail.summary.inflow.followUps, waiting: mail.summary.inflow.waiting } : null,
    telegram: front.telegram,
    work: { kind: 'ADMIN', summary: home ? { ok: true, value: home.workspace.workSummary } : { ok: false } },
    intake: front.intake,
    creators: front.creators,
    callgrid: front.callgrid,
    time,
  });
  const auditHref = navOffers(groups, AUDIT_PATH) ? AUDIT_PATH : null;

  const header = home?.workspace.header;
  return (
    <LoopPage label="Loop Home">
      <div className="loop-front">
        <div className="loop-front__band">
          <PageHead
            trail={[{ label: 'Your Loop' }]}
            title={`${header?.greeting ?? time.greeting()}, ${header?.displayName ?? session.name}`}
            subtitle={[time.date(time.now), header?.organizationName].filter((s): s is string => Boolean(s)).join(' · ')}
            actions={
              <form className="loop-searchform" method="get" action="/crm/search" role="search">
                <input type="search" name="q" className="loop-input" placeholder="Search intake records and conversations" aria-label="Search the CRM" />
              </form>
            }
          />
        </div>

        <KpiStrip strip={front.callgrid} />
        {!reviewResult.ok ? <SourceUnavailable what="today’s review" /> : null}
        {!homeResult.ok ? <SourceUnavailable what="Loop work" /> : null}

        <div className="loop-front__cols">
          <div className="loop-front__main">
            <section className="loop-front__briefing" aria-label="Your briefing" id="your-briefing">
              <BriefingLead briefing={briefing} time={time} />
              <WhatChanged briefing={briefing} time={time} />
            </section>
            {showHeadlines ? <HeadlinesPanel headlines={review?.headlines ?? null} attention={review?.attention ?? null} cases={cases} time={time} href={HOME_PATHS.headlines} /> : null}
            <RecentActivityPanel rows={home?.workspace.recentActivity ?? null} time={time} auditHref={auditHref} />
          </div>
          {/* THE SIDE: the signed-in person's own calendar, their work due today, their own mailbox, and
              what needs them -- and nobody else's. */}
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
