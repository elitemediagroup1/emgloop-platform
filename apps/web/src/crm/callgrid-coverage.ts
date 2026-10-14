import { assessCoverageHealth, DEFAULT_COVERAGE_HEALTH_POLICY } from '@emgloop/shared';

export interface CallGridPollCoverage {
  state: 'UNAVAILABLE' | 'NEVER_PROVEN' | 'CURRENT' | 'LAGGING' | 'STALE' | 'INVALID';
  completedThrough: Date | null;
  intervalSince: Date | null;
  recordedAt: Date | null;
  message: string;
}

/** Checkpoint health is independent of webhook freshness and scheduler enablement. */
export function callGridPollCoverage(input: {
  readOk: boolean;
  now: Date;
  checkpoint: { completedThrough: Date; lastIntervalSince: Date; updatedAt: Date } | null;
}): CallGridPollCoverage {
  const base = { completedThrough: null, intervalSince: null, recordedAt: null };
  if (!input.readOk) return { ...base, state: 'UNAVAILABLE', message: 'Recovery coverage could not be read. Recent webhook activity does not establish completeness.' };
  if (!input.checkpoint) return { ...base, state: 'NEVER_PROVEN', message: 'No routine recovery coverage has been proven. Polling may be disabled or may not have completed; check the scheduled recovery job.' };
  const c = input.checkpoint;
  const times = [input.now, c.completedThrough, c.lastIntervalSince, c.updatedAt].map((d) => d.getTime());
  if (times.some((t) => !Number.isFinite(t)) || c.completedThrough > input.now || c.lastIntervalSince >= c.completedThrough) {
    return { ...base, state: 'INVALID', message: 'The recovery checkpoint is invalid or ahead of the clock. Coverage needs investigation.' };
  }
  const health = assessCoverageHealth({ now: input.now, completedThrough: c.completedThrough, policy: DEFAULT_COVERAGE_HEALTH_POLICY });
  return {
    completedThrough: c.completedThrough, intervalSince: c.lastIntervalSince, recordedAt: c.updatedAt,
    state: health.status === 'HEALTHY' ? 'CURRENT' : health.status,
    message: health.status === 'HEALTHY'
      ? 'The recovery job is within its health threshold; this does not mean live totals are reconciled. This does not certify all historical days or the provider credential’s campaign scope.'
      : 'Routine recovery coverage is behind. Recent webhook activity does not establish completeness; check the scheduled recovery job.',
  };
}
