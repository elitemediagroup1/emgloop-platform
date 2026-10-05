import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { crmRepos } from '../../../../crm/crm-data';
import { viewerTime } from '../../../../time/viewer-time';
import { anonymousRef, formatJourneyDuration, isWebPropertyKey } from '@emgloop/shared';
import { actionSummary, trafficLabel } from './journey-format';

// Live Websites -- anonymous visitor journeys (2026-10-05).
//
// Recent website SESSIONS across the organization's registered properties, newest activity first, each a summary of
// one anonymous browser's visit: where it came from, where it landed, the pages it moved through, what it did, and
// for how long. Opening one shows the chronological journey (session/page.tsx).
//
// Source: the governed first-party website events (WebsiteJourneyRepository over integration_events) -- every
// admitted event, minimized at ingestion. The previous feed read Interactions, which never hold page views or
// session starts, so it could not show a journey. Anonymous stays anonymous: a visitor is a browser's random id,
// never a person, and nothing here creates or matches one. Server-rendered; the organization comes from the session.

export const dynamic = 'force-dynamic';

const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
type WindowKey = keyof typeof WINDOWS;

export default async function LiveWebsitesPage({ searchParams }: { searchParams?: { property?: string; window?: string } }) {
  const session = await requirePermission('intelligence', 'view');
  const time = viewerTime();
  const organizationId = session.organizationId;

  const registered = await crmRepos.webProperties.listForOrganization(organizationId);
  const nameOf = new Map(registered.map((p) => [p.key, p.label ?? p.key]));
  const live = registered.filter((p) => p.lifecycle === 'LIVE');
  const property = searchParams?.property && isWebPropertyKey(searchParams.property) && nameOf.has(searchParams.property) ? searchParams.property : null;
  const windowKey: WindowKey = searchParams?.window && searchParams.window in WINDOWS ? (searchParams.window as WindowKey) : '7d';
  const since = new Date(time.now.getTime() - WINDOWS[windowKey] * 86_400_000);

  const list = await crmRepos.websiteJourneys.recentSessions(organizationId, { since, now: time.now, propertyKey: property, limit: 60 });

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Website Visitors</h1>
          <p className="crm-sub">
            Anonymous visits to EMG properties, one row per session — where each came from, where it landed, the pages it moved
            through and what it did. Open a visit to read its journey in order.
          </p>
        </div>
      </div>

      <div className="crm-panel">
        <form method="get" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'end', padding: '1rem 1rem 0.5rem' }}>
          <label className="crm-field">
            <span className="crm-faint">Property</span>
            <select className="crm-select" name="property" defaultValue={property ?? ''}>
              <option value="">All properties</option>
              {live.map((p) => (
                <option key={p.key} value={p.key}>{p.label ?? p.key}</option>
              ))}
            </select>
          </label>
          <label className="crm-field">
            <span className="crm-faint">Window</span>
            <select className="crm-select" name="window" defaultValue={windowKey}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <button className="crm-btn crm-btn-sm" type="submit">Show visits</button>
        </form>

        {list.sessions.length === 0 ? (
          <div className="crm-empty" style={{ padding: '0 1rem 1rem' }}>
            <p>No website visits were received {property ? `for ${nameOf.get(property)} ` : ''}in this window.</p>
            <p className="crm-faint">
              A live property only sends visits once the EMG Loop tracker is installed on its pages. Read Intelligence State
              reports each property&apos;s delivery as <code>WEBSITE_COLLECTION</code> (FLOWING, SPARSE or NO_EVENTS).
            </p>
          </div>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>Last activity</th><th>Site</th><th>Visitor</th><th>Duration</th><th>Arrived from</th>
                <th>Landing page</th><th>Pages</th><th>Actions</th><th>Events</th><th />
              </tr>
            </thead>
            <tbody>
              {list.sessions.map((s) => (
                <tr key={`${s.propertyKey}:${s.sessionId}`}>
                  <td><time dateTime={time.iso(s.lastAt)} title={time.full(s.lastAt)}>{time.relative(s.lastAt)}</time></td>
                  <td>{nameOf.get(s.propertyKey) ?? s.propertyKey}</td>
                  <td>
                    <span style={{ whiteSpace: 'nowrap' }}>Anonymous{s.visitorId ? ` · ${anonymousRef(s.visitorId)}` : ''}</span>{' '}
                    {s.visitor === 'NEW' ? <span className="crm-tag">New</span> : s.visitor === 'RETURNING' ? <span className="crm-tag">Returning</span> : null}
                  </td>
                  <td>{formatJourneyDuration(s.durationMs)}</td>
                  <td>{trafficLabel(s.traffic)}</td>
                  <td className="crm-cell-muted">{s.landingPage ?? '—'}</td>
                  <td>{s.counts.pageViews}</td>
                  <td>{actionSummary(s.counts)}</td>
                  <td>{s.eventCount}</td>
                  <td>
                    <Link className="crm-link" href={`/crm/live/websites/session?property=${encodeURIComponent(s.propertyKey)}&session=${encodeURIComponent(s.sessionId)}`}>
                      Journey
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!list.complete ? (
          <p className="crm-faint" style={{ padding: '0.75rem 1rem' }}>
            This window holds more events than one page reads; the most recent visits are shown. Narrow the window or pick a property.
          </p>
        ) : null}
      </div>
    </>
  );
}
