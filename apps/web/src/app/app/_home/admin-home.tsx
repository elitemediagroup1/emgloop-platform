import type { WorkPrincipal } from '@emgloop/database';
import { mailDomainIntelligence } from '@emgloop/shared';
import type { AuthSession } from '../../../auth/auth';
import { CONNECTIONS_PATH } from '../../../auth/landing';
import { composeChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import { viewerTime } from '../../../time/viewer-time';
import { requireWorkspace } from '../../../workspaces/guard';
import type { NavGroup } from '../../../workspaces/config';
import { loadHome } from '../admin/home-data';
import { LoopPage, PageHead } from '../_loop-os/record';
import { HOME_PATHS, composeBriefing, dueTodayFromWork, workPostureFromSummary } from './briefing';
import { BriefingCard, SourceUnavailable, YourDayCard } from './briefing-view';
import { loadFrontDoor, loadHeadlineStandings, navOffers, type HeadlineStanding } from './front-door-data';
import { HeadlinesPanel, KpiStrip, RecentActivityPanel, ToolsGrid } from './front-door-view';
import { briefingNarrative } from './narrative';
import { RefreshCalendar } from './refresh-calendar';
import { loadOrganizationActivity } from './org-activity-data';
import { loadExecutiveReview } from './review-data';
import { settle } from './settle';
import { TILE_PATHS, projectTiles } from './tiles';
import { SituationsPanel } from '../../../intelligence/situations-view';

// The executive Home, as the front door to the operating system (Matt, 2026-09-24; the composition
// correction, the same day). It COMPOSES existing authorities and never becomes one. Top to bottom,
// in full-width sections with no side rail: the executive KPI row (the Command Center's own figures
// and its own comparison); YOUR BRIEFING, the synthesis in prose (narrative.ts), with what Loop read
// folded beneath it; HEADLINES, the Headline authority's open records as cards; then two compact
// peers -- YOUR DAY (the viewer's own calendar, work due today, and a constrained "needs you") and
// RECENT ACTIVITY (the organization's Universal Activity feed: channel facts, CallGrid calls, the
// audit log and Brain work, each only as the service authorizes this viewer; never an employee's
// private source); and last the tools & spaces this person can open, each tile its domain's own
// interpretation. Three intelligence levels, kept distinct: the briefing is
// company-wide synthesis, Headlines are connective records, a tile is one domain's reading.
//
// THE READS. The operational home (work, attention), the organization activity feed (read once,
// shared by its card and the review's work changes) and the executive review (mail,
// calendar, CallGrid, work, Headlines) are loaded here as before; the front door's additive reads
// (front-door-data.ts) are gated by the navigation this person was offered. The viewer's own day,
// mail and "needs you" items arrive from the page, which loaded each once with the session principal.
// Every projection below (`composeBriefing`, `briefingNarrative`, the tiles, the KPIs, the domains'
// own `mailDomainIntelligence` and `composeChatsIntelligence`) is pure.
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
  const [homeResult, front, activity] = await Promise.all([
    settle(() => loadHome('assigned')),
    loadFrontDoor({ session, principal, groups, time, needsYou, executive: true }),
    loadOrganizationActivity(session),
  ]);
  const home = homeResult.ok ? homeResult.value : null;
  const callgrid = front.callgrid?.ok ? front.callgrid.value : null;
  const reviewResult = await settle(() =>
    loadExecutiveReview({ session, principal, time, timeZone: time.timeZone, mail, day, home, activity, callgrid: { offered: front.callgrid !== null, strip: callgrid } }),
  );
  const review = reviewResult.ok ? reviewResult.value : null;
  // Headlines get their own section exactly when this seat may open them; the review's aggregate row
  // is then withheld from Needs you rather than said twice.
  const showHeadlines = review?.headlinesOffered === true;
  const standings: ReadonlyMap<string, HeadlineStanding> = showHeadlines && review?.headlines ? await loadHeadlineStandings(principal.organizationId, review.headlines) : new Map();

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

  // The domains' own readings, each computed once and shared by the briefing and its tile.
  const mailReading = briefing.today.mail.state === 'READ' && mail ? mailDomainIntelligence(mail.rows.map((r) => r.insight), mail.summary, mail.now) : null;
  const chats = front.chats === null ? null : front.chats.ok ? { ok: true as const, value: composeChatsIntelligence(front.chats.value) } : { ok: false as const };
  const work = home ? { ok: true as const, value: workPostureFromSummary(home.workspace.workSummary, home.workspace.myWork, time.now, dayEnd) } : { ok: false as const };
  const offer = (href: string) => (navOffers(groups, href) ? href : null);

  const narrative = briefingNarrative({
    time,
    business: front.callgrid,
    headlines: showHeadlines ? { rows: review?.headlines ?? null, attention: review?.attention ?? null, standings } : null,
    today: briefing.today,
    mail: mailReading,
    chats,
    work,
    hrefs: {
      callgrid: offer(TILE_PATHS.marketplace),
      headlines: HOME_PATHS.headlines,
      mail: offer(TILE_PATHS.mail),
      chats: offer(TILE_PATHS.chats),
      calendar: offer(TILE_PATHS.calendar),
      work: offer(TILE_PATHS.adminWork),
    },
  });
  const tiles = projectTiles({
    groups,
    today: briefing.today,
    mail: mailReading,
    chats,
    work: { kind: 'ADMIN', posture: work },
    intake: front.intake,
    creators: front.creators,
    callgrid: front.callgrid,
    callgridBrief: front.callgridBrief,
    time,
    readings: front.readings,
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

        <BriefingCard narrative={narrative} briefing={briefing} time={time} stored={front.briefing} offers={(href) => navOffers(groups, href)} />
        {showHeadlines ? <HeadlinesPanel headlines={review?.headlines ?? null} attention={review?.attention ?? null} standings={standings} time={time} href={HOME_PATHS.headlines} /> : null}
        {front.situations ? <SituationsPanel read={front.situations} time={time} caseHref={(id) => `/app/admin/cases/${id}`} /> : null}

        {/* Two compact peers: the signed-in person's own day and what needs them, beside the
            organization's recent business events. Each card's height is its own content's. */}
        <div className="loop-front__pair">
          <YourDayCard today={briefing.today} briefing={briefing} time={time} refresh={<RefreshCalendar />} calendarHref={offer(TILE_PATHS.calendar)} />
          <RecentActivityPanel activity={activity} time={time} auditHref={auditHref} />
        </div>

        <ToolsGrid tiles={tiles} />
      </div>
    </LoopPage>
  );
}
