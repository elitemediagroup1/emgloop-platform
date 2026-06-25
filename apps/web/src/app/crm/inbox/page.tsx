import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';

// Activity inbox — Sprint 6 (Internal CRM, Phase 2).
//
// A single chronological feed of every recent touchpoint across the whole
// organization (quote requests, SMS, email, calls, bookings, AI decisions,
// signals, human notes), each linked to its customer. Read straight from Neon
// via crm.inboxFeed(). Optional ?kind= filter narrows the stream. This is the
// operator's "what just happened" surface.

export const dynamic = 'force-dynamic';

type SP = { kind?: string };

const KIND_COLOR: Record<string, string> = {
  FORM_SUBMISSION: 'var(--crm-blue)',
  SMS: 'var(--crm-purple)',
  EMAIL: 'var(--crm-purple)',
  PHONE_CALL: 'var(--crm-amber)',
  APPOINTMENT: 'var(--crm-accent)',
  NOTE: 'var(--crm-faint)',
  OTHER: 'var(--crm-faint)',
};

function actorLabel(a: string): string {
  switch (a) {
    case 'AI_AGENT':
    case 'ai_employee':
      return 'AI';
    case 'CUSTOMER':
    case 'customer':
      return 'Customer';
    case 'HUMAN_AGENT':
    case 'human_agent':
      return 'Human';
    default:
      return 'System';
  }
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const kindFilter = (searchParams?.kind ?? '').trim();

  const result = await loadOrFallback(async () => {
    const organizationId = await resolveCrmOrganizationId();
    if (!organizationId) return { empty: true as const, items: [] };
    const items = await crmRepos.crm.inboxFeed(organizationId, 100);
    return { empty: false as const, items };
  });

  if (!result.ok) return <DbNotConfigured />;

  const allItems = result.data.empty ? [] : result.data.items;
  const kinds = Array.from(new Set(allItems.map((i) => i.kind))).sort();
  const items = kindFilter
    ? allItems.filter((i) => i.kind === kindFilter)
    : allItems;

  return (
    <>
      <h1 className="crm-h1">Inbox</h1>
      <p className="crm-sub">
        {allItems.length} recent activities across the organization.
      </p>

      <div className="crm-chips" style={{ margin: '0.85rem 0' }}>
        <Link
          className={'crm-chip' + (!kindFilter ? ' active' : '')}
          href="/crm/inbox"
        >
          All
        </Link>
        {kinds.map((k) => (
          <Link
            key={k}
            className={'crm-chip' + (kindFilter === k ? ' active' : '')}
            href={'/crm/inbox?kind=' + encodeURIComponent(k)}
          >
            {k}
          </Link>
        ))}
      </div>

      <div className="crm-panel">
        {items.length === 0 ? (
          <div className="crm-empty">No activity yet.</div>
        ) : (
          <ul className="crm-feed">
            {items.map((i) => (
              <li key={i.id} className="crm-feed-item">
                <span
                  className="crm-tl-dot"
                  style={{ background: KIND_COLOR[i.kind] ?? 'var(--crm-faint)' }}
                />
                <div className="crm-feed-body">
                  <div className="crm-feed-top">
                    {i.customerId ? (
                      <Link
                        href={'/crm/customers/' + i.customerId}
                        className="crm-cell-name"
                      >
                        {i.customerName}
                      </Link>
                    ) : (
                      <span className="crm-cell-name">{i.customerName}</span>
                    )}
                    <span className="crm-feed-when" title={fmt(i.occurredAt)}>
                      {relTime(i.occurredAt)}
                    </span>
                  </div>
                  <div className="crm-tl-body">{i.summary}</div>
                  <div className="crm-tl-meta">
                    {i.kind} · {actorLabel(i.actorType)} · {i.channel} ·{' '}
                    {i.direction} · {fmt(i.occurredAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
