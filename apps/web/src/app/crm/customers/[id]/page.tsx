import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOrFallback, DbNotConfigured } from '../../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { PIPELINE_STATUSES, type AssigneeOptions } from '@emgloop/database';
import {
  addNoteAction,
  setStatusAction,
  addTagAction,
  removeTagAction,
  setAssignmentAction,
  updateCustomerFieldsAction,
} from '../../../../crm/actions';

// Customer workspace — Sprint 5 (Phase 1) + Sprint 6 (Phase 2)
//                    + Sprint 14 (Website Intelligence — Website tab).
//
// A dedicated operating surface for one customer, read entirely from Neon via
// the repository layer. Tabs are server-rendered via ?tab= so no client JS is
// needed. Sprint 14 adds a Website tab that surfaces this customer's website
// activity (pages, searches, downloads, forms, CTAs, sessions) — reusing the
// existing timeline UI; website events already flow into ws.interactions via the
// WebsiteProvider, so this is a presentation-only view over Brain data.

export const dynamic = 'force-dynamic';

const TABS = [
  'Overview',
  'Timeline',
  'Website',
  'Notes',
  'Messages',
  'Bookings',
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

function fmt(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function payloadVal<T = unknown>(payload: unknown, key: string): T | undefined {
  if (payload && typeof payload === 'object' && key in (payload as object)) {
    return (payload as Record<string, T>)[key];
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
function isWebInteraction(i: { provider?: string | null; payload?: unknown }): boolean {
  if (i.provider === 'website') return true;
  const et = payloadVal<string>(i.payload, 'eventType');
  return typeof et === 'string' && et.startsWith('web.');
}

export default async function CustomerWorkspace({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const activeTab: Tab = (TABS as readonly string[]).includes(
    searchParams?.tab ?? '',
  )
    ? (searchParams!.tab as Tab)
    : 'Overview';

  const result = await loadOrFallback(async () => {
    const ws = await crmRepos.crm.getWorkspace(params.id);
    if (!ws) return { ws: null, assignees: { humans: [], ais: [] } as AssigneeOptions };
    const organizationId = await resolveCrmOrganizationId();
    const assignees = organizationId
      ? await crmRepos.crm.listAssignees(organizationId)
      : ({ humans: [], ais: [] } as AssigneeOptions);
    return { ws, assignees };
  });

  if (!result.ok) return <DbNotConfigured />;
  if (!result.data.ws) return notFound();

  const ws = result.data.ws;
  const assignees = result.data.assignees;
  const cid = ws.customer.id;

  const notes = ws.interactions.filter((i) => i.kind === 'NOTE');
  const messages = ws.conversations.flatMap((c) => c.messages);
  const webEvents = ws.interactions.filter((i) => isWebInteraction(i));
  const aiActivity = ws.interactions.filter(
    (i) =>
      actorLabel(payloadVal<string>(i.payload, 'actorType')) === 'AI' ||
      i.kind === 'APPOINTMENT',
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
      <div style={{ marginBottom: '0.5rem' }}>
        <Link href="/crm/customers" className="crm-faint" style={{ fontSize: '0.8rem' }}>
          ← Customers
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h1 className="crm-h1">{ws.name}</h1>
        <span className={'crm-status ' + ws.status}>{ws.status}</span>
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

      <div className="crm-ws">
        {/* Left rail */}
        <div>
          <div className="crm-card">
            <h3>Customer attributes</h3>
            <div className="crm-kv"><span className="k">Email</span><span className="v">{ws.customer.email || '—'}</span></div>
            <div className="crm-kv"><span className="k">Phone</span><span className="v">{ws.customer.phone || '—'}</span></div>
            <div className="crm-kv"><span className="k">Company</span><span className="v">{ws.company || '—'}</span></div>
            <div className="crm-kv"><span className="k">City</span><span className="v">{ws.city || '—'}</span></div>
            <div className="crm-kv"><span className="k">State</span><span className="v">{ws.state || '—'}</span></div>
            <div className="crm-kv"><span className="k">Service</span><span className="v">{ws.serviceType || '—'}</span></div>
            <div className="crm-kv"><span className="k">Source</span><span className="v">{ws.source || '—'}</span></div>
            <div className="crm-kv"><span className="k">External ID</span><span className="v">{ws.customer.externalId || '—'}</span></div>
            <div className="crm-kv"><span className="k">Created</span><span className="v">{fmt(ws.customer.createdAt)}</span></div>
            <Link className="crm-btn crm-btn-ghost" href={tabHref('Edit')} style={{ marginTop: '0.6rem', display: 'inline-block' }}>
              Edit details
            </Link>
          </div>

          <div className="crm-card">
            <h3>Pipeline status</h3>
            <form action={setStatusAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <select className="crm-select" name="status" defaultValue={ws.status} style={{ flex: 1 }}>
                {PIPELINE_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button className="crm-btn" type="submit">Set</button>
            </form>
          </div>

          <div className="crm-card">
            <h3>Assignments</h3>
            <label className="crm-field-label">Human employee</label>
            <form action={setAssignmentAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <select className="crm-select" name="humanName" defaultValue={ws.assignedHumanName} style={{ flex: 1 }}>
                <option value="">— Unassigned —</option>
                {humanNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button className="crm-btn" type="submit">Save</button>
            </form>
            <label className="crm-field-label" style={{ marginTop: '0.5rem' }}>AI employee</label>
            <form action={setAssignmentAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <select className="crm-select" name="aiName" defaultValue={ws.assignedAIName} style={{ flex: 1 }}>
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
          </div>

          <div className="crm-card">
            <h3>Tags</h3>
            <div className="crm-chips" style={{ marginBottom: '0.5rem' }}>
              {ws.customer.tags.length === 0 ? (
                <span className="crm-faint" style={{ fontSize: '0.8rem' }}>No tags</span>
              ) : (
                ws.customer.tags.map((t) => (
                  <form action={removeTagAction} key={t} style={{ display: 'inline' }}>
                    <input type="hidden" name="customerId" value={cid} />
                    <input type="hidden" name="tag" value={t} />
                    <button className="crm-chip active" type="submit" style={{ cursor: 'pointer' }} title="Remove tag">
                      {t} ✕
                    </button>
                  </form>
                ))
              )}
            </div>
            <form action={addTagAction} className="crm-form-row">
              <input type="hidden" name="customerId" value={cid} />
              <input className="crm-input" name="tag" list="crm-tag-suggestions" placeholder="Add tag…" style={{ flex: 1 }} />
              <datalist id="crm-tag-suggestions">
                {SUGGESTED_TAGS.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <button className="crm-btn" type="submit">Add</button>
            </form>
          </div>
        </div>

        {/* Right: tabbed workspace */}
        <div>
          <div className="crm-tabs">
            {TABS.map((t) => (
              <Link key={t} href={tabHref(t)} className={t === activeTab ? 'active' : ''}>
                {t}
              </Link>
            ))}
          </div>

          {activeTab === 'Overview' ? (
            <div className="crm-card">
              <h3>Overview</h3>
              <div className="crm-kv"><span className="k">Interactions</span><span className="v">{ws.interactions.length}</span></div>
              <div className="crm-kv"><span className="k">Website events</span><span className="v">{webEvents.length}</span></div>
              <div className="crm-kv"><span className="k">Messages</span><span className="v">{messages.length}</span></div>
              <div className="crm-kv"><span className="k">Bookings</span><span className="v">{ws.bookings.length}</span></div>
              <div className="crm-kv"><span className="k">Signals</span><span className="v">{ws.signals.length}</span></div>
              <div className="crm-kv"><span className="k">Notes</span><span className="v">{notes.length}</span></div>
              <div className="crm-kv"><span className="k">Assigned AI</span><span className="v">{ws.assignedAIName || '—'}</span></div>
              <div className="crm-kv"><span className="k">Assigned human</span><span className="v">{ws.assignedHumanName || '—'}</span></div>
            </div>
          ) : null}

          {activeTab === 'Edit' ? (
            <div className="crm-card">
              <h3>Edit customer</h3>
              <form action={updateCustomerFieldsAction}>
                <input type="hidden" name="customerId" value={cid} />
                <div className="crm-edit-grid">
                  <label className="crm-field">
                    <span>First name</span>
                    <input className="crm-input" name="firstName" defaultValue={ws.customer.firstName ?? ''} />
                  </label>
                  <label className="crm-field">
                    <span>Last name</span>
                    <input className="crm-input" name="lastName" defaultValue={ws.customer.lastName ?? ''} />
                  </label>
                  <label className="crm-field">
                    <span>Email</span>
                    <input className="crm-input" name="email" type="email" defaultValue={ws.customer.email ?? ''} />
                  </label>
                  <label className="crm-field">
                    <span>Phone</span>
                    <input className="crm-input" name="phone" defaultValue={ws.customer.phone ?? ''} />
                  </label>
                  <label className="crm-field">
                    <span>Company</span>
                    <input className="crm-input" name="company" defaultValue={ws.company} />
                  </label>
                  <label className="crm-field">
                    <span>City</span>
                    <input className="crm-input" name="city" defaultValue={ws.city} />
                  </label>
                  <label className="crm-field">
                    <span>State</span>
                    <input className="crm-input" name="state" defaultValue={ws.state} />
                  </label>
                  <label className="crm-field">
                    <span>Service type</span>
                    <input className="crm-input" name="serviceType" defaultValue={ws.serviceType} />
                  </label>
                  <label className="crm-field">
                    <span>Source</span>
                    <input className="crm-input" name="source" defaultValue={ws.source} />
                  </label>
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
              <h3>Interaction timeline</h3>
              {ws.interactions.length === 0 ? (
                <p className="crm-faint">No interactions yet.</p>
              ) : (
                <ul className="crm-timeline">
                  {ws.interactions.map((i) => (
                    <li key={i.id}>
                      <span className="crm-tl-dot" style={{ background: KIND_COLOR[i.kind] ?? 'var(--crm-faint)' }} />
                      <div>
                        <div className="crm-tl-title">{i.summary || i.kind}</div>
                        {payloadVal<string>(i.payload, 'body') ? (
                          <div className="crm-tl-body">“{payloadVal<string>(i.payload, 'body')}”</div>
                        ) : null}
                        <div className="crm-tl-meta">
                          {i.kind} · {actorLabel(payloadVal<string>(i.payload, 'actorType'))} · {i.channel} · {fmt(i.occurredAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {activeTab === 'Website' ? (
            <div className="crm-card">
              <h3>Website activity</h3>
              <p className="crm-faint" style={{ fontSize: '0.78rem', marginTop: '-0.3rem', marginBottom: '0.8rem' }}>
                Pages, searches, downloads, forms, and CTA clicks captured by the Brain across EMG-owned websites.
              </p>
              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.85rem' }}>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Total events</span><strong>{webEvents.length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Sessions</span><strong>{webEvents.filter((i) => payloadVal<string>(i.payload, 'eventType') === 'web.session_start').length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Searches</span><strong>{webEvents.filter((i) => (payloadVal<string>(i.payload, 'eventType') ?? '').startsWith('web.search')).length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>Forms</span><strong>{webEvents.filter((i) => (payloadVal<string>(i.payload, 'eventType') ?? '').startsWith('web.form')).length}</strong></div>
                <div><span className="crm-faint" style={{ display: 'block', fontSize: '0.7rem', textTransform: 'uppercase' }}>CTA clicks</span><strong>{webEvents.filter((i) => ['web.cta_click', 'web.phone_click', 'web.email_click'].includes(payloadVal<string>(i.payload, 'eventType') ?? '')).length}</strong></div>
              </div>
              {webEvents.length === 0 ? (
                <p className="crm-faint">The Brain has not seen this customer on a website yet. As they browse EMG properties, their activity will appear here.</p>
              ) : (
                <ul className="crm-timeline">
                  {webEvents.map((i) => (
                    <li key={i.id}>
                      <span className="crm-tl-dot" style={{ background: 'var(--crm-blue)' }} />
                      <div>
                        <div className="crm-tl-title">{i.summary || i.kind}</div>
                        <div className="crm-tl-meta">
                          {(payloadVal<string>(i.payload, 'property') ?? 'website')} · {(payloadVal<string>(i.payload, 'eventType') ?? '').replace(/^web\./, '') || i.kind} · {fmt(i.occurredAt)}
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
              <h3>Internal notes</h3>
              <form action={addNoteAction} style={{ marginBottom: '1rem' }}>
                <input type="hidden" name="customerId" value={cid} />
                <textarea className="crm-textarea" name="body" placeholder="Write an internal note…" required />
                <div className="crm-form-row">
                  <select className="crm-select" name="author" defaultValue="HUMAN_AGENT">
                    <option value="HUMAN_AGENT">Human</option>
                    <option value="AI_AGENT">AI</option>
                    <option value="SYSTEM">System</option>
                  </select>
                  <button className="crm-btn" type="submit">Add note</button>
                </div>
              </form>
              {notes.length === 0 ? (
                <p className="crm-faint">No notes yet.</p>
              ) : (
                notes.map((n) => {
                  const who = String(payloadVal<string>(n.payload, 'actorType') ?? 'SYSTEM');
                  const cls = who === 'AI_AGENT' ? 'AI_AGENT' : who === 'HUMAN_AGENT' ? 'HUMAN_AGENT' : 'SYSTEM';
                  return (
                    <div className="crm-note" key={n.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className={'who ' + cls}>{actorLabel(who)}</span>
                        <span className="when">{fmt(n.occurredAt)}</span>
                      </div>
                      <div className="crm-tl-body">{payloadVal<string>(n.payload, 'body') || n.summary}</div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}

          {activeTab === 'Messages' ? (
            <div className="crm-card">
              <h3>Messages</h3>
              {messages.length === 0 ? (
                <p className="crm-faint">No messages yet.</p>
              ) : (
                <ul className="crm-timeline">
                  {messages.map((m) => (
                    <li key={m.id}>
                      <span className="crm-tl-dot" style={{ background: m.actorType === 'CUSTOMER' ? 'var(--crm-blue)' : 'var(--crm-purple)' }} />
                      <div>
                        <div className="crm-tl-title">{actorLabel(m.actorType)}</div>
                        <div className="crm-tl-body">{m.body}</div>
                        <div className="crm-tl-meta">{m.type} · {fmt(m.sentAt)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {activeTab === 'Bookings' ? (
            <div className="crm-card">
              <h3>Bookings</h3>
              {ws.bookings.length === 0 ? (
                <p className="crm-faint">No bookings yet.</p>
              ) : (
                <ul className="crm-timeline">
                  {ws.bookings.map((b) => (
                    <li key={b.id}>
                      <span className="crm-tl-dot" style={{ background: 'var(--crm-accent)' }} />
                      <div>
                        <div className="crm-tl-title">{b.title || 'Booking'} — {b.status}</div>
                        <div className="crm-tl-meta">
                          Starts {fmt(b.startAt)}{b.endAt ? ' · ends ' + fmt(b.endAt) : ''}
                          {b.calendarEventId ? ' · cal ' + b.calendarEventId : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {activeTab === 'Signals' ? (
            <div className="crm-card">
              <h3>Signals</h3>
              {ws.signals.length === 0 ? (
                <p className="crm-faint">No signals yet.</p>
              ) : (
                <ul className="crm-timeline">
                  {ws.signals.map((s) => (
                    <li key={s.id}>
                      <span className="crm-tl-dot" style={{ background: 'var(--crm-amber)' }} />
                      <div>
                        <div className="crm-tl-title">{s.label || s.key} <span className="crm-faint">({s.type})</span></div>
                        <div className="crm-tl-meta">
                          {s.source ? 'source ' + s.source + ' · ' : ''}{fmt(s.observedAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {activeTab === 'AI Activity' ? (
            <div className="crm-card">
              <h3>AI activity</h3>
              {aiActivity.length === 0 ? (
                <p className="crm-faint">No AI activity yet.</p>
              ) : (
                <ul className="crm-timeline">
                  {aiActivity.map((i) => (
                    <li key={i.id}>
                      <span className="crm-tl-dot" style={{ background: 'var(--crm-purple)' }} />
                      <div>
                        <div className="crm-tl-title">{i.summary || i.kind}</div>
                        <div className="crm-tl-meta">{i.kind} · {fmt(i.occurredAt)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
