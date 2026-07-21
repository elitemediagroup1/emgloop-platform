import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadDashboard } from './dashboard-data';

// The Dashboard — the operational command center of Elite Media Group.
//
// One screen, no scrolling: a header and a 3×3 grid of tiles. Each tile answers
// ONE question and is a doorway — Title, a short Status, one sentence, an
// optional action. The Dashboard summarizes; the products explain.
//
// CONSTITUTIONAL: nothing here is fabricated. Every tile shows real,
// organization-scoped data or an honest "unavailable" state that says why.
// Creator Hub and Accounting have no data in this platform yet and say so —
// they are never filled with placeholder content. No developer vocabulary.

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
      <span className="tile__num">{value}</span>
      {label ? <span className="tile__num-label">{label}</span> : null}
    </div>
  );
}

function Action({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="tile__action">{label}</Link>;
}

export default async function Dashboard() {
  const { home, crm } = await loadDashboard();
  const { workspace: w, brain } = home;
  const { header } = w;

  // Real counts. "Issues / priorities" = business risks + operational decisions.
  const issues = brain.signals.length + w.attentionTotal;
  const assigned = w.workSummary.assignedToMe;
  const acts = w.recentActivity;
  const callgridConnected = brain.present && (brain.sensors?.instrumented ?? 0) > 0;

  return (
    <div className="loop-os">
      <div className="cmd">

        {/* HEADER */}
        <header className="cmd-head">
          <h1 className="cmd-head__greeting">{header.greeting}, {header.displayName}</h1>
          <p className="cmd-head__meta">{header.dateLabel} · {header.organizationName}</p>
        </header>

        <div className="tiles">

          {/* ── Row 1 ───────────────────────────────────────────── */}

          {/* Business Status */}
          <Tile title="Business Status" source="CallGrid · Work OS">
            {issues === 0 ? (
              <>
                <StatusWord tone="good" label="Operating Normally" />
                <p className="tile__line">No evidence-backed issues require your attention.</p>
              </>
            ) : (
              <>
                <StatusWord tone="warn" label={`${issues} ${issues === 1 ? 'issue' : 'issues'} to look at`} />
                <p className="tile__line">
                  {issues === 1 ? 'One issue needs' : `${issues} issues need`} your attention today.
                </p>
              </>
            )}
            <Action href="/app/admin/marketplace" label="View details →" />
          </Tile>

          {/* Today's Priorities */}
          <Tile title="Today's Priorities" source="CallGrid · Work OS">
            <StatusNum value={issues} />
            <p className="tile__line">
              {issues === 0
                ? 'No priorities today.'
                : `${issues === 1 ? 'One thing needs' : `${issues} things need`} your attention.`}
            </p>
          </Tile>

          {/* My Work */}
          <Tile title="My Work" source="Work OS">
            <StatusNum value={assigned} label="Assigned" />
            <p className="tile__line">
              {assigned === 0
                ? 'Nothing waiting for you.'
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

          {/* CallGrid Intelligence */}
          <Tile title="CallGrid Intelligence" source="CallGrid">
            {!brain.present ? (
              <>
                <StatusWord tone="idle" label="Unavailable" />
                <p className="tile__line">We can’t reach CallGrid right now.</p>
                <Action href="/app/admin/marketplace" label="Open CallGrid →" />
              </>
            ) : !callgridConnected ? (
              <>
                <StatusWord tone="idle" label="Not connected" />
                <p className="tile__line">CallGrid has not yet been connected.</p>
                <Action href="/crm/integrations" label="Connect CallGrid →" />
              </>
            ) : (
              <>
                <StatusWord tone={brain.health.tone as Tone} label={brain.health.label} />
                <p className="tile__line">{brain.health.line}</p>
                <Action href="/app/admin/marketplace" label="Open CallGrid →" />
              </>
            )}
          </Tile>

          {/* CRM */}
          <Tile title="CRM" source="CRM">
            {crm.customers === 0 && crm.openConversations === 0 ? (
              <>
                <StatusWord tone="idle" label="No activity yet" />
                <p className="tile__line">No customers or conversations yet.</p>
              </>
            ) : (
              <>
                <StatusNum value={crm.customers} label={crm.customers === 1 ? 'Customer' : 'Customers'} />
                <p className="tile__line">
                  {crm.openConversations === 0
                    ? 'No open conversations.'
                    : `${crm.openConversations} open ${crm.openConversations === 1 ? 'conversation' : 'conversations'}.`}
                </p>
              </>
            )}
            <Action href="/crm" label="Open CRM →" />
          </Tile>

          {/* Creator Hub — no such data in this platform yet. Stated plainly. */}
          <Tile title="Creator Hub">
            <StatusWord tone="idle" label="Not available" />
            <p className="tile__line">The Creator Hub isn’t set up yet.</p>
          </Tile>

          {/* ── Row 3 ───────────────────────────────────────────── */}

          {/* Accounting — no accounting data in this platform yet. */}
          <Tile title="Accounting">
            <StatusWord tone="idle" label="Not connected" />
            <p className="tile__line">No accounting system is connected yet.</p>
          </Tile>

          {/* Recent Business Activity */}
          <Tile title="Recent Business Activity" source="Work OS · CRM">
            {acts.length === 0 ? (
              <>
                <StatusWord tone="idle" label="None yet" />
                <p className="tile__line">No business activity has been recorded yet.</p>
              </>
            ) : (
              <>
                <StatusWord tone="info" label={`${acts.length} recent`} />
                <p className="tile__line">Latest: {acts[0]!.label} · {relTime(acts[0]!.createdAtIso)}.</p>
              </>
            )}
          </Tile>

          {/* System Status */}
          <Tile title="System Status" source="System">
            {brain.present ? (
              <>
                <StatusWord tone="good" label="Operational" />
                <p className="tile__line">All systems are responding normally.</p>
              </>
            ) : (
              <>
                <StatusWord tone="warn" label="Degraded" />
                <p className="tile__line">Some information can’t be reached right now.</p>
              </>
            )}
          </Tile>

        </div>
      </div>
    </div>
  );
}
