import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadWorkDashboard, type QueueRow } from './work-data';

// Work OS — the operating surface for getting work done.
//
// Same product as the Dashboard: a compact 3·3·2 tile grid that fits one screen.
// Business language only — no Work Instance / Blueprint / Stage / engine wording.
// Backend behavior is unchanged; this only reshapes the experience.

export const dynamic = 'force-dynamic';

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + 'd ago';
}

function Tile({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={'tile' + (wide ? ' tile--wide' : '')} aria-label={title}>
      <div className="tile__head"><span className="tile__title">{title}</span></div>
      {children}
    </section>
  );
}

function StatusWord({ label }: { label: string }) {
  return (
    <div className="tile__status">
      <span className="tile__dot tile__dot--idle" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

// A count tile: the number, then the top item(s), or an honest empty line.
function CountTile({ title, rows, emptyLine, tone = 'info' }: {
  title: string; rows: QueueRow[]; emptyLine: string; tone?: 'info' | 'warn';
}) {
  return (
    <Tile title={title}>
      {rows.length === 0 ? (
        <>
          <StatusWord label="None" />
          <p className="tile__line">{emptyLine}</p>
        </>
      ) : (
        <>
          <div className="tile__status"><span className="tile__num">{rows.length}</span></div>
          <ul className="tile__list">
            {rows.slice(0, 2).map((r) => (
              <li key={r.workStageId} className="tile__li">
                <span className={'tile__dot tile__dot--' + tone} aria-hidden="true" />
                <Link href={r.href} className="tile__li-text">{r.title}</Link>
              </li>
            ))}
            {rows.length > 2 ? <li className="tile__li-more">and {rows.length - 2} more.</li> : null}
          </ul>
        </>
      )}
    </Tile>
  );
}

export default async function WorkOSPage() {
  const {
    assigned, readyToStart, blocked, needsOwner, completedToday, recentActivity, nextAction, hasBlueprints,
  } = await loadWorkDashboard();

  const startHref = hasBlueprints ? '/app/admin/work/new' : '/app/admin/work/blueprints/new';

  return (
    <div className="loop-os">
      <div className="cmd">

        {/* HEADER ROW */}
        <header className="cmd-head">
          <div className="cmd-head__main">
            <h1 className="cmd-head__greeting">Work OS</h1>
            <p className="cmd-head__meta">What needs your attention and what is moving across the team.</p>
          </div>
          <Link href={startHref} className="adm-btn adm-btn--primary cmd-head__cta">Start Work</Link>
        </header>

        <div className="tiles">

          {/* ── Row 1 ─────────────────────────────── */}

          <Tile title="My Work">
            {assigned.length === 0 ? (
              <>
                <StatusWord label="No work assigned" />
                <p className="tile__line">Nothing is waiting for you.</p>
              </>
            ) : (
              <>
                <div className="tile__status"><span className="tile__num">{assigned.length}</span><span className="tile__num-label">Assigned</span></div>
                <ul className="tile__list">
                  {assigned.slice(0, 2).map((r) => (
                    <li key={r.workStageId} className="tile__li">
                      <span className="tile__dot tile__dot--info" aria-hidden="true" />
                      <Link href={r.href} className="tile__li-text">{r.title}</Link>
                    </li>
                  ))}
                  {assigned.length > 2 ? <li className="tile__li-more">and {assigned.length - 2} more.</li> : null}
                </ul>
              </>
            )}
            <div className="tile__row">
              {nextAction ? <Link href={nextAction.href} className="tile__action">View my work →</Link> : null}
              <Link href={startHref} className="tile__action">Start work →</Link>
            </div>
          </Tile>

          <CountTile title="Ready to Start" rows={readyToStart} emptyLine="Nothing is ready to start." tone="info" />

          <CountTile title="Waiting / Blocked" rows={blocked} emptyLine="Nothing is waiting or blocked." tone="warn" />

          {/* ── Row 2 ─────────────────────────────── */}

          <CountTile title="Needs an Owner" rows={needsOwner} emptyLine="No work needs an owner." tone="warn" />

          {/* Verification isn't wired at runtime → honestly always empty, never faked. */}
          <Tile title="Needs Verification">
            <StatusWord label="None" />
            <p className="tile__line">Nothing needs verification.</p>
          </Tile>

          <CountTile title="Completed Today" rows={completedToday} emptyLine="Nothing has been completed today." tone="info" />

          {/* ── Row 3 ─────────────────────────────── */}

          <Tile title="Recent Work Activity" wide>
            {recentActivity.length === 0 ? (
              <>
                <StatusWord label="None yet" />
                <p className="tile__line">No recent work activity.</p>
              </>
            ) : (
              <ul className="tile__list">
                {recentActivity.map((a) => (
                  <li key={a.id} className="tile__li">
                    <span className="tile__dot tile__dot--info" aria-hidden="true" />
                    <span className="tile__li-text">{a.label} · {a.who}</span>
                    <span className="tile__li-time">{relTime(a.atIso)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          <Tile title="Quick Actions">
            <div className="tile__qa">
              <Link href={startHref} className="tile__qa-btn">Start Work →</Link>
              <Link href="/app/admin/work/team" className="tile__qa-btn">View Team Work →</Link>
            </div>
          </Tile>

        </div>
      </div>
    </div>
  );
}
