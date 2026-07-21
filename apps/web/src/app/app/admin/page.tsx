import Link from 'next/link';
import { loadHome } from './home-data';
import type { EntityTone } from '../_loop-os';

// The Dashboard — the operational home of Elite Media Group.
//
// This is the first screen every employee opens every morning. It reads top to
// bottom like opening the business: a greeting, what today's business looks
// like, what to prioritise, how healthy the business is (and whether that can be
// trusted), the reader's own work, and what has actually happened.
//
// Non-negotiables:
//   - Everything is REAL. Every line traces to a row, a derived fact, or an
//     honest "unknown / unavailable" — never a placeholder, never a fabricated
//     number, conversation, recommendation, or activity.
//   - It flows. Sections lead into each other; it is not a wall of cards.
//   - It answers, without a click: what happened, why, what matters, what needs
//     me, what to do next, and whether I can trust what I'm seeing.
//
// Presentation only — no Prisma, no engine. The business half is projected from
// the Executive Brain (home-data.ts); a failed read degrades to honest states.

export const dynamic = 'force-dynamic';

function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return d + 'd ago';
}

// Operational item kind -> a calm tone for the priority marker.
const KIND_TONE: Record<string, EntityTone> = {
  work: 'info',
  conversation: 'warn',
  request: 'warn',
  invitation: 'idle',
};

interface Priority {
  id: string;
  tone: EntityTone;
  tag: string;
  title: string;
  why: string;
  href: string;
  cta: string;
}

export default async function Dashboard() {
  const { workspace: data, brain } = await loadHome('assigned');
  const {
    header, attention, attentionTotal, nextAction, myWork, recentActivity,
    completedTodayCount, canCreateWork,
  } = data;

  // ----- Today's Business — the calm opening line, then what the Brain knows.
  const priorityCount = brain.signals.length + attentionTotal + brain.actions.length;
  const mood =
    priorityCount === 0
      ? brain.health.measured && brain.health.tone === 'good'
        ? 'Everything is running smoothly. Nothing needs a decision from you right now.'
        : 'It’s quiet so far this morning. Nothing needs a decision from you right now.'
      : `There ${priorityCount === 1 ? 'is' : 'are'} ${priorityCount} thing${priorityCount === 1 ? '' : 's'} to look at this morning — they’re in Today’s Priorities, just below.`;
  const completedLine =
    completedTodayCount > 0
      ? `${completedTodayCount} work item${completedTodayCount === 1 ? '' : 's'} ${completedTodayCount === 1 ? 'was' : 'were'} completed today.`
      : null;

  // ----- Today's Priorities — Brain risks, operational decisions, and the
  // Brain's recommended actions, fused into one honest list. Nothing invented.
  const priorities: Priority[] = [
    ...brain.signals.map((s) => ({
      id: s.id, tone: s.tone, tag: 'Business risk', title: s.title, why: s.why, href: s.href, cta: 'Look closer',
    })),
    ...attention.map((a) => ({
      id: a.key, tone: KIND_TONE[a.kind] ?? 'info', tag: a.kindLabel, title: a.title, why: a.reason, href: a.href, cta: a.cta,
    })),
    ...brain.actions.map((a) => ({
      id: a.id, tone: 'info' as EntityTone, tag: 'Opportunity', title: a.title, why: a.why, href: a.href, cta: 'Review',
    })),
  ];
  const shownPriorities = priorities.slice(0, 6);
  const morePriorities = priorityCount - shownPriorities.length;

  // ----- Business Health — the trust line answers "can I trust this?".
  const trustLine = brain.health.measured
    ? `Measured from ${brain.sensors?.instrumented ?? 0} connected data source${(brain.sensors?.instrumented ?? 0) === 1 ? '' : 's'}. Every figure here is real or marked unknown — never a guess.`
    : brain.present
      ? 'This isn’t measurable yet — no data source is connected, so it’s shown as unknown rather than guessed.'
      : 'We can’t measure business health right now, so it’s shown as unavailable rather than assumed healthy.';

  return (
    <div className="loop-os">
      <div className="home">

        {/* GOOD MORNING */}
        <header className="home-hero">
          <h1 className="home-hero__greeting">{header.greeting}, {header.displayName}.</h1>
          <p className="home-hero__meta">{header.dateLabel} · {header.organizationName}</p>
        </header>

        {/* TODAY'S BUSINESS */}
        <section className="home-sec">
          <p className="home-sec__label">Today’s Business</p>
          <p className="home-lede">{mood}</p>
          {brain.present && brain.summary.length > 0
            ? brain.summary.map((line, i) => (
                <p key={i} className="home-lede home-lede--muted">{line}</p>
              ))
            : null}
          {completedLine ? <p className="home-lede home-lede--muted">{completedLine}</p> : null}
        </section>

        {/* TODAY'S PRIORITIES */}
        <section className="home-sec">
          <p className="home-sec__label">
            Today’s Priorities
            {priorityCount > 0 ? <span className="home-sec__count">{priorityCount}</span> : null}
          </p>
          {shownPriorities.length === 0 ? (
            <p className="home-lede home-lede--muted">
              You’re clear. Nothing needs your attention right now — business risks, work without an
              owner, and quiet conversations will appear here the moment they happen.
            </p>
          ) : (
            <ul className="home-pri">
              {shownPriorities.map((p) => (
                <li key={p.id} className="home-pri__item">
                  <span className={'home-pri__dot home-pri__dot--' + p.tone} aria-hidden="true" />
                  <div className="home-pri__body">
                    <span className="home-pri__tag">{p.tag}</span>
                    <span className="home-pri__title">{p.title}</span>
                    <span className="home-pri__why">{p.why}</span>
                  </div>
                  <Link href={p.href} className="home-pri__cta">{p.cta}</Link>
                </li>
              ))}
            </ul>
          )}
          {morePriorities > 0 ? (
            <p className="home-more">and {morePriorities} more waiting behind these.</p>
          ) : null}
        </section>

        {/* BUSINESS HEALTH */}
        <section className="home-sec">
          <p className="home-sec__label">Business Health</p>
          <p className="home-health__line">
            <span className={'home-health__word home-health__word--' + brain.health.tone}>{brain.health.label}.</span>{' '}
            {brain.health.line}
          </p>
          <p className="home-health__trust">{trustLine}</p>
          {brain.present ? (
            <Link href="/app/admin/marketplace" className="home-link">See the full picture →</Link>
          ) : null}
        </section>

        {/* MY WORK */}
        <section className="home-sec">
          <p className="home-sec__label">My Work</p>
          {nextAction ? (
            <Link href={nextAction.href} className="home-next">
              <div className="home-next__body">
                <span className="home-next__eyebrow">Next up</span>
                <span className="home-next__title">{nextAction.title}</span>
                <span className="home-next__stage">{nextAction.stageName}</span>
              </div>
              <span className="home-next__verb">{nextAction.verb} →</span>
            </Link>
          ) : (
            <p className="home-lede home-lede--muted">
              You have nothing assigned to work on right now.
              {canCreateWork ? ' Start something when you’re ready.' : ''}
            </p>
          )}

          {myWork.length > 0 ? (
            <ul className="home-work">
              {myWork.map((w) => (
                <li key={w.workInstanceId}>
                  <Link href={w.href} className="home-work__row">
                    <span className="home-work__title">{w.title}</span>
                    <span className="home-work__meta">{w.stageName} · {w.assignedLabel}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="home-actions">
            <Link href="/app/admin/work" className="home-link">See all my work →</Link>
            {!nextAction && myWork.length === 0 && canCreateWork ? (
              <Link href="/app/admin/work/new" className="home-link">Start new work →</Link>
            ) : null}
          </div>
        </section>

        {/* RECENT BUSINESS ACTIVITY */}
        <section className="home-sec">
          <p className="home-sec__label">Recent Business Activity</p>
          {recentActivity.length === 0 ? (
            <p className="home-lede home-lede--muted">
              Nothing has happened in the business yet. Work finished, customers added and people
              invited will appear here as your team operates.
            </p>
          ) : (
            <ul className="home-act">
              {recentActivity.map((a) => (
                <li key={a.id} className="home-act__item">
                  <span className="home-act__label">{a.label}</span>
                  <span className="home-act__meta">{a.actorName} · {relTime(a.createdAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </div>
  );
}
