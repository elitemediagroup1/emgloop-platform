import Link from 'next/link';
import { notFound } from 'next/navigation';
import { crmRepos, requireCrmContext } from '../../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../../auth/guard';
import { loadOrFallback } from '../../../../demo/db-health';
import { CrmLoadError } from '../../../../crm/load-error';
import { SectionTabs } from '../../../../crm/section-tabs';
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

  // Tenant-local: the only organization a session may see is its own. Any other
  // id — real or not — is not-found, before a single row is read.
  if (params.id !== ctx.organizationId) {
    notFound();
  }

  // organizations:view does not imply audit:view (a Permission row can deny it).
  const canViewAudit = await hasPermission('audit', 'view');

  const result = await loadOrFallback(() => Promise.all([
    crmRepos.organizations.findById(params.id),
    crmRepos.iam.listUsers(params.id),
    crmRepos.crm.listCustomers(params.id, { pageSize: 10, sort: 'createdAt', direction: 'desc' }),
    crmRepos.crm.statusCounts(params.id),
    canViewAudit ? crmRepos.audit.list(params.id, { take: 10 }) : Promise.resolve(null),
    crmRepos.crm.inboxFeed(params.id, 10),
  ]));

  if (!result.ok) return <CrmLoadError failure={result} surface="This workspace organization" />;

  const [org, members, customerResult, statusCounts, recentAudit, recentActivity] = result.data;

  if (!org) notFound();

  const activeMembers = members.filter((m) => m.status === 'ACTIVE');
  const totalCustomers = customerResult.total;
  const base = `/crm/organizations/${params.id}`;

  return (
    <div className="crm-page">
      {/* Workspace Organization Header */}
      <div className="org-header">
        <div className="org-avatar" aria-hidden="true">
          {org.name.charAt(0).toUpperCase()}
        </div>
        <div className="org-meta">
          <p className="ds-eyebrow">Workspace Organization</p>
          <h1>{org.name}</h1>
          <p className="org-sub">
            {org.industry || 'Industry not set'} &middot; {org.timezone} &middot; {org.status}
          </p>
        </div>
      </div>

      <SectionTabs
        label="Organization sections"
        tabs={[
          { label: 'Overview', href: base, active: activeTab === 'Overview' },
          { label: 'Activity', href: `${base}?tab=Activity`, active: activeTab === 'Activity' },
          { label: 'Relationships', href: base, soon: true },
          { label: 'Opportunities', href: base, soon: true },
          { label: 'Campaigns', href: base, soon: true },
        ]}
      />

      {activeTab === 'Activity' ? (
        <div className="org-grid">
          <section className="ds-card" aria-labelledby="org-activity">
            <div className="ds-card-head">
              <h2 id="org-activity">Recent Activity</h2>
              <Link href="/crm/live/activity" className="more">Live feed <span aria-hidden="true">→</span></Link>
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
          </section>
          {recentAudit ? (
            <section className="ds-card" aria-labelledby="org-audit">
              <div className="ds-card-head">
                <h2 id="org-audit">Audit Trail</h2>
                <Link href="/crm/audit" className="more">Full log <span aria-hidden="true">→</span></Link>
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
            </section>
          ) : null}
        </div>
      ) : null}

      {/* Main content grid — Overview tab */}
      {activeTab === 'Overview' ? (
      <div className="org-grid">

        {/* Left column: Organization details + Team */}
        <div className="org-col">
          <section className="ds-card" aria-labelledby="org-details">
            <div className="ds-card-head"><h2 id="org-details">Workspace Details</h2></div>
            <div className="ds-card-body">
              <dl className="org-fields">
                <div className="org-field">
                  <dt className="f-label">Legal Name</dt>
                  <dd className="f-value">{org.name}</dd>
                </div>
                <div className="org-field">
                  <dt className="f-label">Slug</dt>
                  <dd className="f-value">{org.slug}</dd>
                </div>
                <div className="org-field">
                  <dt className="f-label">Industry</dt>
                  <dd className="f-value">{org.industry || 'Not set'}</dd>
                </div>
                <div className="org-field">
                  <dt className="f-label">Timezone</dt>
                  <dd className="f-value">{org.timezone}</dd>
                </div>
                <div className="org-field">
                  <dt className="f-label">Status</dt>
                  <dd className="f-value">{org.status}</dd>
                </div>
                <div className="org-field">
                  <dt className="f-label">Created</dt>
                  <dd className="f-value">{fmtDate(org.createdAt?.toISOString?.() ?? org.createdAt as unknown as string)}</dd>
                </div>
              </dl>
            </div>
          </section>

          {/* Team Members */}
          <section className="ds-card" aria-labelledby="org-team">
            <div className="ds-card-head">
              <h2 id="org-team">Team ({activeMembers.length})</h2>
              <Link href="/app/admin/administration/team" className="more">Manage <span aria-hidden="true">→</span></Link>
            </div>
            <div className="ds-card-body">
              {activeMembers.length === 0 ? (
                <div className="ds-empty">
                  <div className="et">No team members</div>
                  <div>Invite team members to get started.</div>
                </div>
              ) : (
                <ul className="org-list" role="list">
                  {activeMembers.slice(0, 10).map((m) => (
                    <li key={m.id} className="org-contact">
                      <div className="org-contact__avatar" aria-hidden="true">{initials(m.name)}</div>
                      <div className="org-contact__text">
                        <div className="org-contact__name">{m.name || m.email}</div>
                        <div className="org-contact__role">{roleLabel(m.systemRole)} &middot; {m.email}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* Right column: People summary + Intake status + Upcoming */}
        <div className="org-col">
          {/* People linked to this org */}
          <section className="ds-card" aria-labelledby="org-people">
            <div className="ds-card-head">
              <h2 id="org-people">People ({totalCustomers})</h2>
              <Link href="/crm/customers" className="more">View all <span aria-hidden="true">→</span></Link>
            </div>
            <div className="ds-card-body">
              {totalCustomers === 0 ? (
                <div className="ds-empty">
                  <div className="et">No people yet</div>
                  <div>People will appear as they enter through intake, calls, or manual entry.</div>
                </div>
              ) : (
                <>
                  <ul className="org-list" role="list">
                    {customerResult.rows.slice(0, 5).map((c) => (
                      <li key={c.id} className="org-contact">
                        <div className="org-contact__avatar" aria-hidden="true">{initials(c.name)}</div>
                        <div className="org-contact__text">
                          <div className="org-contact__name">{c.name || 'Unnamed'}</div>
                          <div className="org-contact__role">
                            {c.company || 'No company'} &middot; {c.status}
                          </div>
                        </div>
                        <Link
                          href={`/crm/customers/${c.id}`}
                          className="org-contact__link"
                          aria-label={`View ${c.name || 'unnamed person'}`}
                        >View <span aria-hidden="true">→</span></Link>
                      </li>
                    ))}
                  </ul>
                  {totalCustomers > 5 && (
                    <p className="org-more">and {totalCustomers - 5} more</p>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Customer intake status — legacy Customer.status, not canonical Opportunity pipeline */}
          <section className="ds-card" aria-labelledby="org-intake">
            <div className="ds-card-head">
              <h2 id="org-intake">Intake Status</h2>
              <Link href="/crm/pipeline" className="more">Intake board <span aria-hidden="true">→</span></Link>
            </div>
            <div className="ds-card-body">
              <div className="cc-pipeline">
                {(['New', 'Contacted', 'Quoted', 'Booked', 'Completed'] as const).map((s) => (
                  <div key={s} className="cc-pipeline__row">
                    <span className={'cc-pipeline__dot cc-pipeline__dot--' + s.toLowerCase()} aria-hidden="true" />
                    <span className="cc-pipeline__label">{s}</span>
                    <span className="cc-pipeline__count">{(statusCounts[s] ?? 0).toLocaleString()}</span>
                  </div>
                ))}
                <p className="cc-helper">Current intake statuses. Canonical Opportunity pipeline arrives with the Opportunity domain.</p>
              </div>
            </div>
          </section>

          {/* Upcoming: Relationships, Opportunities, Campaigns */}
          <section className="ds-card" aria-labelledby="org-next">
            <div className="ds-card-head"><h2 id="org-next">Coming Next</h2></div>
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
          </section>
        </div>
      </div>
      ) : null}
    </div>
  );
}
