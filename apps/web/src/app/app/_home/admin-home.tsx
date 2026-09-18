import Link from 'next/link';
import { loadDashboard, type DashboardData } from '../admin/dashboard-data';
import { requireWorkspace } from '../../../workspaces/guard';
import {
  REVIEW_SOURCE_LABELS,
  metricValue,
  trend,
  trendLabel,
  type ExecutiveReview,
  type ReviewAttention,
  type ReviewMetric,
  type ReviewMetricKey,
  type ReviewPeriod,
  type ReviewTone,
  type ReviewUpdate,
  type TimeView,
  type TrendResult,
} from '@emgloop/shared';
import type { WorkPrincipal } from '@emgloop/database';
import type { AuthSession } from '../../../auth/auth';
import { viewerTime } from '../../../time/viewer-time';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { YourDayView } from '../../../daily-loop/your-day';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { LoopPage, PageHead, Panel, StateBlock } from '../_loop-os/record';
import { DayCalendar, DayUnavailable } from './day-calendar';
import { RefreshCalendar } from './refresh-calendar';
import { loadExecutiveReview } from './review-data';
import { settle } from './settle';
import { YourMail } from './your-mail';

// The executive Home of Elite Media Group: Today's Review on the left, the day on the right.
//
// LEFT, WHAT LOOP CAN SAY ABOUT THE BUSINESS SINCE YESTERDAY. A headline of the few facts that
// matter most, four counts, what changed, and what needs someone -- each from a source Loop already
// reads (the viewer's own mail and calendar, CallGrid, Loop work, Headlines), merged by one pure
// composer (@emgloop/shared executive-review). Below it, the operating panels that already worked:
// the CallGrid scorecard, My Work, Quick Actions.
//
// RIGHT, THE DAY. The viewer's own calendar as a timeline of today (./day-calendar), and a concise
// Your Mail that points to Mail.
//
// CONSTITUTIONAL: Loop never fabricates business reality. The headline is sentences assembled from
// stored rows, not a model's summary; a card with no source says "not tracked yet" rather than 0; a
// source Loop could not read is named as such. Money is never estimated: CallGrid figures use
// CallGrid's Eastern reporting days; greetings, dates and relative times are the reader's (Loop
// Time Authority). EVERY SOURCE LOADS ON ITS OWN, so one unreadable source never takes Home down.
//
// Drawn with the Loop design system's shared primitives and the one Loop stylesheet (.loop-exec).

type Currency = { readonly line: string; readonly href?: string; readonly action?: string } | null;

// Scorecard value display: real value, or an honest Unknown / Unavailable.
function showMoney(available: boolean, cents: number | null): string {
  if (!available) return 'Unavailable';
  if (cents === null) return 'Unknown';
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function showNum(available: boolean, n: number | null): string {
  if (!available) return 'Unavailable';
  if (n === null) return 'Unknown';
  return n.toLocaleString('en-US');
}

// Trend beside the Today value. Semantic color for revenue/profit/billable;
// Total Calls is contextual → neutral regardless of direction.
function TrendBadge({ r, neutral }: { r: TrendResult; neutral?: boolean }) {
  let tone: 'up' | 'down' | 'neutral' = 'neutral';
  if (!neutral) {
    if (r.kind === 'up') tone = 'up';
    else if (r.kind === 'down') tone = 'down';
  }
  return <span className={'score__delta score__delta--' + tone}>{trendLabel(r)}</span>;
}

function ScoreRow({ label, yText, tText, r, neutral }: { label: string; yText: string; tText: string; r: TrendResult; neutral?: boolean }) {
  return (
    <div className="score__row">
      <span className="score__label">{label}</span>
      <span className="score__val">{yText}</span>
      <span className="score__today">
        <span className="score__val">{tText}</span>
        <TrendBadge r={r} neutral={neutral} />
      </span>
    </div>
  );
}

// --- Today's Review ----------------------------------------------------------------------------------

const TONE_CLASS: Record<ReviewTone, string> = { critical: 'crit', attention: 'warn', good: 'good', neutral: 'neutral' };

function sourcesLine(review: ExecutiveReview): { read: string | null; missing: { label: string; note: string }[] } {
  const read = review.sources.filter((s) => s.state === 'OK').map((s) => REVIEW_SOURCE_LABELS[s.source]);
  const missing = review.sources
    .filter((s) => s.state !== 'OK')
    .map((s) => ({ label: REVIEW_SOURCE_LABELS[s.source], note: s.note ?? (s.state === 'UNAVAILABLE' ? 'Loop could not read this just now.' : 'Not connected.') }));
  const joined = read.length <= 1 ? read[0] ?? null : `${read.slice(0, -1).join(', ')} and ${read[read.length - 1]}`;
  return { read: joined, missing };
}

export function ReviewCard({ review, period, time }: { review: ExecutiveReview | null; period: ReviewPeriod | null; time: TimeView }) {
  const sources = review ? sourcesLine(review) : null;
  return (
    <section className="loop-exec__review" aria-label="Today's review">
      <div className="loop-exec__review-head">
        <h2 className="loop-exec__review-title">
          <SidebarIcon name="brain" size={18} /> Today&apos;s review
        </h2>
        {period ? (
          <p className="loop-exec__period">
            Since <time dateTime={time.iso(period.from)}>{time.format(period.from, 'weekdayMonthDay')}</time> · as of{' '}
            <time dateTime={time.iso(period.to)}>{time.time(period.to)}</time>
          </p>
        ) : null}
      </div>
      {!review ? (
        <p className="loop-exec__headline loop-exec__headline--quiet">Loop could not put today&apos;s review together just now.</p>
      ) : review.headline ? (
        <p className="loop-exec__headline">{review.headline}</p>
      ) : (
        <p className="loop-exec__headline loop-exec__headline--quiet">Nothing new needs saying from what Loop can read.</p>
      )}
      {sources ? (
        <p className="loop-exec__sources">
          {sources.read ? <>From {sources.read}.</> : 'Loop could not read any source for this review.'}
          {sources.missing.map((m) => (
            <span key={m.label} className="loop-exec__missing">
              {' '}
              Not included: {m.label} — {m.note}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

const METRICS: readonly { key: ReviewMetricKey; label: string; icon: string; tone: string }[] = [
  { key: 'relevantEmails', label: 'Relevant emails', icon: 'mail', tone: 'accent' },
  { key: 'newOpportunities', label: 'New opportunities', icon: 'star', tone: 'good' },
  { key: 'needAttention', label: 'Need attention', icon: 'bell', tone: 'crit' },
  { key: 'outreachSent', label: 'Outreach sent', icon: 'send', tone: 'warn' },
];

/** The comparison, only where the source can state the same count for the period before. */
function comparison(metric: Extract<ReviewMetric, { state: 'VALUE' }>): string | null {
  if (metric.prior === null) return null;
  const diff = metric.value - metric.prior;
  if (diff === 0) return 'Same as the period before';
  return `${diff > 0 ? 'Up' : 'Down'} ${Math.abs(diff).toLocaleString('en-US')} on the period before`;
}

function MetricCard({ label, icon, tone, metric }: { label: string; icon: string; tone: string; metric: ReviewMetric }) {
  const body =
    metric.state === 'VALUE' ? (
      <>
        <span className="loop-mx__card-value">{metric.value.toLocaleString('en-US')}</span>
        <span className="loop-mx__card-label">{label}</span>
        <span className="loop-mx__card-delta">{comparison(metric) ?? metric.scope}</span>
      </>
    ) : (
      <>
        <span className="loop-mx__card-value loop-exec__card-none">—</span>
        <span className="loop-mx__card-label">{label}</span>
        <span className="loop-mx__card-delta">{metric.state === 'NOT_TRACKED' ? `Not tracked yet. ${metric.reason}` : metric.reason}</span>
      </>
    );
  const icons = (
    <span className="loop-mx__card-icon" aria-hidden="true">
      <SidebarIcon name={icon} size={22} />
    </span>
  );
  if (metric.state === 'VALUE' && metric.href) {
    return (
      <Link href={metric.href} className={`loop-mx__card loop-mx__card--${tone}`} title={`Counted from ${metric.scope}`}>
        {icons}
        <span className="loop-mx__card-body">{body}</span>
        <span className="loop-mx__chevron" aria-hidden="true">
          <SidebarIcon name="chevron" size={16} />
        </span>
      </Link>
    );
  }
  return (
    <div className={`loop-mx__card ${metric.state === 'VALUE' ? `loop-mx__card--${tone}` : 'loop-exec__card--none'}`}>
      {icons}
      <span className="loop-mx__card-body">{body}</span>
      <span />
    </div>
  );
}

export function Metrics({ review }: { review: ExecutiveReview | null }) {
  return (
    <div className="loop-mx__cards loop-exec__cards">
      {METRICS.map((m) => (
        <MetricCard
          key={m.key}
          label={m.label}
          icon={m.icon}
          tone={m.tone}
          metric={review ? review.metrics[m.key] : { state: 'UNAVAILABLE', reason: 'Loop could not read this just now.' }}
        />
      ))}
    </div>
  );
}

export function KeyUpdates({ updates, time }: { updates: readonly ReviewUpdate[]; time: TimeView }) {
  return (
    <section className="loop-exec__feed" aria-label="Key updates">
      <div className="loop-exec__feed-head">
        <h2 className="loop-exec__feed-title">Key updates</h2>
      </div>
      {updates.length === 0 ? (
        <p className="loop-mx__empty">Nothing has changed since yesterday in what Loop can read.</p>
      ) : (
        <ul className="loop-exec__list">
          {updates.map((u) => {
            const inner = (
              <>
                <span className={`loop-exec__dot loop-exec__dot--${TONE_CLASS[u.tone]}`} aria-hidden="true" />
                <span className="loop-exec__text">
                  <span className="loop-exec__who">{u.who}</span>
                  <span className="loop-exec__what">{u.what}</span>
                </span>
                <span className={`loop-pill loop-pill--${u.tone} loop-mx__pill`}>{u.status}</span>
                <time className="loop-exec__when" dateTime={time.iso(u.at)}>
                  {time.relative(u.at)}
                </time>
              </>
            );
            return (
              <li key={u.key} className="loop-exec__item">
                {u.href ? (
                  <Link href={u.href} className="loop-exec__row">
                    {inner}
                  </Link>
                ) : (
                  <div className="loop-exec__row">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function NeedsAttention({
  attention,
  total,
  elsewhere = [],
  time,
  readable,
}: {
  attention: readonly ReviewAttention[];
  /** How many there are in all; null when the review could not be read, never a zero. */
  total: number | null;
  /** The ones not shown, per source, and where they are. */
  elsewhere?: ExecutiveReview['attentionElsewhere'];
  time: TimeView;
  readable: boolean;
}) {
  return (
    <section className="loop-exec__feed" aria-label="Needs attention" id="needs-attention">
      <div className="loop-exec__feed-head">
        <h2 className="loop-exec__feed-title">Needs attention</h2>
        {total !== null && total > attention.length ? <span className="loop-mx__count">Showing {attention.length} of {total}</span> : null}
      </div>
      {!readable ? (
        <p className="loop-mx__empty">Loop could not read the sources that raise attention items just now.</p>
      ) : attention.length === 0 ? (
        <p className="loop-mx__empty">Nothing needs you right now in what Loop can read.</p>
      ) : (
        <ul className="loop-exec__list">
          {attention.map((a) => {
            const inner = (
              <>
                <span className={`loop-exec__dot loop-exec__dot--${TONE_CLASS[a.tone]}`} aria-hidden="true" />
                <span className="loop-exec__text">
                  <span className="loop-exec__who">{a.who}</span>
                  <span className="loop-exec__what">{a.happened}</span>
                </span>
                {a.since ? (
                  <time className="loop-exec__when" dateTime={time.iso(a.since)}>
                    {time.relative(a.since)}
                  </time>
                ) : (
                  <span />
                )}
                <span className="loop-exec__next">
                  {a.next}
                  <SidebarIcon name="chevron" size={14} />
                </span>
              </>
            );
            return (
              <li key={a.key} className="loop-exec__item">
                {a.href ? (
                  <Link href={a.href} className="loop-exec__row loop-exec__row--attention">
                    {inner}
                  </Link>
                ) : (
                  <div className="loop-exec__row loop-exec__row--attention">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {elsewhere.some((e) => e.href) ? (
        <p className="loop-exec__more">
          {elsewhere
            .filter((e) => e.href)
            .map((e) => (
              <Link key={e.source} href={e.href!} className="loop-link">
                {e.count.toLocaleString('en-US')} more in {REVIEW_SOURCE_LABELS[e.source]} →
              </Link>
            ))}
        </p>
      ) : null}
    </section>
  );
}

// --- Operating panels that already worked ----------------------------------------------------------------

function CallGridPanel({ data }: { data: DashboardData }) {
  const { yesterday: yd, today: td, total } = data.callgrid;
  if (total === 0) {
    return (
      <Panel title="CallGrid Intelligence">
        <p className="loop-home__line">CallGrid has not sent any calls yet.</p>
        <Link href="/app/admin/marketplace" className="loop-link">Open CallGrid Intelligence →</Link>
      </Panel>
    );
  }
  // Per-metric trend (today vs yesterday), on exact cents / real counts.
  const revTrend = trend(metricValue(yd.revenueCents, yd.available), metricValue(td.revenueCents, td.available));
  const profitTrend = trend(metricValue(yd.profitCents, yd.available), metricValue(td.profitCents, td.available));
  const billableTrend = trend(metricValue(yd.billableCalls, yd.available), metricValue(td.billableCalls, td.available));
  const totalTrend = trend(metricValue(yd.totalCalls, yd.available), metricValue(td.totalCalls, td.available));
  return (
    <Panel title="CallGrid Intelligence">
      <div className="score">
        <div className="score__row score__head">
          <span className="score__label" />
          <span className="score__col">Yesterday<span className="score__sub">Completed</span></span>
          <span className="score__col">Today<span className="score__sub">Live</span></span>
        </div>
        <ScoreRow label="Revenue" yText={showMoney(yd.available, yd.revenueCents)} tText={showMoney(td.available, td.revenueCents)} r={revTrend} />
        <ScoreRow label="Net profit" yText={showMoney(yd.available, yd.profitCents)} tText={showMoney(td.available, td.profitCents)} r={profitTrend} />
        <ScoreRow label="Billable calls" yText={showNum(yd.available, yd.billableCalls)} tText={showNum(td.available, td.billableCalls)} r={billableTrend} />
        <ScoreRow label="Total calls" yText={showNum(yd.available, yd.totalCalls)} tText={showNum(td.available, td.totalCalls)} r={totalTrend} neutral />
      </div>
      <Link href="/app/admin/marketplace" className="loop-link">Open CallGrid Intelligence →</Link>
    </Panel>
  );
}

function WorkPanels({ data }: { data: DashboardData }) {
  const w = data.home.workspace;
  const assigned = w.workSummary.assignedToMe;
  return (
    <>
      <Panel title="My Work">
        {assigned === 0 ? (
          <p className="loop-home__line">You have no work assigned. When work is assigned it will appear here.</p>
        ) : (
          <>
            <p className="loop-home__num">
              <span className="loop-home__num-value">{assigned.toLocaleString('en-US')}</span>
              <span className="loop-home__num-label">Assigned</span>
            </p>
            <p className="loop-home__line">
              {w.nextAction ? `Next: ${w.nextAction.title}.` : `${assigned === 1 ? 'One item is' : `${assigned} items are`} waiting for you.`}
            </p>
          </>
        )}
        <div className="loop-home__actions">
          <Link href="/app/admin/work" className="loop-link">View my work →</Link>
          {w.canCreateWork ? <Link href="/app/admin/work/new" className="loop-link">Create work →</Link> : null}
        </div>
      </Panel>

      {/* Quick Actions — only actions that exist */}
      <Panel title="Quick Actions">
        <div className="loop-btnrow">
          {w.canCreateWork ? <Link href="/app/admin/work/new" className="loop-btn">Create work →</Link> : null}
          {w.canInvite ? <Link href="/app/admin/administration/team" className="loop-btn">Invite team member →</Link> : null}
          <Link href="/app/mail" className="loop-btn">Open Mail →</Link>
        </div>
      </Panel>
    </>
  );
}

// --- The page --------------------------------------------------------------------------------------------

export async function AdminHome({
  session,
  principal,
  day,
  dayFailed,
  mail,
  mailCurrency,
}: {
  session: AuthSession;
  principal: WorkPrincipal;
  /** The viewer's own calendar and mailbox, read once by the page for Home and Mail alike. */
  day: YourDayView | null;
  dayFailed: boolean;
  mail: MailDashboard | null;
  mailCurrency: Currency;
}) {
  // The Owner/Admin/Manager home. Its authority used to come only from the
  // /app/admin layout; it now renders at /app, so it states that authority
  // itself. (Its loader also re-checks it.)
  await requireWorkspace('ADMIN');
  const time = viewerTime();
  const dashboardResult = await settle(() => loadDashboard());
  const data = dashboardResult.ok ? dashboardResult.value : null;
  const reviewResult = await settle(() =>
    loadExecutiveReview({ session, principal, time, timeZone: time.timeZone, mail, day, dashboard: data }),
  );
  const review = reviewResult.ok ? reviewResult.value.review : null;
  const period = reviewResult.ok ? reviewResult.value.period : null;

  const header = data?.home.workspace.header;
  // A conversation already on the page -- under Needs attention or Key updates -- is not listed
  // again in Your Mail.
  const shownMail = new Set(
    [...(review?.attention ?? []), ...(review?.updates ?? [])]
      .filter((item) => item.source === 'MAIL' && item.key.startsWith('mail:'))
      .map((item) => item.key.slice('mail:'.length)),
  );
  const mailConnected = mail !== null && mail.mail.freshness !== 'NOT_CONNECTED' && mail.mail.freshness !== 'NOT_CONFIGURED';

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

      <div className="loop-exec">
        <div className="loop-exec__top">
          <ReviewCard review={review} period={period} time={time} />
          <Metrics review={review} />
        </div>

        {/* THE DAY: the signed-in person's own calendar and mailbox, and nobody else's. */}
        <aside className="loop-exec__side" aria-label="Your day">
          {dayFailed ? <DayUnavailable /> : <DayCalendar view={day} refresh={<RefreshCalendar />} />}
          <YourMail dashboard={mailConnected ? mail : null} time={time} currency={mailCurrency} exclude={shownMail} />
        </aside>

        <div className="loop-exec__bottom">
          <div className="loop-exec__feeds">
            <KeyUpdates updates={review?.updates ?? []} time={time} />
            <NeedsAttention
              attention={review?.attention ?? []}
              total={review ? review.attentionTotal : null}
              elsewhere={review?.attentionElsewhere ?? []}
              time={time}
              readable={review !== null && review.metrics.needAttention.state === 'VALUE'}
            />
          </div>

          {data ? (
            <div className="loop-exec__ops">
              <CallGridPanel data={data} />
              <WorkPanels data={data} />
            </div>
          ) : (
            <StateBlock kind="attention" title="Loop could not read CallGrid and work just now" body="The rest of Home is current. Try again in a moment." compact />
          )}
        </div>
      </div>
    </LoopPage>
  );
}
