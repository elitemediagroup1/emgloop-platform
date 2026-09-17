import Link from 'next/link';
import { loadDashboard, type DayScore } from '../admin/dashboard-data';
import { requireWorkspace } from '../../../workspaces/guard';
import { trend, trendLabel, metricValue, type TrendResult } from '@emgloop/shared';
import { viewerTime } from '../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StatePill } from '../_loop-os/record';
import type { SubjectTone } from '../../../crm/subject-display';

// The Operational Home of Elite Media Group.
//
// Drawn with the Loop design system's shared primitives (page head, panels, state
// pills; docs/product/loop-design-system.md), like every redesigned surface. The
// handoff's Home composition (Needs You, What Changed, Loop Noticed, My Work,
// Operating Pulse) is its own later slice; this keeps today's sections and data.
//
// One screen: a header (greeting + CRM search) and nine panels.
// Within 15 seconds an employee sees how the business did yesterday and today,
// whether anything needs them, whether they have work, and whether it can all be
// trusted.
//
// CONSTITUTIONAL: Loop never fabricates business reality. Every value is real
// org-scoped data or an honest Unknown / Unavailable. Money is never estimated.
// CallGrid figures use CallGrid's Eastern reporting days (@emgloop/shared);
// greetings, dates and relative times are the reader's (Loop Time Authority). The CRM
// shows nothing off the shared Customer table. No developer vocabulary.


type Tone = 'good' | 'warn' | 'crit' | 'info' | 'idle';

// Relative to the reader's calendar (Loop Time Authority).
function relTime(iso: string): string {
  return viewerTime().relative(iso);
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

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

const PILL_TONE: Record<Tone, SubjectTone> = {
  good: 'good',
  warn: 'attention',
  crit: 'critical',
  info: 'neutral',
  idle: 'neutral',
};

function StatusWord({ tone, label }: { tone: Tone; label: string }) {
  return (
    <p className="loop-home__status">
      <StatePill state={{ label, tone: PILL_TONE[tone] }} />
    </p>
  );
}

function StatusNum({ value, label }: { value: number; label?: string }) {
  return (
    <p className="loop-home__num">
      <span className="loop-home__num-value">{value.toLocaleString('en-US')}</span>
      {label ? <span className="loop-home__num-label">{label}</span> : null}
    </p>
  );
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

function ScoreRow({ label, yText, tText, r, neutral }: {
  label: string; yText: string; tText: string; r: TrendResult; neutral?: boolean;
}) {
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

interface Priority { tone: Tone; text: string; href: string }

export async function AdminHome() {
  // The Owner/Admin/Manager home. Its authority used to come only from the
  // /app/admin layout; it now renders at /app, so it states that authority
  // itself. (Its loader also re-checks it.)
  await requireWorkspace('ADMIN');
  const { home, callgrid } = await loadDashboard();
  const { workspace: w, brain } = home;
  const { header } = w;
  const { yesterday: yd, today: td } = callgrid;

  const callgridConnected = callgrid.total > 0;

  // Per-metric trend (today vs yesterday), on exact cents / real counts.
  const revTrend = trend(metricValue(yd.revenueCents, yd.available), metricValue(td.revenueCents, td.available));
  const profitTrend = trend(metricValue(yd.profitCents, yd.available), metricValue(td.profitCents, td.available));
  const billableTrend = trend(metricValue(yd.billableCalls, yd.available), metricValue(td.billableCalls, td.available));
  const totalTrend = trend(metricValue(yd.totalCalls, yd.available), metricValue(td.totalCalls, td.available));

  // Business Status — connectivity/visibility, never invented health.
  const systems = [
    { name: 'CallGrid', connected: callgridConnected },
    { name: 'CRM', connected: false },
    { name: 'Accounting', connected: false },
    { name: 'Creator Hub', connected: false },
  ];
  const connected = systems.filter((s) => s.connected).map((s) => s.name);
  const notConnected = systems.filter((s) => !s.connected).map((s) => s.name);
  const visibilityLabel = connected.length === 0 ? 'No Visibility' : 'Partial Visibility';
  const visibilityText =
    connected.length === 0
      ? 'No systems are connected yet. Overall business health cannot yet be determined.'
      : `${joinAnd(connected)} ${connected.length === 1 ? 'is' : 'are'} connected. ${joinAnd(notConnected)} ${notConnected.length === 1 ? 'is' : 'are'} not yet connected. Overall business health cannot yet be determined.`;

  // Today's Priorities — evidence-backed only (CallGrid risks + unowned work).
  const priorities: Priority[] = [
    ...brain.signals.map((s) => ({ tone: s.tone as Tone, text: s.title, href: s.href })),
    ...w.attention.filter((a) => a.kind === 'work').map((a) => ({ tone: 'warn' as Tone, text: a.title, href: a.href })),
  ];

  const assigned = w.workSummary.assignedToMe;
  const acts = w.recentActivity;

  return (
    <LoopPage label="Loop Home">
      <PageHead
        trail={[{ label: 'Your Loop' }]}
        title={`${header.greeting}, ${header.displayName}`}
        subtitle={`${header.dateLabel} · ${header.organizationName}`}
        actions={
          <form className="loop-searchform" method="get" action="/crm/search" role="search">
            <input
              type="search"
              name="q"
              className="loop-input"
              placeholder="Search intake records and conversations"
              aria-label="Search the CRM"
            />
          </form>
        }
      />

      <div className="loop-home">

          {/* ── Row 1 ───────────────────────────────────────────── */}

          <Panel title="Business Status">
            <StatusWord tone="idle" label={visibilityLabel} />
            <p className="loop-home__line">{visibilityText}</p>
          </Panel>

          <Panel title="Today's Priorities">
            {priorities.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None" />
                <p className="loop-home__line">No evidence-backed priorities require your attention.</p>
              </>
            ) : (
              <ul className="loop-home__list">
                {priorities.slice(0, 4).map((p, i) => (
                  <li key={i} className="loop-home__item">
                    <span className={'loop-home__dot loop-home__dot--' + p.tone} aria-hidden="true" />
                    <Link href={p.href} className="loop-home__item-text">{p.text}</Link>
                  </li>
                ))}
                {priorities.length > 4 ? <li className="loop-home__more">and {priorities.length - 4} more.</li> : null}
              </ul>
            )}
          </Panel>

          <Panel title="My Work">
            {assigned === 0 ? (
              <>
                <StatusWord tone="idle" label="No work assigned" />
                <p className="loop-home__line">You have no work assigned. When work is assigned it will appear here.</p>
              </>
            ) : (
              <>
                <StatusNum value={assigned} label="Assigned" />
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

          {/* ── Row 2 ───────────────────────────────────────────── */}

          {/* CallGrid Intelligence — the Executive Scorecard */}
          <Panel title="CallGrid Intelligence">
            {!callgridConnected ? (
              <>
                <StatusWord tone="idle" label="No call data yet" />
                <p className="loop-home__line">CallGrid has not sent any calls yet.</p>
                <Link href="/app/admin/marketplace" className="loop-link">Open CallGrid Intelligence →</Link>
              </>
            ) : (
              <>
                <div className="score">
                  <div className="score__row score__head">
                    <span className="score__label" />
                    <span className="score__col">Yesterday<span className="score__sub">Completed</span></span>
                    <span className="score__col">Today<span className="score__sub">Live</span></span>
                  </div>
                  <ScoreRow label="Revenue" yText={showMoney(yd.available, yd.revenueCents)} tText={showMoney(td.available, td.revenueCents)} r={revTrend} />
                  <ScoreRow label="Profit" yText={showMoney(yd.available, yd.profitCents)} tText={showMoney(td.available, td.profitCents)} r={profitTrend} />
                  <ScoreRow label="Billable calls" yText={showNum(yd.available, yd.billableCalls)} tText={showNum(td.available, td.billableCalls)} r={billableTrend} />
                  <ScoreRow label="Total calls" yText={showNum(yd.available, yd.totalCalls)} tText={showNum(td.available, td.totalCalls)} r={totalTrend} neutral />
                </div>
                <Link href="/app/admin/marketplace" className="loop-link">Open CallGrid Intelligence →</Link>
              </>
            )}
          </Panel>

          {/* CRM — Phase 1: real command center with org-scoped data */}
          <Panel title="CRM">
            <StatusWord tone="good" label="Active" />
            <p className="loop-home__line">Phase 1 CRM is live with people, conversations, intake status and activity.</p>
            <Link href="/crm" className="loop-link">Open CRM →</Link>
          </Panel>

          {/* Creator Hub */}
          <Panel title="Creator Hub">
            <StatusWord tone="idle" label="Not Configured" />
            <p className="loop-home__line">Creator Hub has not yet been built.</p>
          </Panel>

          {/* ── Row 3 ───────────────────────────────────────────── */}

          {/* Accounting */}
          <Panel title="Accounting">
            <StatusWord tone="idle" label="Not Connected" />
            <p className="loop-home__line">Accounting integration has not yet been configured.</p>
          </Panel>

          {/* Recent Business Activity */}
          <Panel title="Recent Business Activity">
            {acts.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None yet" />
                <p className="loop-home__line">No recent business activity.</p>
              </>
            ) : (
              <ul className="loop-home__list">
                {acts.slice(0, 4).map((a) => (
                  <li key={a.id} className="loop-home__item">
                    <span className="loop-home__dot loop-home__dot--info" aria-hidden="true" />
                    <span className="loop-home__item-text">{a.label}</span>
                    <span className="loop-home__item-time">{relTime(a.createdAtIso)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Quick Actions — only actions that exist */}
          <Panel title="Quick Actions">
            <div className="loop-btnrow">
              {w.canCreateWork ? <Link href="/app/admin/work/new" className="loop-btn">Create work →</Link> : null}
              {w.canInvite ? <Link href="/app/admin/administration/team" className="loop-btn">Invite team member →</Link> : null}
              {!w.canCreateWork && !w.canInvite ? <p className="loop-home__line">No quick actions available for your role.</p> : null}
            </div>
          </Panel>

      </div>
    </LoopPage>
  );
}
