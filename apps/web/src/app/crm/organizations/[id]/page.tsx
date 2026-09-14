import Link from 'next/link';
import { notFound } from 'next/navigation';
import { crmRepos, requireCrmContext } from '../../../../crm/crm-data';
import { requirePermission } from '../../../../auth/guard';
import {
  Timeline, TimelineItem, AuditEventRow, EmptyTimeline,
  fromInboxItem, fromAuditView,
} from '../../../../crm/timeline';

// Workspace Organization — Phase 1.
//
// The signed-in tenant organization and its IAM members. This is NOT the
// canonical commercial Company or Relationship surface (those arrive with the
// Opportunity and Relationship domains in Phase 2+). It shows what is real
// today: the workspace organization record, team membership, and people
// linked through customer intake.
//
// Tenant-local only — cross-org Party is deferred per Phase 0 decision.

export const dynamic = 'force-dynamic';

function initials(name: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    OWNER: 'Owner', ADMIN: 'Admin', MANAGER: 'Manager',
    EMPLOYEE: 'Employee', AI_EMPLOYEE: 'AI Employee', READ_ONLY: 'Read Only',
  };
  return map[role] ?? role;
}

const ORG_TABS = ['Overview', 'Activity'] as const;
type OrgTab = (typeof ORG_TABS)[number];

export default async function OrganizationDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const activeTab: OrgTab = (ORG_TABS as readonly string[]).includes(searchParams?.tab ?? '')
    ? (searchParams!.tab as OrgTab)
    : 'Overview';

  const ctx = await requireCrmContext('/crm/organizations');
  await requirePermission('organizations', 'view');

  if (params.id !== ctx.organizationId) {
    notFound();
  }

  const [org, members, customerResult, statusCounts, recentAudit, recentActivity] = await Promise.all([
    crmRepos.organizations.findById(params.id),
    crmRepos.iam.listUsers(params.id),
    crmRepos.crm.listCustomers(params.id, { pageSize: 10, sort: 'createdAt', direction: 'desc' }),
    crmRepos.crm.statusCounts(params.id),
    crmRepos.audit.list(params.id, { take: 10 }),
    crmRepos.crm.inboxFeed(params.id, 10),
  ]);

  if (!org) notFound();

  const activeMembers = members.filter((m) => m.status === 'ACTIVE');
  const totalCustomers = customerResult.total;

  return (
    <div className="crm-page">
      {/* Workspace Organization Header */}
      <div className="org-header">
        <div className="org-avatar" aria-hidden="true">
          {org.name.charAt(0).toUpperCase()}
        </div>
        <div className="org-meta">
          <h1>{org.name}</h1>
          <p className="org-sub">
            Workspace Organization &middot; {org.industry || 'Industry not set'} &middot; {org.timezone} &middot; {org.status}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="org-tabs" role="tablist">
        <Link
          className={'org-tab' + (activeTab === 'Overview' ? ' active' : '')}
          href={`/crm/organizations/${params.id}`}
          role="tab"
          aria-selected={activeTab === 'Overview'}
        >Overview</Link>
        <Link
          className={'org-tab' + (activeTab === 'Activity' ? ' active' : '')}
          href={`/crm/organizations/${params.id}?tab=Activity`}
          role="tab"
          aria-selected={activeTab === 'Activity'}
        >Activity</Link>
        <span className="org-tab" role="tab" aria-disabled="true" style={{ opacity: 0.5 }}>Relationships</span>
        <span className="org-tab" role="tab" aria-disabled="true" style={{ opacity: 0.5 }}>Opportunities</span>
        <span className="org-tab" role="tab" aria-disabled="true" style={{ opacity: 0.5 }}>Campaigns</span>
      </div>

      {activeTab === 'Activity' ? (
        <div className="org-grid">
          <div>
            <div className="ds-card" style={{ marginBottom: '1rem' }}>
              <div className="ds-card-head">
                <h3>Recent Activity</h3>
                <Link href="/crm/live/activity" className="more">Live feed →</Link>
              </div>
              <div className="ds-card-body">
                {recentActivity.length === 0 ? (
                  <EmptyTimeline message="No operational activity yet. Interactions will appear here as they occur." />
                ) : (
                  <Timeline>
                    {recentActivity.map((a) => (
                      <TimelineItem key={a.id} entry={fromInboxItem(a)} />
                    ))}
                  </Timeline>
                )}
              </div>
            </div>
          </div>
          <div>
            <div className="ds-card">
              <div className="ds-card-head">
                <h3>Audit Trail</h3>
                <Link href="/crm/audit" className="more">Full log →</Link>
              </div>
              <div className="ds-card-body">
                {recentAudit.length === 0 ? (
                  <EmptyTimeline message="No audit events yet. Material actions will be logged here." />
                ) : (
                  <Timeline>
                    {recentAudit.map((a) => (
                      <AuditEventRow key={a.id} entry={fromAuditView(a)} />
                    ))}
                  </Timeline>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main content grid — Overview tab */}
      {activeTab === 'Overview' ? (
      <div className="org-grid">

        {/* Left column: Organization details + Team */}
        <div>
          <div className="ds-card" style={{ marginBottom: '1rem' }}>
            <div className="ds-card-head"><h3>Workspace Details</h3></div>
            <div className="ds-card-body">
              <div className="org-field">
                <span className="f-label">Legal Name</span>
                <span className="f-value">{org.name}</span>
              </div>
              <div className="org-field">
                <span className="f-label">Slug</span>
                <span className="f-value">{org.slug}</span>
              </div>
              <div className="org-field">
                <span className="f-label">Industry</span>
                <span className="f-value">{org.industry || 'Not set'}</span>
              </div>
              <div className="org-field">
                <span className="f-label">Timezone</span>
                <span className="f-value">{org.timezone}</span>
              </div>
              <div className="org-field">
                <span className="f-label">Status</span>
                <span className="f-value">{org.status}</span>
              </div>
              <div className="org-field">
                <span className="f-label">Created</span>
                <span className="f-value">{fmtDate(org.createdAt?.toISOString?.() ?? org.createdAt as unknown as string)}</span>
              </div>
            </div>
          </div>

          {/* Team Members */}
          <div className="ds-card">
            <div className="ds-card-head">
              <h3>Team ({activeMembers.length})</h3>
              <Link href="/app/admin/administration/team" className="more">Manage →</Link>
            </div>
            <div className="ds-card-body">
              {activeMembers.length === 0 ? (
                <div className="ds-empty">
                  <div className="et">No team members</div>
                  <div>Invite team members to get started.</div>
                </div>
              ) : (
                activeMembers.slice(0, 10).map((m) => (
                  <div key={m.id} className="org-contact">
                    <div className="org-contact__avatar">{initials(m.name)}</div>
                    <div>
                      <div className="org-contact__name">{m.name || m.email}</div>
                      <div className="org-contact__role">{roleLabel(m.systemRole)} &middot; {m.email}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right column: People summary + Pipeline + Upcoming */}
        <div>
          {/* People linked to this org */}
          <div className="ds-card" style={{ marginBottom: '1rem' }}>
            <div className="ds-card-head">
              <h3>People ({totalCustomers})</h3>
              <Link href="/crm/customers" className="more">View all →</Link>
            </div>
            <div className="ds-card-body">
              {totalCustomers === 0 ? (
                <div className="ds-empty">
                  <div className="et">No people yet</div>
                  <div>People will appear as they enter through intake, calls, or manual entry.</div>
                </div>
              ) : (
                <>
                  {customerResult.rows.slice(0, 5).map((c) => (
                    <div key={c.id} className="org-contact">
                      <div className="org-contact__avatar">{initials(c.name)}</div>
                      <div>
                        <div className="org-contact__name">{c.name || 'Unnamed'}</div>
                        <div className="org-contact__role">
                          {c.company || 'No company'} &middot; {c.status}
                        </div>
                      </div>
                      <Link href={`/crm/customers/${c.id}`} className="org-contact__link">View →</Link>
                    </div>
                  ))}
                  {totalCustomers > 5 && (
                    <div style={{ paddingTop: '0.5rem', fontSize: '0.78rem', color: 'var(--crm-muted)' }}>
                      and {totalCustomers - 5} more
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Customer intake status — legacy Customer.status, not canonical Opportunity pipeline */}
          <div className="ds-card" style={{ marginBottom: '1rem' }}>
            <div className="ds-card-head">
              <h3>Intake Status</h3>
              <Link href="/crm/pipeline" className="more">Board →</Link>
            </div>
            <div className="ds-card-body">
              <div className="cc-pipeline">
                {(['New', 'Contacted', 'Quoted', 'Booked', 'Completed'] as const).map((s) => (
                  <div key={s} className="cc-pipeline__row">
                    <span className={'cc-pipeline__dot cc-pipeline__dot--' + s.toLowerCase()} />
                    <span className="cc-pipeline__label">{s}</span>
                    <span className="cc-pipeline__count">{(statusCounts[s] ?? 0).toLocaleString()}</span>
                  </div>
                ))}
                <p className="cc-helper">Current intake statuses. Canonical Opportunity pipeline arrives with the Opportunity domain.</p>
              </div>
            </div>
          </div>

          {/* Upcoming: Relationships, Opportunities, Campaigns */}
          <div className="ds-card">
            <div className="ds-card-head"><h3>Coming Next</h3></div>
            <div className="ds-card-body">
              <div className="cc-upcoming">
                <div className="cc-upcoming__item">
                  <div className="cc-upcoming__label">Commercial Companies &amp; Relationships</div>
                  <div className="cc-upcoming__desc">
                    Canonical Company records and commercial relationships (buyer, brand, agency, vendor, partner) — distinct from this workspace organization.
                    Arrives with the Relationship domain in Phase 2.
                  </div>
                </div>
                <div className="cc-upcoming__item">
                  <div className="cc-upcoming__label">Opportunities</div>
                  <div className="cc-upcoming__desc">
                    Canonical opportunity pipeline with stage transitions, value tracking, and forecasts.
                    Replaces the current intake statuses once the Opportunity domain is built.
                  </div>
                </div>
                <div className="cc-upcoming__item">
                  <div className="cc-upcoming__label">Campaigns</div>
                  <div className="cc-upcoming__desc">
                    Unified campaign management linking this organization to call, creator and property executions.
                    Requires the Campaign foundation (Phase 4).
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ) : null}
    </div>
  );
}
