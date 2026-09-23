// Audience over time (Creator Hub analytics). PURE, server-rendered SVG.
//
// One line per platform, each its own small chart (never two y-scales on one chart, never a
// legend a single series does not need). Drawn to scale from the audience snapshots as stored:
// a chart exists only when at least two observations exist, and every point is a row. The
// series colour is the Loop accent; every label wears a text token. A table of the same rows
// sits under each chart so the numbers are never colour-alone.

import type { TimeView } from '@emgloop/shared';
import { SOCIAL_PLATFORM_LABELS, EVIDENCE_SOURCE_LABELS } from '@emgloop/shared';
import { compactNumber } from './vocabulary';

export interface AudiencePoint {
  readonly observedAt: string;
  readonly followers: number;
  readonly source: string;
}

export interface AudienceSeries {
  readonly platform: string;
  readonly points: readonly AudiencePoint[];
}

const W = 600;
const H = 160;
const PAD = { top: 12, right: 16, bottom: 26, left: 52 };

function label(platform: string): string {
  return (SOCIAL_PLATFORM_LABELS as Record<string, string>)[platform] ?? platform;
}

export function groupAudience(rows: readonly { platform: string; observedAt: string; followers: number; source: string }[]): AudienceSeries[] {
  const byPlatform = new Map<string, AudiencePoint[]>();
  for (const r of rows) {
    const list = byPlatform.get(r.platform) ?? [];
    list.push({ observedAt: r.observedAt, followers: r.followers, source: r.source });
    byPlatform.set(r.platform, list);
  }
  return [...byPlatform.entries()].map(([platform, points]) => ({ platform, points: [...points].sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1)) }));
}

export function AudienceChart({ series, time }: { series: AudienceSeries; time: TimeView }) {
  const pts = series.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < 2) {
    return (
      <div className="ch-chart" data-platform={series.platform}>
        <p className="ch-h">{label(series.platform)}</p>
        <p className="loop-note">{pts.length === 1 ? `One observation (${compactNumber(first!.followers)} followers, ${time.date(first!.observedAt)}). A line needs two.` : 'No observations yet.'}</p>
      </div>
    );
  }
  const t0 = Date.parse(first.observedAt);
  const t1 = Date.parse(last.observedAt);
  const min = Math.min(...pts.map((p) => p.followers));
  const max = Math.max(...pts.map((p) => p.followers));
  const spanT = Math.max(1, t1 - t0);
  const spanY = Math.max(1, max - min);
  const x = (iso: string) => PAD.left + ((Date.parse(iso) - t0) / spanT) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / spanY) * (H - PAD.top - PAD.bottom);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.observedAt).toFixed(1)} ${y(p.followers).toFixed(1)}`).join(' ');
  const seeded = pts.some((p) => p.source === 'SEEDED_DEMO');
  const summary = `${label(series.platform)} followers from ${compactNumber(first.followers)} on ${time.date(first.observedAt)} to ${compactNumber(last.followers)} on ${time.date(last.observedAt)}, ${pts.length} observations`;
  return (
    <div className="ch-chart" data-platform={series.platform}>
      <p className="ch-h">
        {label(series.platform)} · {compactNumber(last.followers)} followers
      </p>
      <svg className="ch-chart__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} preserveAspectRatio="none">
        <line className="ch-chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(max)} y2={y(max)} />
        <line className="ch-chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(min)} y2={y(min)} />
        <text className="ch-chart__tick" x={PAD.left - 6} y={y(max) + 4} textAnchor="end">
          {compactNumber(max)}
        </text>
        <text className="ch-chart__tick" x={PAD.left - 6} y={y(min) + 4} textAnchor="end">
          {compactNumber(min)}
        </text>
        <text className="ch-chart__tick" x={PAD.left} y={H - 8} textAnchor="start">
          {time.monthDay(first.observedAt)}
        </text>
        <text className="ch-chart__tick" x={W - PAD.right} y={H - 8} textAnchor="end">
          {time.monthDay(last.observedAt)}
        </text>
        <path className="ch-chart__line" d={path} />
        {pts.map((p) => (
          <circle key={p.observedAt} className="ch-chart__dot" cx={x(p.observedAt)} cy={y(p.followers)} r={4}>
            <title>
              {time.date(p.observedAt)} · {p.followers.toLocaleString('en-US')} followers · {p.source === 'SEEDED_DEMO' ? EVIDENCE_SOURCE_LABELS.SEEDED_DEMO : `from ${label(series.platform)}`}
            </title>
          </circle>
        ))}
      </svg>
      {seeded ? <p className="ch-seeded">Includes seeded demo data.</p> : null}
      <details className="loop-drawer" style={{ marginTop: 8 }}>
        <summary>As a table · {pts.length} observations</summary>
        <div className="loop-drawer__body">
          <table className="loop-table">
            <thead>
              <tr>
                <th>Observed</th>
                <th>Followers</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.observedAt}>
                  <td data-label="Observed">{time.date(p.observedAt)}</td>
                  <td data-label="Followers">{p.followers.toLocaleString('en-US')}</td>
                  <td data-label="Source">{p.source === 'SEEDED_DEMO' ? EVIDENCE_SOURCE_LABELS.SEEDED_DEMO : `from ${label(series.platform)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
