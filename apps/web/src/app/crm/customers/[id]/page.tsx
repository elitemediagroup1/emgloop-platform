import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOrFallback } from '../../../../demo/db-health';
import { CrmLoadError } from '../../../../crm/load-error';
import { SectionTabs } from '../../../../crm/section-tabs';
import { crmRepos, requireCrmContext } from '../../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../../auth/guard';
import {
  PIPELINE_STATUSES,
  type AssigneeOptions,
  interactionActorType,
  interactionActorName,
} from '@emgloop/database';
import {
  addNoteAction,
  setStatusAction,
  addTagAction,
  removeTagAction,
  setAssignmentAction,
  updateCustomerFieldsAction,
} from '../../../../crm/actions';
import {
  Timeline, TimelineItem, EmptyTimeline, fromInteraction, fromDerivedSignal,
} from '../../../../crm/timeline';
import { viewerTime } from '../../../../time/viewer-time';

// Customer workspace — Sprint 5 (Phase 1) + Sprint 6 (Phase 2)
// + Sprint 14 (Website Intelligence — Website tab)
// + Sprint 15 (Customer Revenue Timeline — Revenue tab).
//
// A dedicated operating surface for one customer, read entirely from Neon via
// the repository layer. Tabs are server-rendered via ?tab= so no client JS is
// needed. Sprint 15 adds a Revenue tab that surfaces this customer's revenue
// journey (Website Visit -> Search -> CTA -> Call -> Booking -> Revenue -> LTV)
// via RevenueIntelligenceRepository.customerRevenueTimeline — deterministic,
// evidence-backed, real Neon data only.

export const dynamic = 'force-dynamic';

const TABS = [
  'Overview',
  'Timeline',
  'Website',
  'Notes',
  'Messages',
  'Bookings',
  'Revenue',
  'Signals',
  'AI Activity',
  'Edit',
] as const;
type Tab = (typeof TABS)[number];

const SUGGESTED_TAGS = [
  'VIP',
  'Hot Lead',
  'Booked',
  'Customer',
  'Commercial',
  'Residential',
];

// Every date on the record, in the reader's timezone (Loop Time Authority).
function fmt(d: Date | string | null | undefined): string {
  return viewerTime().dateTime(d) || '—';
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function jsonVal<T = unknown>(bag: unknown, key: string): T | undefined {
  if (bag && typeof bag === 'object' && key in (bag as object)) {
    return (bag as Record<string, T>)[key];
  }
  return undefined;
}

const KIND_COLOR: Record<string, string> = {
  FORM_SUBMISSION: 'var(--crm-blue)',
  SMS: 'var(--crm-purple)',
  EMAIL: 'var(--crm-purple)',
  PHONE_CALL: 'var(--crm-amber)',
  APPOINTMENT: 'var(--crm-accent)',
  CHAT: 'var(--crm-blue)',
  NOTE: 'var(--crm-faint)',
  OTHER: 'var(--crm-faint)',
};

const REVENUE_KIND_COLOR: Record<string, string> = {
  website: 'var(--crm-blue, #3b82f6)',
  call: 'var(--crm-amber, #f59e0b)',
  signal: 'var(--crm-purple, #8b5cf6)',
  booking: 'var(--crm-accent, #14b8a6)',
  order: 'var(--crm-accent, #14b8a6)',
};

function actorLabel(a: string | undefined): string {
  switch (a) {
    case 'ai_employee':
    case 'AI_AGENT':
      return 'AI';
    case 'customer':
    case 'CUSTOMER':
      return 'Customer';
    case 'human_agent':
    case 'HUMAN_AGENT':
      return 'Human';
    default:
      return 'System';
  }
}

// Sprint 14 — is this interaction a website event? (provider 'website' or a
// web.* eventType captured on the interaction metadata).
function webEventType(i: { metadata?: unknown }): string {
  return jsonVal<string>(i.metadata, 'eventType') ?? '';
}
function isWebInteraction(i: { provider?: string | null; metadata?: unknown }): boolean {
  if (i.provider === 'website') return true;
  return webEventType(i).startsWith('web.');
}

export default async function CustomerWorkspace({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const requestedTab = searchParams?.tab ?? '';

  // AUTHORIZATION BEFORE THE READ. The resource has existed in the matrix
  // since Sprint 7; this page simply never consulted it, so every signed-in
  // member of the organization saw the whole customer book.
  await requirePermission('customers', 'view');
  const { organizationId, session } = await requireCrmContext();

  // Each control is offered only to someone whose permission its action checks
  // (status: pipeline:update; everything else: customers:update). The actions
  // still enforce this themselves -- hiding is not the authorization.
  const [canUpdateCustomer, canMoveIntake, canViewAudit] = await Promise.all([
    hasPermission('customers', 'update'),
    hasPermission('pipeline', 'update'),
    hasPermission('audit', 'view'),
  ]);
  const visibleTabs = TABS.filter((t) => t !== 'Edit' || canUpdateCustomer);
  const activeTab: Tab = (visibleTabs as readonly string[]).includes(requestedTab)
    ? (requestedTab as Tab)
    : 'Overview';

  const result = await loadOrFallback(async () => {
    const ws = await crmRepos.crm.getWorkspace(organizationId, params.id);
    // Fail closed: a customer from another organization is treated as not found.
    if (ws && ws.customer.organizationId !== organizationId) {
      return { ws: null, assignees: { humans: [], ais: [] } as AssigneeOptions, timeline: null };
    }
    if (!ws) return { ws: null, assignees: { humans: [], ais: [] } as AssigneeOptions, timeline: null };
    const assignees = organizationId
      ? await crmRepos.crm.listAssignees(organizationId)
      : ({ humans: [], ais: [] } as AssigneeOptions);
    const timeline = organizationId
      ? await crmRepos.revenueIntelligence.customerRevenueTimeline(organizationId, params.id)
      : null;
    const org = await crmRepos.organizations.findById(organizationId);
    return { ws, assignees, timeline, workspaceName: org?.name ?? null };
  });

  if (!result.ok) return <CrmLoadError failure={result} surface="This intake record" />;
  if (!result.data.ws) return notFound();

  const ws = result.data.ws;
  const assignees = result.data.assignees;
  const timeline = result.data.timeline;
  const workspaceName = 'workspaceName' in result.data ? result.data.workspaceName : null;
  const cid = ws.customer.id;

  const notes = ws.interactions.filter((i) => i.kind === 'NOTE');
  const messages = ws.conversations.flatMap((c) => c.messages);
  const webEvents = ws.interactions.filter((i) => isWebInteraction(i));
  const aiActivity = ws.interactions.filter(
    // Only what an AI actor did. An appointment is not AI activity by kind: a
    // customer's own website request or a person's booking is not an AI's.
    (i) => actorLabel(interactionActorType(i.payload)) === 'AI',
  );

  const tabHref = (t: Tab) =>
    '/crm/customers/' + cid + (t === 'Overview' ? '' : '?tab=' + encodeURIComponent(t));

  const humanNames = Array.from(
    new Set(
      [ws.assignedHumanName, ...assignees.humans.map((h) => h.name)].filter(
        Boolean,
      ),
    ),
  );
  const aiNames = Array.from(
    new Set(
      [ws.assignedAIName, ...assignees.ais.map((a) => a.name)].filter(Boolean),
    ),
  );

  return (
    <>
      <div className="crm-record-back">
        <Link href="/crm/customers" className="crm-faint">
          <span aria-hidden="true">←</span> Intake Records
        </Link>
      </div>
      <p className="ds-eyebrow crm-record-type">Intake Record</p>
      <div className="crm-record-head">
        <h1 className="crm-h1">{ws.name}</h1>
        <span className={'crm-status ' + ws.status}>
          <span className="crm-sr-only">Intake status: </span>{ws.status}
        </span>
        {ws.customer.tags.map((t) => (
          <span className="crm-tag" key={t}>
            {t}
          </span>
        ))}
      </div>
      <p className="crm-sub">
        {[ws.company, [ws.city, ws.state].filter(Boolean).join(', ')]
          .filter(Boolean)
          .join(' · ') || 'No company / location on file'}
      </p>
      <p className="crm-record-context">
        Legacy customer intake record{workspaceName ? <> in the <strong>{workspaceName}</strong> workspace</> : null}.
        Its status is intake status, not an Opportunity stage.{' '}
        <Link href={`/crm/customers/${cid}/activity`} className="crm-record-context__link">
          {canViewAudit ? 'Activity & audit' : 'Activity'} <span aria-hidden="true">→</span>
        </Link>
      </p>

      <div className="crm-ws">
        {/* Left rail */}
        <div>
          <div className="crm-card">
            <h2>Intake record details</h2>
            <div className="crm-kv"><span className="k">Email</span><span className="v">{ws.customer.email || '—'}</span></div>
            <div className="crm-kv"><span className="k">Phone</span><span className="v">{ws.customer.phone || '—'}</span></div>
            <div className="crm-kv"><span className="k">Company</span><span className="v">{ws.company || '—'}</span></div>
            <div className="crm-kv"><span className="k">City</span><span className="v">{ws.city || '—'}</span></div>
            <div className="crm-kv"><span className="k">State</span><span className="v">{ws.state || '—'}</span></div>
            <div className="crm-kv"><span className="k">Service</span><span className="v">{ws.serviceType || '—'}</span></div>
            <div className="crm-kv"><span className="k">Source</span><span className="v">{ws.source || '—'}</span></div>
            <div className="crm-kv"><span className="k">External ID</span><span className="v">{ws.customer.externalId || '—'}</span></div>
            <div className="crm-kv"><span className="k">Created</span><span className="v">{fmt(ws.customer.createdAt)}</span></div>
            {canUpdateCustomer ? (
              <Link className="crm-btn crm-btn-ghost" href={tabHref('Edit')} style={{ marginTop: '0.6rem', display: 'inline-block' }}>
                Edit details
              </Link>
            ) : null}
          </div>

          <div className="crm-card">
            <h2>Intake status</h2>
            {canMoveIntake ? (
              <form action={setStatusAction} className="crm-form-row">
                <input type="hidden" name="customerId" value={cid} />
                <select className="crm-select" name="status" defaultValue={ws.status} style={{ flex: 1 }} aria-label="Intake status">
                  {PIPELINE_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button className="crm-btn" type="submit">Set</button>
              </form>
            ) : (
              <div className="crm-kv"><span className="k">Current</span><span className="v">{ws.status}</span></div>
            )}
          </div>

          <div className="crm-card">
            <h2>Assignments</h2>
            {canUpdateCustomer ? (
            <>
            <label className="crm-field-label" htmlFor="assign-human">Human employee</label>
            <form action={setAssignmentAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <select id="assign-human" className="crm-select" name="humanName" defaultValue={ws.assignedHumanName} style={{ flex: 1 }}>
                <option value="">— Unassigned —</option>
                {humanNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button className="crm-btn" type="submit">Save</button>
            </form>
            <label className="crm-field-label" htmlFor="assign-ai" style={{ marginTop: '0.5rem' }}>AI employee</label>
            <form action={setAssignmentAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <select id="assign-ai" className="crm-select" name="aiName" defaultValue={ws.assignedAIName} style={{ flex: 1 }}>
                <option value="">— Unassigned —</option>
                {aiNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button className="crm-btn" type="submit">Save</button>
            </form>
            {assignees.humans.length === 0 && assignees.ais.length === 0 ? (
              <p className="crm-faint" style={{ fontSize: '0.72rem', marginTop: '0.4rem' }}>
                No employees provisioned for this org yet.
              </p>
            ) : null}
            </>
            ) : (
              <>
                <div className="crm-kv"><span className="k">Human employee</span><span className="v">{ws.assignedHumanName || 'Unassigned'}</span></div>
                <div className="crm-kv"><span className="k">AI employee</span><span className="v">{ws.assignedAIName || 'Unassigned'}</span></div>
              </>
            )}
          </div>

          <div className="crm-card">
            <h2>Tags</h2>
            <div className="crm-chips" style={{ marginBottom: '0.5rem' }}>
              {ws.customer.tags.length === 0 ? (
                <span className="crm-faint" style={{ fontSize: '0.8rem' }}>No tags</span>
              ) : canUpdateCustomer ? (
                ws.customer.tags.map((t) => (
                  <form action={removeTagAction} key={t} style={{ display: 'inline' }}>
                    <input type="hidden" name="customerId" value={cid} />
                    <input type="hidden" name="tag" value={t} />
                    <button className="crm-chip active" type="submit" style={{ cursor: 'pointer' }} aria-label={`Remove tag ${t}`}>
                      {t} <span aria-hidden="true">✕</span>
                    </button>
                  </form>
                ))
              ) : (
                ws.customer.tags.map((t) => <span className="crm-tag" key={t}>{t}</span>)
              )}
            </div>
            {canUpdateCustomer ? (
              <form action={addTagAction} className="crm-form-row">
                <input type="hidden" name="customerId" value={cid} />
                <input className="crm-input" name="tag" list="crm-tag-suggestions" placeholder="Add tag…" aria-label="Add tag" style={{ flex: 1 }} />
                <datalist id="crm-tag-suggestions">
                  {SUGGESTED_TAGS.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <button className="crm-btn" type="submit">Add</button>
              </form>
            ) : null}
          </div>
        </div>

        {/* Right: tabbed workspace */}
        <div>
          <SectionTabs
            label="Record sections"
            tabs={visibleTabs.map((t) => ({ label: t, href: tabHref(t), active: t === activeTab }))}
          />

          {activeTab === 'Overview' ? (
            <div className="crm-card">
              <h2>Overview</h2>
              <div className="crm-kv"><span className="k">Interactions</span><span className="v">{ws.interactions.length}</span></div>
              <div className="crm-kv"><span className="k">Website events</span><span className="v">{webEvents.length}</span></div>
              <div className="crm-kv"><span className="k">Messages</span><span className="v">{messages.length}</span></div>
              <div className="crm-kv"><span className="k">Bookings</span><span className="v">{ws.bookings.length}</span></div>
              <div className="crm-kv"><span className="k">Derived signals</span><span className="v">{ws.signals.length}</span></div>
              <div className="crm-kv"><span className="k">Notes</span><span className="v">{notes.length}</span></div>
              {timeline ? (<div className="crm-kv"><span className="k">Lifetime value</span><span className="v">{money(timeline.lifetimeValueCents)}</span></div>) : null}
              <div className="crm-kv"><span className="k">Assigned AI</span><span className="v">{ws.assignedAIName || '—'}</span></div>
              <div className="crm-kv"><span className="k">Assigned human</span><span className="v">{ws.assignedHumanName || '—'}</span></div>
            </div>
          ) : null}

          {activeTab === 'Edit' && canUpdateCustomer ? (
            <div className="crm-card">
              <h2>Edit intake record</h2>
              <form action={updateCustomerFieldsAction}>
                <input type="hidden" name="customerId" value={cid} />
                <div className="crm-edit-grid">
                  <label className="crm-field"><span>First name</span><input className="crm-input" name="firstName" defaultValue={ws.customer.firstName ?? ''} /></label>
                  <label className="crm-field"><span>Last name</span><input className="crm-input" name="lastName" defaultValue={ws.customer.lastName ?? ''} /></label>
                  <label className="crm-field"><span>Email</span><input className="crm-input" name="email" type="email" defaultValue={ws.customer.email ?? ''} /></label>
                  <label className="crm-field"><span>Phone</span><input className="crm-input" name="phone" defaultValue={ws.customer.phone ?? ''} /></label>
                  <label className="crm-field"><span>Company</span><input className="crm-input" name="company" defaultValue={ws.company} /></label>
                  <label className="crm-field"><span>City</span><input className="crm-input" name="city" defaultValue={ws.city} /></label>
                  <label className="crm-field"><span>State</span><input className="crm-input" name="state" defaultValue={ws.state} /></label>
                  <label className="crm-field"><span>Service type</span><input className="crm-input" name="serviceType" defaultValue={ws.serviceType} /></label>
                  <label className="crm-field"><span>Source</span><input className="crm-input" name="source" defaultValue={ws.source} /></label>
                </div>
                <div className="crm-form-row" style={{ marginTop: '0.85rem' }}>
                  <button className="crm-btn" type="submit">Save changes</button>
                  <Link className="crm-btn crm-btn-ghost" href={tabHref('Overview')}>Cancel</Link>
                </div>
              </form>
            </div>
          ) : null}

          {activeTab === 'Timeline' ? (
            <div className="crm-card">
              <h2>Interaction timeline</h2>
              {ws.interactions.length === 0 ? (
                <EmptyTimeline message="No interactions yet." />
              ) : (
                <Timeline>
                  {ws.interactions.map((i) => (
                    <TimelineItem
                      key={i.id}
                      entry={fromInteraction(i, { badgeColor: KIND_COLOR[i.kind] })}
                    />
                  ))}
                </Timeline>
              )}
            </div>
          ) : null}

          {activeTab === 'Website' ? (
            <div className="crm-card">
              <h2>Website activity</h2>
              <p className="crm-faint" style={{ fontSize: '0.78rem', marginTop: '-0.3rem', marginBottom: '0.8rem' }}>
                Pages, searches, downloads, forms, and CTA clicks recorded from EMG-owned websites.
              </p>
              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.85rem' }}>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Total events</span><strong>{webEvents.length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Sessions</span><strong>{webEvents.filter((i) => webEventType(i) === 'web.session_start').length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Searches</span><strong>{webEvents.filter((i) => webEventType(i).startsWith('web.search')).length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Forms</span><strong>{webEvents.filter((i) => webEventType(i).startsWith('web.form')).length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>CTA clicks</span><strong>{webEvents.filter((i) => ['web.cta_click', 'web.phone_click', 'web.email_click'].includes(webEventType(i))).length}</strong></div>
              </div>
              {webEvents.length === 0 ? (
                <EmptyTimeline message="No website activity recorded for this person yet." />
              ) : (
                <ul className="crm-timeline" role="list">
                  {webEvents.map((i) => (
                    <li key={i.id}>
                      <span className="crm-tl-dot" style={{ background: 'var(--crm-blue)' }} />
                      <div>
                        <div className="crm-tl-title">{i.summary || i.kind}</div>
                        <div className="crm-tl-meta">
                          {(jsonVal<string>(i.metadata, 'property') ?? 'website')} · {webEventType(i).replace(/^web\./, '') || i.kind} · {fmt(i.occurredAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {activeTab === 'Notes' ? (
            <div className="crm-card">
              <h2>Internal notes</h2>
              {canUpdateCustomer ? (
                <form action={addNoteAction} style={{ marginBottom: '1rem' }}>
                  <input type="hidden" name="customerId" value={cid} />
                  <textarea className="crm-textarea" name="body" placeholder="Write an internal note…" aria-label="Internal note" required />
                  <div className="crm-form-row">
                    <span className="crm-faint">Posting as {session.name}</span>
                    <button className="crm-btn" type="submit">Add note</button>
                  </div>
                </form>
              ) : null}
              {notes.length === 0 ? (
                <EmptyTimeline message="No notes yet." />
              ) : (
                notes.map((n) => {
                  const who = interactionActorType(n.payload) ?? 'SYSTEM';
                  const authorName = interactionActorName(n.payload);
                  const cls = who === 'AI_AGENT' ? 'AI_AGENT' : who === 'HUMAN_AGENT' ? 'HUMAN_AGENT' : 'SYSTEM';
                  return (
                    <div className="crm-note" key={n.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className={'who ' + cls}>
                          {authorName ? `${authorName} · ${actorLabel(who)}` : actorLabel(who)}
                        </span>
                        <span className="when">{fmt(n.occurredAt)}</span>
                      </div>
                      <div className="crm-tl-body">{jsonVal<string>(n.payload, 'body') || n.summary}</div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}

          {activeTab === 'Messages' ? (
            <div className="crm-card">
              <h2>Messages</h2>
              {messages.length === 0 ? (
                <EmptyTimeline message="No messages yet." />
              ) : (
                <Timeline>
                  {messages.map((m) => {
                    const color = m.actorType === 'CUSTOMER' ? 'var(--crm-blue)' : 'var(--crm-purple)';
                    return (
                      <TimelineItem key={m.id} entry={{
                        id: m.id,
                        source: 'interaction',
                        title: actorLabel(m.actorType),
                        body: m.body ?? undefined,
                        actor: actorLabel(m.actorType),
                        actorType: m.actorType,
                        kind: m.type,
                        occurredAt: typeof m.sentAt === 'string' ? m.sentAt : m.sentAt.toISOString(),
                        badgeColor: color,
                      }} />
                    );
                  })}
                </Timeline>
              )}
            </div>
          ) : null}

          {activeTab === 'Bookings' ? (
            <div className="crm-card">
              <h2>Bookings</h2>
              {ws.bookings.length === 0 ? (
                <EmptyTimeline message="No bookings yet." />
              ) : (
                <Timeline>
                  {ws.bookings.map((b) => (
                    <TimelineItem key={b.id} entry={{
                      id: b.id,
                      source: 'interaction',
                      title: (b.title || 'Booking') + ' — ' + b.status,
                      body: 'Starts ' + fmt(b.startAt) + (b.endAt ? ' · ends ' + fmt(b.endAt) : ''),
                      actor: 'System',
                      actorType: 'SYSTEM',
                      kind: 'APPOINTMENT',
                      occurredAt: typeof b.startAt === 'string' ? b.startAt : b.startAt.toISOString(),
                      badgeColor: 'var(--crm-accent)',
                    }} />
                  ))}
                </Timeline>
              )}
            </div>
          ) : null}

          {activeTab === 'Revenue' ? (
            <div className="crm-card">
              <h2>Customer revenue timeline</h2>
              <p className="crm-faint" style={{ fontSize: '0.78rem', marginTop: '-0.3rem', marginBottom: '0.8rem' }}>
                Website visit → ZIP search → CTA → call → booking → revenue → lifetime value, assembled from recorded events only.
              </p>
              {!timeline ? (
                <EmptyTimeline message="No revenue journey recorded for this person yet." />
              ) : (
                <>
                  <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.85rem' }}>
                    <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Lifetime value</span><strong>{money(timeline.lifetimeValueCents)}</strong></div>
                    <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>First touch</span><strong>{fmt(timeline.firstTouchAt)}</strong></div>
                    <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Converted</span><strong>{fmt(timeline.conversionAt)}</strong></div>
                  </div>
                  {timeline.influencedBy.length > 0 ? (
                    <div style={{ marginBottom: '1rem' }}>
                      <span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '0.35rem' }}>Influenced by</span>
                      <div className="crm-chips">
                        {timeline.influencedBy.map((inf) => (
                          <span className="crm-tag" key={inf}>{inf}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {timeline.entries.length === 0 ? (
                    <EmptyTimeline message="No revenue events recorded yet." />
                  ) : (
                    <ul className="crm-timeline" role="list">
                      {timeline.entries.map((e, idx) => (
                        <li key={e.kind + idx + e.at}>
                          <span className="crm-tl-dot" style={{ background: REVENUE_KIND_COLOR[e.kind] ?? 'var(--crm-faint)' }} />
                          <div>
                            <div className="crm-tl-title">
                              {e.label}
                              {e.amountCents !== null ? <span className="crm-tag" style={{ marginLeft: '0.5rem' }}>{money(e.amountCents)}</span> : null}
                            </div>
                            <div className="crm-tl-meta">
                              <span className="crm-tag">{e.kind}</span>
                              {e.detail ? ' · ' + e.detail : ''}
                              {' · '}
                              {fmt(e.at)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          ) : null}

          {activeTab === 'Signals' ? (
            <div className="crm-card">
              <h2>Derived signals</h2>
              <p className="crm-faint crm-derived-note">
                Inferred by Loop from recorded activity — not recorded facts. Each shows the service that produced it.
              </p>
              {ws.signals.length === 0 ? (
                <EmptyTimeline message="No derived signals for this record." />
              ) : (
                <Timeline>
                  {ws.signals.map((s) => (
                    <TimelineItem key={s.id} entry={fromDerivedSignal(s)} />
                  ))}
                </Timeline>
              )}
            </div>
          ) : null}

          {activeTab === 'AI Activity' ? (
            <div className="crm-card">
              <h2>AI activity</h2>
              {aiActivity.length === 0 ? (
                <EmptyTimeline message="No AI activity yet." />
              ) : (
                <Timeline>
                  {aiActivity.map((i) => (
                    <TimelineItem
                      key={i.id}
                      entry={fromInteraction(i, { badgeColor: 'var(--crm-purple)' })}
                    />
                  ))}
                </Timeline>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
