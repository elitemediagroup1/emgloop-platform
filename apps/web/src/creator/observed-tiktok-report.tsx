import { type TimeView } from '@emgloop/shared';
import { Panel } from '../app/app/_loop-os/record';

/** A sampled agency report is never a calendar-window views total or an API connection. */
export function ObservedTikTokReport({ preferences, time, showEmpty = false }: { preferences: unknown; time: TimeView; showEmpty?: boolean }) {
  const raw = preferences && typeof preferences === 'object'
    ? (preferences as Record<string, unknown>).tiktokOneObservation
    : null;
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const valid = !!r
    && r.basis === '30 most recent videos'
    && typeof r.observedAt === 'string'
    && Number.isFinite(Date.parse(r.observedAt))
    && typeof r.medianViewsDisplayed === 'string'
    && typeof r.engagementPct === 'number'
    && typeof r.view6sPct === 'number';

  if (!valid && !showEmpty) return null;

  return (
    <Panel title="TikTok">
      {valid ? (
        <>
          <div className="ch-snapshot">
            <div className="ch-snapshot__metrics">
              <div><span>Median views</span><strong>{r.medianViewsDisplayed}</strong></div>
              <div><span>Engagement rate</span><strong>{r.engagementPct}%</strong></div>
              <div><span>6-second views</span><strong>{r.view6sPct}%</strong></div>
            </div>
            <p className="ch-snapshot__source">TikTok One · 30 most recent videos · observed {time.dateTime(r.observedAt as string)} · manually collected snapshot, not an API connection.</p>
          </div>
        </>
      ) : (
        <div className="ch-analytics-empty">
          <p>No TikTok One snapshot yet.</p>
          <span>When a reading is added to the creator profile, it will appear here.</span>
          <a className="loop-btn" href="/app/creator/profile">Manage TikTok profile</a>
        </div>
      )}
    </Panel>
  );
}
