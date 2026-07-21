import Link from 'next/link';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { loadHome } from './home-data';
import { parseWorkFilter, type WorkFilter } from './workspace-home-data';
import { markHomeNotificationReadAction } from './workspace-home-actions';

// The operational Home — /app/admin.
//
// Every owner/admin lands here first. It is the single place the business
// explains itself, top to bottom, in the order the reader asks:
//
//   1. Is everything okay?      -> Business Health  (the Brain's own health band)
//   2. What needs me?           -> Today's Attention (the Brain's RISKS and the
//                                  operational decisions, fused into ONE list)
//   3. What should I do next?   -> Recommended Actions (business) + My Work (mine)
//   4. What's the fuller story? -> Business Summary  (-> CallGrid Intelligence)
//   5. What happened recently?  -> Recent Activity
//
// Everything here is a doorway: each section introduces an answer that the
// CallGrid Intelligence and Work OS pages let you drill deeper into. This is not
// a dashboard of metrics — it is the operational home of the company.
//
// Presentation only. No Prisma, no demo store, no fabricated metrics. The Brain
// half is PROJECTED from the Executive Brain (home-data.ts); a failed read
// degrades Home to its work half rather than inventing a healthy-looking brief.

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

const NOTE_ICON: Record<string, string> = {
  next_action_ready: 'flow',
  assigned: 'team',
  completed: 'activity',
  approval_needed: 'cog',
};

const ACTIVITY_ICON: Record<string, string> = {
  work: 'flow',
  customer: 'users',
  invitation: 'team',
  auth: 'activity',
  system: 'cog',
};

const ATTENTION_ICON: Record<string, string> = {
  work: 'flow',
  conversation: 'chat',
  request: 'users',
  invitation: 'team',
};

const SUMMARY_FILTERS: { key: WorkFilter; label: string }[] = [
  { key: 'assigned', label: 'Assigned to Me' },
  { key: 'ready', label: 'Ready Now' },
  { key: 'blocked', label: 'Waiting / Blocked' },
  { key: 'completed', label: 'Completed Today' },
];

const EMPTY_FOR_FILTER: Record<WorkFilter, { line: string; next: string }> = {
  assigned: {
    line: 'No work is assigned to you.',
    next: 'Create work from a blueprint to put a process in motion.',
  },
  ready: {
    line: 'Nothing is ready for you right now.',
    next: 'Ready work appears here the moment a colleague finishes the step before yours.',
  },
  blocked: {
    line: 'Nothing of yours is waiting on an earlier step.',
    next: 'Work lands here when you own a stage that someone else has to reach first.',
  },
  completed: {
    line: 'You have not completed any work today.',
    next: 'Finish a stage in My Work and it will be recorded here.',
  },
};

interface PageProps {
  searchParams?: { filter?: string };
}

export default async function OperationalHome({ searchParams }: PageProps) {
  const activeFilter = parseWorkFilter(searchParams?.filter);
  const { workspace: data, brain } = await loadHome(activeFilter);
  const {
    header, executiveSummary, attention, attentionTotal, nextAction, workSummary,
    myWork, notifications, recentActivity, completedTodayCount, gettingStarted,
  } = data;

  const summaryValues: Record<WorkFilter, number> = {
    assigned: workSummary.assignedToMe,
    ready: workSummary.readyNow,
    blocked: workSummary.waitingBlocked,
    completed: workSummary.completedToday,
  };

  const empty = EMPTY_FOR_FILTER[activeFilter];

  // The unified attention count: the Brain's risks AND the operational decisions.
  const totalAttention = brain.signals.length + attentionTotal;
  const moreAttention = attentionTotal - attention.length;

  return (
    <div className="loop-os wh wh--dense">
      <div className="wh__main">

        {/* HEADER — who, where, and what is waiting, in one line */}
        <header className="wh-header">
          <p className="wh-header__greeting">{header.greeting}, {header.displayName}.</p>
          <div className="wh-header__meta">
            <span className="wh-header__org">{header.organizationName}</span>
            <span className="wh-header__dot" aria-hidden="true">·</span>
            <span>{header.dateLabel}</span>
            <span className="wh-header__dot" aria-hidden="true">·</span>
            <span className="wh-header__role">{header.roleLabel}</span>
          </div>
          {executiveSummary.length > 0 ? (
            <p className="wh-summline">
              {executiveSummary.map((line, i) => (
                <span key={i} className="wh-summline__part">{line}</span>
              ))}
            </p>
          ) : null}
        </header>

        {/* 1. BUSINESS HEALTH — is everything okay, answered in one line */}
        <section className={'wh-card wh-health wh-health--' + brain.health.tone} aria-label="Business health">
          <div className="wh-health__main">
            <span className="wh-health__eyebrow">Business Health</span>
            <p className="wh-health__line">{brain.health.line}</p>
          </div>
          <div className="wh-health__side">
            <span className={'mkt-intel__health mkt-intel__health--' + brain.health.tone}>{brain.health.label}</span>
            <Link href="/app/admin/marketplace" className="wh-card__link">Open CallGrid Intelligence →</Link>
          </div>
        </section>

        {/* 2. TODAY'S ATTENTION — the Brain's risks + operational decisions, fused */}
        <section className="wh-card wh-att" aria-label="Today's attention">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              Today&rsquo;s Attention
              {totalAttention > 0 ? <span className="wh-count">{totalAttention}</span> : null}
            </h2>
            <span className="wh-card__scope">Most important first</span>
          </div>

          {totalAttention === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">Nothing needs a decision from you right now.</p>
              <p className="wh-empty__next">
                Business risks the Brain surfaces, work without an owner, conversations that go quiet
                and unqualified requests all appear here — most important first — as they happen.
              </p>
            </div>
          ) : (
            <ul className="wh-list">
              {/* From the Brain — business risks, severity-first */}
              {brain.signals.map((s) => (
                <li key={s.id} className="wh-work">
                  <span className={'wh-att__icon wh-att__icon--' + s.tone} aria-hidden="true">
                    <SidebarIcon name="brain" size={14} />
                  </span>
                  <div className="wh-work__main">
                    <span className="wh-work__title">{s.title}</span>
                    <div className="wh-work__meta">
                      <span className="wh-att__kind">Risk · {s.sevLabel}</span>
                    </div>
                    <p className="wh-why">{s.why}</p>
                  </div>
                  <Link href={s.href} className="wh-btn wh-btn--ghost wh-btn--sm">Look closer</Link>
                </li>
              ))}
              {/* Operational — decisions only the owner can clear */}
              {attention.map((a) => (
                <li key={a.key} className="wh-work">
                  <span className={'wh-att__icon wh-att__icon--' + a.kind} aria-hidden="true">
                    <SidebarIcon name={ATTENTION_ICON[a.kind] ?? 'activity'} size={14} />
                  </span>
                  <div className="wh-work__main">
                    <Link href={a.href} className="wh-work__title">{a.title}</Link>
                    <div className="wh-work__meta">
                      <span className="wh-att__kind">{a.kindLabel}</span>
                      <span className="wh-work__dot" aria-hidden="true">·</span>
                      <span className="wh-work__assigned">{a.reason}</span>
                    </div>
                  </div>
                  <Link href={a.href} className="wh-btn wh-btn--ghost wh-btn--sm">{a.cta}</Link>
                </li>
              ))}
            </ul>
          )}
          {moreAttention > 0 ? (
            <p className="wh-note-line">
              {moreAttention} more operational {moreAttention === 1 ? 'item is' : 'items are'} waiting behind these.
            </p>
          ) : null}
        </section>

        {/* 3a. RECOMMENDED ACTIONS — what to do next, at the business level */}
        <section className="wh-card" aria-label="Recommended actions">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              Recommended Actions
              {brain.actions.length > 0 ? <span className="wh-count">{brain.actions.length}</span> : null}
            </h2>
            <span className="wh-card__scope">Evidence-backed</span>
          </div>
          {brain.actions.length === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">
                {brain.present
                  ? 'The Brain only recommends an action when evidence supports one.'
                  : 'The Brain is waiting for an instrumented sensor before it recommends anything.'}
              </p>
              <p className="wh-empty__next">
                When a source, buyer or campaign shows an evidence-backed move worth making, it appears
                here with the expected impact and the numbers behind it.
              </p>
            </div>
          ) : (
            <ul className="wh-list">
              {brain.actions.map((a) => (
                <li key={a.id} className="wh-work">
                  <span className="wh-att__icon wh-att__icon--info" aria-hidden="true">
                    <SidebarIcon name="star" size={14} />
                  </span>
                  <div className="wh-work__main">
                    <span className="wh-work__title">{a.title}</span>
                    <p className="wh-why">{a.why}</p>
                    <div className="wh-work__meta">
                      {a.impact ? <span className="wh-rec__impact">Expected: {a.impact}</span> : null}
                      <span className="wh-conf">{a.confidencePct}% confidence</span>
                    </div>
                  </div>
                  <Link href={a.href} className="wh-btn wh-btn--ghost wh-btn--sm">Review</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3b. YOUR NEXT ACTION — the one step you can complete right now */}
        <section className="wh-card wh-next wh-next--compact" aria-label="Next action">
          <div className="wh-next__lead">
            <span className="wh-next__eyebrow">Your Next Action</span>
            {nextAction ? (
              <>
                <span className="wh-next__title">{nextAction.title}</span>
                <span className="wh-next__stage">
                  <SidebarIcon name="flow" size={13} /> {nextAction.stageName}
                </span>
              </>
            ) : (
              <span className="wh-next__title wh-next__title--calm">
                You{'’'}re caught up. No work step is waiting on you.
              </span>
            )}
          </div>
          {nextAction ? (
            <Link href={nextAction.href} className="wh-btn wh-btn--primary">{nextAction.verb}</Link>
          ) : null}
        </section>

        <section className="wh-summary" aria-label="My work summary">
          {SUMMARY_FILTERS.map((f) => {
            const active = data.activeFilter === f.key;
            const href = f.key === 'assigned' ? '/app/admin' : '/app/admin?filter=' + f.key;
            return (
              <Link
                key={f.key}
                href={href}
                scroll={false}
                className={'wh-summary__card' + (active ? ' is-active' : '')}
                aria-current={active ? 'true' : undefined}
              >
                <span className="wh-summary__value">{summaryValues[f.key]}</span>
                <span className="wh-summary__label">{f.label}</span>
              </Link>
            );
          })}
        </section>

        <div className="wh-row wh-row--work">
          <section className="wh-card wh-mywork" aria-label="My work">
            <div className="wh-card__head">
              <h2 className="wh-card__title">
                My Work
                <span className="wh-card__scope">{SUMMARY_FILTERS.find((f) => f.key === data.activeFilter)?.label}</span>
              </h2>
              <Link href="/app/admin/work" className="wh-card__link">View All My Work</Link>
            </div>
            {myWork.length === 0 ? (
              <div className="wh-emptyblock">
                <p className="wh-empty">{empty.line}</p>
                <p className="wh-empty__next">{empty.next}</p>
                {activeFilter === 'assigned' && data.canCreateWork ? (
                  <Link href="/app/admin/work/new" className="wh-btn wh-btn--primary wh-btn--sm">Create Work</Link>
                ) : null}
              </div>
            ) : (
              <ul className="wh-list">
                {myWork.map((w) => (
                  <li key={w.workInstanceId} className="wh-work">
                    <div className="wh-work__main">
                      <Link href={w.href} className="wh-work__title">{w.title}</Link>
                      <div className="wh-work__meta">
                        <span className={'wh-tag wh-tag--' + (w.status === 'ready' ? 'ready' : w.status === 'in_progress' ? 'progress' : w.status === 'completed' ? 'done' : 'pending')}>
                          {w.status === 'ready' ? 'Ready' : w.status === 'in_progress' ? 'In progress' : w.status === 'completed' ? 'Completed' : 'Blocked'}
                        </span>
                        <span className="wh-work__stage">{w.stageName}</span>
                        <span className="wh-work__dot" aria-hidden="true">·</span>
                        <span className="wh-work__assigned">{w.assignedLabel}</span>
                      </div>
                    </div>
                    <Link href={w.href} className="wh-btn wh-btn--ghost wh-btn--sm">{w.verb}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wh-card wh-notes" aria-label="Notifications">
            <div className="wh-card__head">
              <h2 className="wh-card__title">
                Notifications
                {notifications.unreadCount > 0 ? (
                  <span className="wh-count">{notifications.unreadCount}</span>
                ) : null}
              </h2>
            </div>
            {notifications.items.length === 0 ? (
              <div className="wh-emptyblock">
                <p className="wh-empty">You{'’'}re all caught up.</p>
                <p className="wh-empty__next">
                  Loop tells you here when a stage becomes yours or a colleague finishes theirs.
                </p>
              </div>
            ) : (
              <ul className="wh-list">
                {notifications.items.map((n) => (
                  <li key={n.id} className="wh-note">
                    <span className={'wh-note__icon wh-note__icon--' + n.kind}>
                      <SidebarIcon name={NOTE_ICON[n.kind] ?? 'activity'} size={14} />
                    </span>
                    <div className="wh-note__body">
                      {n.href ? (
                        <Link href={n.href} className="wh-note__title">{n.title}</Link>
                      ) : (
                        <span className="wh-note__title">{n.title}</span>
                      )}
                      <span className="wh-note__text">{n.body}</span>
                      <span className="wh-note__time">{relTime(n.createdAtIso)}</span>
                    </div>
                    <form action={markHomeNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button type="submit" className="wh-note__read" aria-label="Mark read">Mark read</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 4. BUSINESS SUMMARY — the fuller story, a doorway into CallGrid Intelligence */}
        <section className="wh-card" aria-label="Business summary">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              Business Summary
              {brain.sensors ? (
                <span className="wh-card__scope">{brain.sensors.instrumented} of {brain.sensors.total} sensors</span>
              ) : null}
            </h2>
            <Link href="/app/admin/marketplace" className="wh-card__link">Full intelligence</Link>
          </div>
          {brain.summary.length > 0 ? (
            <p className="wh-summline">
              {brain.summary.map((line, i) => (
                <span key={i} className="wh-summline__part">{line}</span>
              ))}
            </p>
          ) : (
            <div className="wh-emptyblock">
              <p className="wh-empty">
                {brain.present
                  ? 'No sensor has observed enough to summarize yet.'
                  : 'The Brain cannot summarize the business until a sensor is instrumented.'}
              </p>
              <p className="wh-empty__next">
                As CallGrid routes calls with vendor, source and campaign context, the Brain summarizes
                what happened, why it matters and what to do — every statement backed by evidence.
              </p>
            </div>
          )}
        </section>

        {/* 5. WHAT HAPPENED RECENTLY */}
        <section className="wh-card wh-activity" aria-label="Recent activity">
          <div className="wh-card__head">
            <h2 className="wh-card__title">
              What Happened Recently
              <span className="wh-card__scope">
                {completedTodayCount === 0
                  ? 'Nothing finished today'
                  : completedTodayCount + (completedTodayCount === 1 ? ' work item finished today' : ' work items finished today')}
              </span>
            </h2>
            {data.canViewAudit ? <Link href="/crm/audit" className="wh-card__link">View Audit Log</Link> : null}
          </div>
          {recentActivity.length === 0 ? (
            <div className="wh-emptyblock">
              <p className="wh-empty">Nothing has happened here yet.</p>
              <p className="wh-empty__next">
                Every recorded action — work created, customers added, people invited — appears
                here as your team starts operating.
              </p>
            </div>
          ) : (
            <ul className="wh-feed">
              {recentActivity.map((a) => (
                <li key={a.id} className="wh-feed__item">
                  <span className={'wh-feed__icon wh-feed__icon--' + a.category}>
                    <SidebarIcon name={ACTIVITY_ICON[a.category] ?? 'cog'} size={13} />
                  </span>
                  <span className="wh-feed__label">{a.label}</span>
                  <span className="wh-feed__actor">{a.actorName}</span>
                  <span className="wh-feed__time">{relTime(a.createdAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* GETTING STARTED — disappears entirely once complete */}
        {gettingStarted.show ? (
          <section className="wh-card wh-getstarted" aria-label="Getting started">
            <div className="wh-card__head">
              <h2 className="wh-card__title">Getting Started</h2>
            </div>
            <ul className="wh-check">
              {gettingStarted.items.map((c) => (
                <li key={c.key} className={'wh-check__row' + (c.done ? ' is-done' : '')}>
                  <span className="wh-check__mark" aria-hidden="true">{c.done ? '✓' : ''}</span>
                  <span className="wh-check__label">{c.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </div>
    </div>
  );
}
