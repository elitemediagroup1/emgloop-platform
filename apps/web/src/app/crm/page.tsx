import Link from 'next/link';
import { crmRepos, requireCrmContext } from '../../crm/crm-data';
import { hasPermission } from '../../auth/guard';
import { loadOrFallback } from '../../demo/db-health';
import { loadCommandCenter } from '../../crm/command-center-data';
import { CrmLoadError } from '../../crm/load-error';
import { canOpenHeadlines } from '../../crm/headlines-access';
import { loadAttention } from '../app/admin/headlines/headlines-data';
import { AttentionBanner } from '../app/admin/headlines/headline-ui';
import { ReadError } from '../app/_loop-os/product-state';
import {
  Timeline, TimelineItem, AuditEventRow, EmptyTimeline,
  fromInboxItem, fromAuditView,
} from '../../crm/timeline';
import { viewerTime } from '../../time/viewer-time';

// CRM Command Center — Phase 1 (Charlie/Lexi §10.1).
//
// The internal EMG operator's landing page. Every value is org-scoped and
// real — customer counts, intake status breakdown, conversation volume,
// recent activity. Where a capability is not yet built (Relationships,
// Campaigns), the card shows an honest empty state.
//
// NEEDS ATTENTION is Commercial Intelligence's, not the CRM's. It is read through
// CI's own loader and rendered with CI's own governed banner, and it appears only
// for people who can open the Headlines surface it links to.
//
// This page replaces the Sprint 24 redirect-to-/app. The CRM is now its own
// first-class experience within the shared WorkspaceShell.

export const dynamic = 'force-dynamic';


function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export default async function CrmCommandCenter() {
  const ctx = await requireCrmContext('/crm');
  const time = viewerTime();
  // Resolved before any read: without audit:view the audit query is not issued,
  // and without access to Headlines no CI read is issued either.
  const [canViewAudit, showHeadlines] = await Promise.all([
    hasPermission('audit', 'view'),
    canOpenHeadlines(ctx.session),
  ]);

  // Parallel data loads — all org-scoped, all real.
  const [result, attention] = await Promise.all([
    loadOrFallback(() => loadCommandCenter(crmRepos, ctx.organizationId, { canViewAudit }, { now: time.now, timeZone: time.timeZone })),
    showHeadlines ? loadAttention(ctx.organizationId) : Promise.resolve(null),
  ]);

  if (!result.ok) return <CrmLoadError failure={result} surface="The Command Center" />;

  const {
    org,
    customerCount,
    statusCounts,
    weekCounts,
    conversationCounts,
    recentActivity,
    recentAudit,
  } = result.data;

  const orgName = org?.name ?? 'Organization';
  // The reader's own clock, not the organization's or the server's (Loop Time Authority).
  const clock = { greeting: time.greeting(), date: time.format(time.now, 'weekdayDate') };

  // Intake status summary from Customer.status (not canonical Opportunity pipeline).
  const activeIntake = (statusCounts.New ?? 0) + (statusCounts.Contacted ?? 0) + (statusCounts.Quoted ?? 0);
  const booked = statusCounts.Booked ?? 0;
  const completed = statusCounts.Completed ?? 0;

  // Conversation summary
  const openConvos = conversationCounts.counts?.OPEN ?? 0;
  const pendingConvos = conversationCounts.counts?.PENDING ?? 0;
  const totalConvos = conversationCounts.total ?? 0;

  return (
    <div className="crm-page cc">
      {/* Header */}
      <div className="cc-header">
        <div className="cc-header__text">
          <p className="ds-eyebrow">Command Center</p>
          <h1 className="ds-title">{clock.greeting}, {ctx.session.name}</h1>
          <p className="ds-subtitle">{orgName} &middot; {clock.date}</p>
        </div>
        <form className="cc-search" method="get" action="/crm/search" role="search">
          <input type="search" name="q" className="crm-input cc-search__input" placeholder="Search intake records and conversations…" aria-label="Search the CRM" />
        </form>
      </div>

      {/* KPI Row — counts, not trends: only a positive weekly delta is coloured.
          "Added" is Intake Records created, not new leads: ingestion creates none,
          so callers and visitors are not counted here. Intake Records are not
          People (C-04). */}
      <div className="ds-kpis">
        <div className="ds-kpi">
          <div className="k-label">Total Intake Records</div>
          <div className="k-value">{fmtNum(customerCount)}</div>
          <div className={'k-trend' + (weekCounts.newCustomers > 0 ? '' : ' neutral')}>{weekCounts.newCustomers > 0 ? `+${weekCounts.newCustomers} added this week` : 'None added this week'}</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">Active Intake</div>
          <div className="k-value">{fmtNum(activeIntake)}</div>
          <div className="k-trend neutral">{fmtNum(booked)} booked &middot; {fmtNum(completed)} completed</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">Open Conversations</div>
          <div className="k-value">{fmtNum(openConvos + pendingConvos)}</div>
          <div className="k-trend neutral">{fmtNum(totalConvos)} total</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">Intake Records Added This Week</div>
          <div className="k-value">{fmtNum(weekCounts.newCustomers)}</div>
          <div className="k-trend neutral">{fmtNum(weekCounts.conversations)} conversations</div>
        </div>
      </div>

      {/* Needs Attention — Commercial Intelligence's governed Headlines, linked, never copied */}
      {attention ? (
        <section className="ds-card cc-attention" aria-labelledby="cc-attention">
          <div className="ds-card-head">
            <h2 id="cc-attention">Needs Attention</h2>
            <span className="cc-attention__owner">Commercial Intelligence</span>
            <Link href="/app/admin/headlines" className="more">All headlines <span aria-hidden="true">→</span></Link>
          </div>
          <div className="ds-card-body">
            {!attention.ok ? (
              <ReadError what={attention.what} retryHref="/crm" />
            ) : (
              <>
                <AttentionBanner attention={attention.value.attention} />
                {attention.value.headlines.length > 0 ? (
                  <ul className="cc-attention__list" role="list">
                    {attention.value.headlines.slice(0, 3).map((h) => (
                      <li key={h.id}>
                        <Link href={`/app/admin/headlines/${encodeURIComponent(h.id)}`} className="cc-attention__item">
                          <span className="cc-attention__statement">{h.statement}</span>
                          {h.objectiveTitle ? <span className="cc-attention__objective">{h.objectiveTitle}</span> : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}

      {/* Main Grid */}
      <div className="ds-grid cols-3">

        {/* Customer Intake Status — legacy Customer.status, not canonical Opportunity pipeline */}
        <section className="ds-card" aria-labelledby="cc-intake">
          <div className="ds-card-head">
            <h2 id="cc-intake">Customer Intake</h2>
            <Link href="/crm/pipeline" className="more">Intake board <span aria-hidden="true">→</span></Link>
          </div>
          <div className="ds-card-body">
            {customerCount === 0 ? (
              <EmptyCard icon="columns" title="No intake data" line="No intake records yet." />
            ) : (
              <div className="cc-pipeline">
                {(['New', 'Contacted', 'Quoted', 'Booked', 'Completed'] as const).map((s) => (
                  <div key={s} className="cc-pipeline__row">
                    <span className={'cc-pipeline__dot cc-pipeline__dot--' + s.toLowerCase()} aria-hidden="true" />
                    <span className="cc-pipeline__label">{s}</span>
                    <span className="cc-pipeline__count">{fmtNum(statusCounts[s] ?? 0)}</span>
                  </div>
                ))}
                <p className="cc-helper">Current intake statuses. Canonical Opportunity pipeline arrives with the Opportunity domain.</p>
              </div>
            )}
          </div>
        </section>

        {/* Recent Activity */}
        <section className="ds-card" aria-labelledby="cc-activity">
          <div className="ds-card-head">
            <h2 id="cc-activity">Recent Activity</h2>
            <Link href="/crm/live/activity" className="more">Live feed <span aria-hidden="true">→</span></Link>
          </div>
          <div className="ds-card-body">
            {recentActivity.length === 0 ? (
              <EmptyTimeline message="Interactions will appear here as they occur." />
            ) : (
              <Timeline>
                {recentActivity.slice(0, 6).map((a) => (
                  <TimelineItem key={a.id} entry={fromInboxItem(a)} />
                ))}
              </Timeline>
            )}
          </div>
        </section>

        {/* Quick Actions */}
        <section className="ds-card" aria-labelledby="cc-quick">
          <div className="ds-card-head">
            <h2 id="cc-quick">Quick Actions</h2>
          </div>
          <div className="ds-card-body cc-actions">
            <Link href="/crm/customers" className="cc-action">
              <span className="cc-action__ico" aria-hidden="true">👤</span>
              <span>View Intake Records</span>
            </Link>
            <Link href="/crm/pipeline" className="cc-action">
              <span className="cc-action__ico" aria-hidden="true">📋</span>
              <span>Intake Board</span>
            </Link>
            <Link href="/crm/conversations" className="cc-action">
              <span className="cc-action__ico" aria-hidden="true">💬</span>
              <span>Conversations</span>
            </Link>
            <Link href="/crm/search" className="cc-action">
              <span className="cc-action__ico" aria-hidden="true">🔍</span>
              <span>Search</span>
            </Link>
          </div>
        </section>
      </div>

      {/* Second Row */}
      <div className={'ds-grid cc-row' + (recentAudit ? ' cols-2' : '')}>

        {/* Audit Trail — only for audit:view; recentAudit is null otherwise */}
        {recentAudit ? (
          <section className="ds-card" aria-labelledby="cc-audit">
            <div className="ds-card-head">
              <h2 id="cc-audit">Recent Audit Events</h2>
              <Link href="/crm/audit" className="more">Full log <span aria-hidden="true">→</span></Link>
            </div>
            <div className="ds-card-body">
              {recentAudit.length === 0 ? (
                <EmptyTimeline message="Material actions will be logged here." />
              ) : (
                <Timeline>
                  {recentAudit.slice(0, 5).map((a) => (
                    <AuditEventRow key={a.id} entry={fromAuditView(a)} />
                  ))}
                </Timeline>
              )}
            </div>
          </section>
        ) : null}

        {/* Not-yet-built areas — honest scaffolds */}
        <section className="ds-card" aria-labelledby="cc-upcoming">
          <div className="ds-card-head">
            <h2 id="cc-upcoming">Coming in Phase 2</h2>
          </div>
          <div className="ds-card-body">
            <div className="cc-upcoming">
              <UpcomingItem label="Relationships" desc="First-class commercial relationships between organizations and people." />
              <UpcomingItem label="Campaigns" desc="Unified campaign management across call, creator, and owned property channels." />
              <UpcomingItem label="Commercial Intelligence" desc="Evidence-led investigations with governed findings and recommendations." />
              <UpcomingItem label="Opportunities" desc="Canonical opportunity pipeline with stage transitions, value tracking, and forecasts." />
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}

function EmptyCard({ icon, title, line }: { icon: string; title: string; line: string }) {
  return (
    <div className="ds-empty">
      <div className="glyph" aria-hidden="true">{icon === 'columns' ? '▦' : icon === 'activity' ? '⚡' : '○'}</div>
      <div className="et">{title}</div>
      <div>{line}</div>
    </div>
  );
}

function UpcomingItem({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="cc-upcoming__item">
      <div className="cc-upcoming__label">{label}</div>
      <div className="cc-upcoming__desc">{desc}</div>
    </div>
  );
}
