import type { CallGridPollCoverage } from './callgrid-coverage';
import { viewerTime } from '../time/viewer-time';

export function CallGridCoverage({ coverage }: { coverage: CallGridPollCoverage }) {
  const time = viewerTime();
  return (
    <section className="cgx-note" aria-label="CallGrid recovery coverage">
      <strong>Recovery job health: {coverage.state === 'CURRENT' ? 'within threshold' : coverage.state.toLowerCase().replaceAll('_', ' ')}</strong>
      <p>{coverage.message}</p>
      {coverage.completedThrough ? <p>Proven interval: {time.dateTime(coverage.intervalSince!)} through {time.dateTime(coverage.completedThrough)} (exclusive). Checkpoint recorded {time.dateTime(coverage.recordedAt!)}.</p> : null}
      <p>Calls after that boundary can arrive by webhook, but have not yet been checked by recovery. A recent delivery does not prove earlier calls or later financial updates arrived.</p>
      <p>Scheduler enablement is managed in GitHub Actions and is not inferred from this checkpoint. Revenue-field coverage describes stored calls, not calls missing from Loop. Campaign completeness requires provider-day reconciliation.</p>
    </section>
  );
}
