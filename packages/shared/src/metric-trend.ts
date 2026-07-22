// Period-over-period trend for a business metric (today vs yesterday).
//
// Honesty first: a value is either a real number, UNKNOWN (an input could not be
// computed from real data), or UNAVAILABLE (the source read failed). We never
// invent a percentage, never divide by zero into Infinity, and never imply a
// completed period for a live one.

export type MetricValue =
  | { state: 'value'; value: number }
  | { state: 'unknown' }
  | { state: 'unavailable' };

export type TrendResult =
  | { kind: 'up'; pct: number } // pct is the positive magnitude, one decimal
  | { kind: 'down'; pct: number }
  | { kind: 'flat' } // a real, computed 0.0% change → "— 0.0%"
  | { kind: 'no_change' } // both zero → "No change"
  | { kind: 'new' } // baseline zero, today non-zero → "New today"
  | { kind: 'unknown' }
  | { kind: 'unavailable' };

export function metricValue(value: number | null | undefined, available: boolean): MetricValue {
  if (!available) return { state: 'unavailable' };
  if (value === null || value === undefined) return { state: 'unknown' };
  return { state: 'value', value };
}

/** Trend of `today` versus the `yesterday` baseline. */
export function trend(yesterday: MetricValue, today: MetricValue): TrendResult {
  if (yesterday.state === 'unavailable' || today.state === 'unavailable') return { kind: 'unavailable' };
  if (yesterday.state === 'unknown' || today.state === 'unknown') return { kind: 'unknown' };

  const y = yesterday.value;
  const t = today.value;

  if (y === 0 && t === 0) return { kind: 'no_change' };
  if (y === 0) return { kind: 'new' }; // t !== 0, avoid divide-by-zero

  const raw = ((t - y) / y) * 100;
  const pct = Math.round(Math.abs(raw) * 10) / 10; // one decimal place
  if (pct === 0) return { kind: 'flat' };
  return raw > 0 ? { kind: 'up', pct } : { kind: 'down', pct };
}

/** The exact text to show for a trend, per the display contract. */
export function trendLabel(r: TrendResult): string {
  switch (r.kind) {
    case 'up':
      return `↑ ${r.pct.toFixed(1)}%`;
    case 'down':
      return `↓ ${r.pct.toFixed(1)}%`;
    case 'flat':
      return '— 0.0%';
    case 'no_change':
      return 'No change';
    case 'new':
      return 'New today';
    case 'unknown':
      return 'Unknown';
    case 'unavailable':
      return 'Unavailable';
  }
}
