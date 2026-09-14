import Link from 'next/link';
import { crmRepos, requireCrmContext } from '../../crm/crm-data';
import { requirePermission } from '../../auth/guard';
import {
  Timeline, TimelineItem, AuditEventRow, EmptyTimeline,
  fromInboxItem, fromAuditView,
} from '../../crm/timeline';

// CRM Command Center — Phase 1 (Charlie/Lexi §10.1).
//
// The internal EMG operator's landing page. Every value is org-scoped and
// real — customer counts, intake status breakdown, conversation volume,
// recent activity. Where a capability is not yet built (Relationships,
// Campaigns, Commercial Intelligence), the card shows an honest empty state.
//
// This page replaces the Sprint 24 redirect-to-/app. The CRM is now its own
// first-class experience within the shared WorkspaceShell.

export const dynamic = 'force-dynamic';


function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

// Timestamp for "today" and "this week" windows.
function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekStart(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default async function CrmCommandCenter() {
  const ctx = await requireCrmContext('/crm');
  const orgId = ctx.organizationId;

  // Parallel data loads — all org-scoped, all real.
  const [
    org,
    customerCount,
    statusCounts,
    weekCounts,
    conversationCounts,
    recentActivity,
    recentAudit,
  ] = await Promise.all([
    crmRepos.organizations.findById(orgId),
    crmRepos.customers.countByOrganization(orgId),
    crmRepos.crm.statusCounts(orgId),
    crmRepos.crm.windowCounts(orgId, weekStart(), new Date()),
    crmRepos.conversationsInbox.listConversations(orgId, {}),
    crmRepos.crm.inboxFeed(orgId, 8),
    crmRepos.audit.list(orgId, { take: 10 }),
  ]);

  const orgName = org?.name ?? 'Organization';
  const greeting = getGreeting();

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
        <div>
          <p className="ds-eyebrow">Command Center</p>
          <h1 className="ds-title">{greeting}, {ctx.session.name}</h1>
          <p className="ds-subtitle">{orgName} &middot; {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
        </div>
        <div className="cc-search" role="search">
          <input type="search" className="crm-input cc-search__input" placeholder="Search — coming in next Phase 1 slice" aria-label="Search" disabled />
        </div>
      </div>

      {/* KPI Row */}
      <div className="ds-kpis">
        <div className="ds-kpi">
          <div className="k-label">Total People</div>
          <div className="k-value">{fmtNum(customerCount)}</div>
          <div className="k-trend">{weekCounts.newCustomers > 0 ? `+${weekCounts.newCustomers} this week` : 'No new this week'}</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">Intake Status</div>
          <div className="k-value">{fmtNum(activeIntake)}</div>
          <div className="k-trend">{fmtNum(booked)} booked &middot; {fmtNum(completed)} completed</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">Open Conversations</div>
          <div className="k-value">{fmtNum(openConvos + pendingConvos)}</div>
          <div className="k-trend">{fmtNum(totalConvos)} total</div>
        </div>
        <div className="ds-kpi">
          <div className="k-label">New This Week</div>
          <div className="k-value">{fmtNum(weekCounts.newCustomers)}</div>
          <div className="k-trend">{weekCounts.conversations} conversations</div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="ds-grid cols-3">

        {/* Customer Intake Status — legacy Customer.status, not canonical Opportunity pipeline */}
        <div className="ds-card">
          <div className="ds-card-head">
            <h3>Customer Intake</h3>
            <Link href="/crm/pipeline" className="more">View all →</Link>
          </div>
          <div className="ds-card-body">
            {customerCount === 0 ? (
              <EmptyCard icon="columns" title="No intake data" line="People will appear here as they enter through intake, calls, or manual entry." />
            ) : (
              <div className="cc-pipeline">
                {(['New', 'Contacted', 'Quoted', 'Booked', 'Completed'] as const).map((s) => (
                  <div key={s} className="cc-pipeline__row">
                    <span className={'cc-pipeline__dot cc-pipeline__dot--' + s.toLowerCase()} />
                    <span className="cc-pipeline__label">{s}</span>
                    <span className="cc-pipeline__count">{fmtNum(statusCounts[s] ?? 0)}</span>
                  </div>
                ))}
                <p className="cc-helper">Current intake statuses. Canonical Opportunity pipeline arrives with the Opportunity domain.</p>
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="ds-card">
          <div className="ds-card-head">
            <h3>Recent Activity</h3>
            <Link href="/crm/live/activity" className="more">Live feed →</Link>
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
        </div>

        {/* Quick Actions */}
        <div className="ds-card">
          <div className="ds-card-head">
            <h3>Quick Actions</h3>
          </div>
          <div className="ds-card-body cc-actions">
            <Link href="/crm/customers" className="cc-action">
              <span className="cc-action__ico">👤</span>
              <span>View People</span>
            </Link>
            <Link href="/crm/pipeline" className="cc-action">
              <span className="cc-action__ico">📋</span>
              <span>Intake Board</span>
            </Link>
            <Link href="/crm/conversations" className="cc-action">
              <span className="cc-action__ico">💬</span>
              <span>Conversations</span>
            </Link>
            <span className="cc-action" style={{ opacity: 0.5, pointerEvents: 'none' }}>
              <span className="cc-action__ico">🔍</span>
              <span>Search (coming soon)</span>
            </span>
          </div>
        </div>
      </div>

      {/* Second Row */}
      <div className="ds-grid cols-2" style={{ marginTop: '1rem' }}>

        {/* Audit Trail */}
        <div className="ds-card">
          <div className="ds-card-head">
            <h3>Recent Audit Events</h3>
            <Link href="/crm/audit" className="more">Full log →</Link>
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
        </div>

        {/* Not-yet-built areas — honest scaffolds */}
        <div className="ds-card">
          <div className="ds-card-head">
            <h3>Coming in Phase 2</h3>
          </div>
          <div className="ds-card-body">
            <div className="cc-upcoming">
              <UpcomingItem label="Relationships" desc="First-class commercial relationships between organizations and people." />
              <UpcomingItem label="Campaigns" desc="Unified campaign management across call, creator, and owned property channels." />
              <UpcomingItem label="Commercial Intelligence" desc="Evidence-led investigations with governed findings and recommendations." />
              <UpcomingItem label="Opportunities" desc="Canonical opportunity pipeline with stage transitions, value tracking, and forecasts." />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
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
