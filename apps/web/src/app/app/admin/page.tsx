import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadDashboard } from './dashboard-data';

// The Dashboard — the operational command center of Elite Media Group.
//
// One screen, no scroll: a header (greeting + global search) and a 3×3 grid of
// tiles. Each tile answers ONE business question and is a doorway.
//
// CONSTITUTIONAL: Loop never fabricates business reality. Every value is real
// org-scoped data or an honest "unavailable" state that says why. Audited so
// that: caller IDs are never shown as CRM customers; CallGrid "connected" is
// judged by real call data, not a constant flag; only evidence-backed priorities
// appear (no demo conversations); and every action links to a route that exists.
// No developer vocabulary reaches the screen.

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

function Tile({ title, source, children }: { title: string; source?: string; children: ReactNode }) {
  return (
    <section className="tile" aria-label={title}>
      <div className="tile__head">
        <span className="tile__title">{title}</span>
        {source ? <span className="tile__src">{source}</span> : null}
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

function Action({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="tile__action">{label}</Link>;
}

interface Priority { tone: Tone; text: string; source: string; href: string }

export default async function Dashboard() {
  const { home, callgrid } = await loadDashboard();
  const { workspace: w, brain } = home;
  const { header } = w;

  // Evidence-backed priorities only. CallGrid risks + work that needs an owner.
  // Deliberately excluded: demo-seeded conversations and ServiceRequests (which
  // no code path ever creates) — showing them would be fabricated business.
  const priorities: Priority[] = [
    ...brain.signals.map((s) => ({ tone: s.tone as Tone, text: s.title, source: 'CallGrid', href: s.href })),
    ...w.attention
      .filter((a) => a.kind === 'work')
      .map((a) => ({ tone: 'warn' as Tone, text: a.title, source: 'Work OS', href: a.href })),
  ];
  const issues = priorities.length;

  const assigned = w.workSummary.assignedToMe;
  const acts = w.recentActivity;
  const callgridConnected = callgrid.total > 0;
  const callgridRecent = callgrid.recent > 0;

  return (
    <div className="loop-os">
      <div className="cmd">

        {/* HEADER — greeting + global search */}
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

          {/* Business Status — never a mystery; names the issue or points to it */}
          <Tile title="Business Status" source="CallGrid · Work OS">
            {issues === 0 ? (
              <>
                <StatusWord tone="good" label="Operating Normally" />
                <p className="tile__line">No operational issues require attention.</p>
              </>
            ) : issues === 1 ? (
              <>
                <StatusWord tone="warn" label="One issue to review" />
                <p className="tile__line">{priorities[0]!.text}</p>
              </>
            ) : (
              <>
                <StatusWord tone="warn" label={`${issues} issues to review`} />
                <p className="tile__line">The details are listed in Today’s Priorities.</p>
              </>
            )}
            <Action href="/app/admin/marketplace" label="View details →" />
          </Tile>

          {/* Today's Priorities — the actual evidence-backed items, with source */}
          <Tile title="Today's Priorities" source="CallGrid · Work OS">
            {priorities.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None" />
                <p className="tile__line">No evidence-backed priorities require your attention.</p>
              </>
            ) : (
              <ul className="tile__list">
                {priorities.slice(0, 3).map((p, i) => (
                  <li key={i} className="tile__li">
                    <span className={'tile__dot tile__dot--' + p.tone} aria-hidden="true" />
                    <Link href={p.href} className="tile__li-text">{p.text}</Link>
                    <span className="tile__li-src">{p.source}</span>
                  </li>
                ))}
                {priorities.length > 3 ? (
                  <li className="tile__li-more">and {priorities.length - 3} more.</li>
                ) : null}
              </ul>
            )}
          </Tile>

          {/* My Work */}
          <Tile title="My Work" source="Work OS">
            <StatusNum value={assigned} label="Assigned" />
            <p className="tile__line">
              {assigned === 0
                ? 'You have no work assigned. When work is assigned it will appear here.'
                : w.nextAction
                  ? `Next: ${w.nextAction.title}.`
                  : `${assigned === 1 ? 'One item is' : `${assigned} items are`} waiting for you.`}
            </p>
            {assigned > 0 ? (
              <Action href="/app/admin/work" label="View my work →" />
            ) : w.canCreateWork ? (
              <Action href="/app/admin/work/new" label="Create work →" />
            ) : (
              <Action href="/app/admin/work" label="View my work →" />
            )}
          </Tile>

          {/* ── Row 2 ───────────────────────────────────────────── */}

          {/* CallGrid Intelligence — judged by real call data */}
          <Tile title="CallGrid Intelligence" source="CallGrid">
            {!callgridConnected ? (
              <>
                <StatusWord tone="idle" label="Not connected" />
                <p className="tile__line">CallGrid has not sent any call data yet.</p>
                <Action href="/crm/integrations" label="Connect CallGrid →" />
              </>
            ) : !callgridRecent ? (
              <>
                <StatusWord tone="idle" label="Connected" />
                <p className="tile__line">Connected, but no calls in the last 30 days.</p>
                <Action href="/app/admin/marketplace" label="Open CallGrid →" />
              </>
            ) : (
              <>
                <StatusNum value={callgrid.recent} label="calls · 30 days" />
                <p className="tile__line">
                  {brain.signals.length === 0
                    ? 'No operational issues flagged.'
                    : `${brain.signals.length === 1 ? 'One issue needs' : `${brain.signals.length} issues need`} review.`}
                </p>
                <Action href="/app/admin/marketplace" label="Open CallGrid →" />
              </>
            )}
          </Tile>

          {/* CRM — NOT built. Displays nothing off the Customer table, because
              that table is shared by CallGrid call ingestion. No cross-classification. */}
          <Tile title="CRM">
            <StatusWord tone="idle" label="Not Configured" />
            <p className="tile__line">The CRM has not been built or connected yet.</p>
          </Tile>

          {/* Creator Hub — leave as Not Configured until the feature exists */}
          <Tile title="Creator Hub">
            <StatusWord tone="idle" label="Not Configured" />
            <p className="tile__line">The Creator Hub isn’t available yet.</p>
          </Tile>

          {/* ── Row 3 ───────────────────────────────────────────── */}

          {/* Accounting */}
          <Tile title="Accounting">
            <StatusWord tone="idle" label="Not connected" />
            <p className="tile__line">No accounting system is connected yet.</p>
          </Tile>

          {/* Recent Business Activity — business events only (sign-ins excluded) */}
          <Tile title="Recent Business Activity" source="Work OS · CRM">
            {acts.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None yet" />
                <p className="tile__line">No business activity has been recorded yet.</p>
              </>
            ) : (
              <ul className="tile__list">
                {acts.slice(0, 3).map((a) => (
                  <li key={a.id} className="tile__li">
                    <span className="tile__dot tile__dot--info" aria-hidden="true" />
                    <span className="tile__li-text">{a.label}</span>
                    <span className="tile__li-src">{relTime(a.createdAtIso)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          {/* Quick Actions — replaces System Status. Only actions that exist. */}
          <Tile title="Quick Actions">
            <div className="tile__qa">
              {w.canCreateWork ? (
                <Link href="/app/admin/work/new" className="tile__qa-btn">Create work →</Link>
              ) : null}
              <Link href="/crm/users" className="tile__qa-btn">Invite team member →</Link>
              {!callgridConnected ? (
                <Link href="/crm/integrations" className="tile__qa-btn">Connect CallGrid →</Link>
              ) : null}
            </div>
          </Tile>

        </div>
      </div>
    </div>
  );
}
