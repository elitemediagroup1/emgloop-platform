import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '../../../../../auth/guard';
import { crmRepos } from '../../../../../crm/crm-data';
import { viewerTime } from '../../../../../time/viewer-time';
import { anonymousRef, formatJourneyDuration } from '@emgloop/shared';
import { actionSummary, trafficLabel } from '../journey-format';

// One anonymous visit, in order (2026-10-05): where it came from, each page and action with the time since the one
// before, how far each page was scrolled, and where it ended -- plus the same browser's other visits to this site.
//
// Read from the governed first-party website events only (WebsiteJourneyRepository), scoped to the signed-in
// organization: another organization's session is not-found. Anonymous stays anonymous. Search text, campaign
// names, URL queries, form contents and contact details are never stored, so they never appear here.

export const dynamic = 'force-dynamic';

const H2 = { padding: '1rem 1rem 0.25rem', margin: 0 } as const;

export default async function WebsiteJourneyPage({ searchParams }: { searchParams?: { property?: string; session?: string } }) {
  const session = await requirePermission('intelligence', 'view');
  const time = viewerTime();
  const property = searchParams?.property ?? '';
  const sessionId = searchParams?.session ?? '';
  const detail = await crmRepos.websiteJourneys.session(session.organizationId, property, sessionId, time.now);
  if (!detail) notFound();
  const registered = await crmRepos.webProperties.findForOrganization(session.organizationId, detail.propertyKey);
  const site = registered?.label ?? detail.propertyKey;
  const j = detail.journey;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-faint"><Link className="crm-link" href="/crm/live/websites">← Website Visitors</Link></p>
          <h1 className="crm-h1">
            {site} · Anonymous visitor{detail.visitorId ? ` · ${anonymousRef(detail.visitorId)}` : ''}
          </h1>
          <p className="crm-sub">
            {detail.visitor === 'NEW' ? 'First visit from this browser in the last 90 days. ' : detail.visitor === 'RETURNING' ? 'This browser has visited before. ' : ''}
            {actionSummary(j.counts)}.
          </p>
        </div>
      </div>

      <div className="crm-panel" style={{ padding: '0.75rem 1rem' }}>
        <div className="crm-kv"><span className="k">Started</span><span className="v"><time dateTime={time.iso(j.startedAt)}>{time.full(j.startedAt)}</time>{j.startObserved ? '' : ' (the start of this visit was not observed)'}</span></div>
        <div className="crm-kv"><span className="k">Duration</span><span className="v">{formatJourneyDuration(j.durationMs)}</span></div>
        <div className="crm-kv"><span className="k">Arrived from</span><span className="v">{trafficLabel(j.traffic)}{j.traffic.kind === 'CAMPAIGN' ? ' (utm source / medium)' : j.traffic.kind === 'REFERRAL' ? ' (referring site)' : ''}</span></div>
        <div className="crm-kv"><span className="k">Landing page</span><span className="v">{j.landingPage ?? '—'}</span></div>
        <div className="crm-kv"><span className="k">Last page</span><span className="v">{j.exitPage ?? '—'}</span></div>
        <div className="crm-kv"><span className="k">Pages viewed</span><span className="v">{j.counts.pageViews}{j.path.length > 1 ? ` · ${j.path.join(' → ')}` : ''}</span></div>
        <div className="crm-kv"><span className="k">Events</span><span className="v">{j.eventCount}{detail.truncated ? ' (the first 2,000 are shown)' : ''}</span></div>
      </div>

      {j.pages.length > 0 ? (
        <div className="crm-panel" style={{ marginTop: '1rem' }}>
          <h2 className="crm-h2" style={H2}>Pages</h2>
          <table className="crm-table">
            <thead><tr><th>Page</th><th>First viewed</th><th>Views</th><th>Deepest scroll</th></tr></thead>
            <tbody>
              {j.pages.map((p) => (
                <tr key={p.path}>
                  <td>{p.path}</td>
                  <td><time dateTime={time.iso(p.firstAt)}>{time.time(p.firstAt)}</time></td>
                  <td>{p.views}</td>
                  <td>{p.maxScroll === null ? 'Not reported' : `${p.maxScroll}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="crm-panel" style={{ marginTop: '1rem' }}>
        <h2 className="crm-h2" style={H2}>Journey</h2>
        <ul className="crm-timeline">
          {j.steps.map((s, i) => (
            <li key={i}>
              <span className="crm-tl-dot" />
              <div>
                <div className="crm-tl-title">{s.label}{s.detail ? ` — ${s.detail}` : ''}</div>
                <div className="crm-tl-meta">
                  <time dateTime={time.iso(s.at)}>{time.time(s.at)}</time>
                  {s.sincePreviousMs !== null ? ` · +${formatJourneyDuration(s.sincePreviousMs)}` : ''}
                  {s.page ? ` · ${s.page}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="crm-faint" style={{ padding: '0 1rem 1rem', margin: 0 }}>
          “Left the page” marks the browser leaving a page, which also happens when moving to the next page; the visit ends
          at its last event. Heartbeats count toward duration and scroll milestones toward each page’s deepest scroll.
        </p>
      </div>

      {detail.visitorSessions.length > 1 ? (
        <div className="crm-panel" style={{ marginTop: '1rem' }}>
          <h2 className="crm-h2" style={H2}>This browser’s visits to {site} (last 90 days)</h2>
          <table className="crm-table">
            <thead><tr><th>Started</th><th>Events</th><th /></tr></thead>
            <tbody>
              {detail.visitorSessions.map((v) => (
                <tr key={v.sessionId}>
                  <td><time dateTime={time.iso(v.startedAt)}>{time.full(v.startedAt)}</time></td>
                  <td>{v.eventCount}</td>
                  <td>
                    {v.sessionId === detail.sessionId ? 'This visit' : (
                      <Link className="crm-link" href={`/crm/live/websites/session?property=${encodeURIComponent(detail.propertyKey)}&session=${encodeURIComponent(v.sessionId)}`}>Journey</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
