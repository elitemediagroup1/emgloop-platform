import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadDashboard, type ScoreMetrics } from './dashboard-data';
import { money, num } from '../_loop-os';

// The Operational Home of Elite Media Group.
//
// One screen, no scroll: a header (greeting + global search) and nine tiles.
// Within 15 seconds an employee sees how the business did yesterday and today,
// whether anything needs them, whether they have work, and whether it can all be
// trusted.
//
// CONSTITUTIONAL: Loop never fabricates business reality. Every value is real
// org-scoped data or an honest Unknown / Unavailable. Money is never estimated.
// The CRM shows nothing off the shared Customer table. No developer vocabulary.

export const dynamic = 'force-dynamic';

type Tone = 'good' | 'warn' | 'crit' | 'info' | 'idle';

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + 'd ago';
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Money that may be unknown — never invents $0 for missing economics. */
function money2(cents: number | null): string {
  return cents === null ? 'Unknown' : money(cents);
}

function Tile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tile" aria-label={title}>
      <div className="tile__head">
        <span className="tile__title">{title}</span>
      </div>
      {children}
    </section>
  );
}

function StatusWord({ tone, label }: { tone: Tone; label: string }) {
  return (
    <div className="tile__status">
      <span className={'tile__dot tile__dot--' + tone} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function StatusNum({ value, label }: { value: number; label?: string }) {
  return (
    <div className="tile__status">
      <span className="tile__num">{value.toLocaleString('en-US')}</span>
      {label ? <span className="tile__num-label">{label}</span> : null}
    </div>
  );
}

function ScoreRow({ label, y, t, delta }: { label: string; y: string; t: string; delta?: ReactNode }) {
  return (
    <div className="score__row">
      <span className="score__label">{label}</span>
      <span className="score__val">{y}</span>
      <span className="score__val">{t}{delta}</span>
    </div>
  );
}

interface Priority { tone: Tone; text: string; href: string }

export default async function Dashboard() {
  const { home, callgrid } = await loadDashboard();
  const { workspace: w, brain } = home;
  const { header } = w;
  const { yesterday: yd, today: td } = callgrid;

  const callgridConnected = callgrid.total > 0;

  // ── Business Status — connectivity/visibility, never invented health.
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

  // ── Today's Priorities — evidence-backed only (CallGrid risks + unowned work).
  const priorities: Priority[] = [
    ...brain.signals.map((s) => ({ tone: s.tone as Tone, text: s.title, href: s.href })),
    ...w.attention.filter((a) => a.kind === 'work').map((a) => ({ tone: 'warn' as Tone, text: a.title, href: a.href })),
  ];

  const assigned = w.workSummary.assignedToMe;
  const acts = w.recentActivity;

  // ── CallGrid revenue comparison (today vs yesterday), only when both known.
  let revDelta: ReactNode = null;
  if (td.revenueCents !== null && yd.revenueCents !== null && yd.revenueCents > 0) {
    const pct = Math.round(((td.revenueCents - yd.revenueCents) / yd.revenueCents) * 100);
    const up = pct >= 0;
    revDelta = (
      <span className={'score__delta score__delta--' + (up ? 'up' : 'down')}>
        {up ? '↑' : '↓'} {Math.abs(pct)}%
      </span>
    );
  }

  return (
    <div className="loop-os">
      <div className="cmd">

        <header className="cmd-head">
          <div className="cmd-head__main">
            <h1 className="cmd-head__greeting">{header.greeting}, {header.displayName}</h1>
            <p className="cmd-head__meta">{header.dateLabel} · {header.organizationName}</p>
          </div>
          <form className="cmd-search" method="get" action="/crm/search" role="search">
            <input
              type="search"
              name="q"
              className="cmd-search__input"
              placeholder="Search companies, contacts, work…"
              aria-label="Search"
            />
          </form>
        </header>

        <div className="tiles">

          {/* ── Row 1 ───────────────────────────────────────────── */}

          <Tile title="Business Status">
            <StatusWord tone="idle" label={visibilityLabel} />
            <p className="tile__line">{visibilityText}</p>
          </Tile>

          <Tile title="Today's Priorities">
            {priorities.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None" />
                <p className="tile__line">No evidence-backed priorities require your attention.</p>
              </>
            ) : (
              <ul className="tile__list">
                {priorities.slice(0, 4).map((p, i) => (
                  <li key={i} className="tile__li">
                    <span className={'tile__dot tile__dot--' + p.tone} aria-hidden="true" />
                    <Link href={p.href} className="tile__li-text">{p.text}</Link>
                  </li>
                ))}
                {priorities.length > 4 ? (
                  <li className="tile__li-more">and {priorities.length - 4} more.</li>
                ) : null}
              </ul>
            )}
          </Tile>

          <Tile title="My Work">
            {assigned === 0 ? (
              <>
                <StatusWord tone="idle" label="No work assigned" />
                <p className="tile__line">You have no work assigned. When work is assigned it will appear here.</p>
              </>
            ) : (
              <>
                <StatusNum value={assigned} label="Assigned" />
                <p className="tile__line">
                  {w.nextAction ? `Next: ${w.nextAction.title}.` : `${assigned === 1 ? 'One item is' : `${assigned} items are`} waiting for you.`}
                </p>
              </>
            )}
            <div className="tile__row">
              <Link href="/app/admin/work" className="tile__action">View my work →</Link>
              {w.canCreateWork ? <Link href="/app/admin/work/new" className="tile__action">Create work →</Link> : null}
            </div>
          </Tile>

          {/* ── Row 2 ───────────────────────────────────────────── */}

          {/* CallGrid Intelligence — the Executive Scorecard */}
          <Tile title="CallGrid Intelligence">
            {!callgridConnected ? (
              <>
                <StatusWord tone="idle" label="No call data yet" />
                <p className="tile__line">CallGrid has not sent any calls yet.</p>
                <Link href="/app/admin/marketplace" className="tile__action">Open CallGrid Intelligence →</Link>
              </>
            ) : (
              <>
                <div className="score">
                  <div className="score__row score__head">
                    <span className="score__label" />
                    <span className="score__val">Yesterday</span>
                    <span className="score__val">Today</span>
                  </div>
                  <ScoreRow label="Revenue" y={money2(yd.revenueCents)} t={money2(td.revenueCents)} delta={revDelta} />
                  <ScoreRow label="Profit" y={money2(yd.profitCents)} t={money2(td.profitCents)} />
                  <ScoreRow label="Billable" y={num(yd.billableCalls)} t={num(td.billableCalls)} />
                  <ScoreRow label="Total calls" y={num(yd.totalCalls)} t={num(td.totalCalls)} />
                </div>
                <Link href="/app/admin/marketplace" className="tile__action">Open CallGrid Intelligence →</Link>
              </>
            )}
          </Tile>

          {/* CRM — not built; reads nothing */}
          <Tile title="CRM">
            <StatusWord tone="idle" label="Not Configured" />
            <p className="tile__line">The CRM has not yet been built.</p>
            <span className="tile__action tile__action--disabled" aria-disabled="true">Open CRM →</span>
          </Tile>

          {/* Creator Hub */}
          <Tile title="Creator Hub">
            <StatusWord tone="idle" label="Not Configured" />
            <p className="tile__line">Creator Hub has not yet been built.</p>
          </Tile>

          {/* ── Row 3 ───────────────────────────────────────────── */}

          {/* Accounting */}
          <Tile title="Accounting">
            <StatusWord tone="idle" label="Not Connected" />
            <p className="tile__line">Accounting integration has not yet been configured.</p>
          </Tile>

          {/* Recent Business Activity */}
          <Tile title="Recent Business Activity">
            {acts.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None yet" />
                <p className="tile__line">No business activity has been recorded yet.</p>
              </>
            ) : (
              <ul className="tile__list">
                {acts.slice(0, 4).map((a) => (
                  <li key={a.id} className="tile__li">
                    <span className="tile__dot tile__dot--info" aria-hidden="true" />
                    <span className="tile__li-text">{a.label}</span>
                    <span className="tile__li-time">{relTime(a.createdAtIso)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          {/* Quick Actions — only actions that exist */}
          <Tile title="Quick Actions">
            <div className="tile__qa">
              {w.canCreateWork ? (
                <Link href="/app/admin/work/new" className="tile__qa-btn">Create work →</Link>
              ) : null}
              <Link href="/crm/users" className="tile__qa-btn">Invite team member →</Link>
            </div>
          </Tile>

        </div>
      </div>
    </div>
  );
}
