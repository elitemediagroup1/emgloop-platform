import { type TimeView } from '@emgloop/shared';
import { Facts, Panel } from '../app/app/_loop-os/record';
/** A sampled agency report is never a calendar-window views total or an API connection. */
export function ObservedTikTokReport({ preferences, time }: { preferences: unknown; time: TimeView }) {
  if (!preferences || typeof preferences !== 'object') return null;
  const raw = (preferences as Record<string, unknown>).tiktokOneObservation;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.basis !== '30 most recent videos' || typeof r.observedAt !== 'string' || !Number.isFinite(Date.parse(r.observedAt)) || typeof r.medianViewsDisplayed !== 'string' || typeof r.engagementPct !== 'number' || typeof r.view6sPct !== 'number') return null;
  return <Panel title="TikTok One reading">
    <Facts rows={[{ label: 'Median views', value: r.medianViewsDisplayed }, { label: 'Engagement rate', value: `${r.engagementPct}%` }, { label: '6-second video views', value: `${r.view6sPct}%` }]} />
    <p className="loop-note">Based on the 30 most recent videos, as reported by TikTok One. Observed {time.dateTime(r.observedAt)}. This is a manually collected snapshot; platform figures may be rounded. It does not represent a connected API or views for a calendar reporting window.</p>
  </Panel>;
}
