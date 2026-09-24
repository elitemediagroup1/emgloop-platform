import { requirePermission } from '../../../../auth/guard';
import { viewerTime } from '../../../../time/viewer-time';
import { requireWorkspace } from '../../../../workspaces/guard';
import { LoopPage, PageHead } from '../../_loop-os/record';
import { loadIntelligenceStatus } from './status-data';
import { IntelligenceStatusView } from './status-view';

export const dynamic = 'force-dynamic';

// Intelligence execution status (/app/admin/intelligence-status). READ ONLY.
//
// For an operator who may open the Executive Brain (ADMIN workspace + intelligence:view): how the
// governed AI tasks are running (the AI usage ledger, aggregated), the recorded provider policies,
// and domain-intelligence generation metadata -- the viewer's own digests, and organization counts.
// The guard runs before any read. Nothing here calls a model, writes, or shows a prompt, a
// response, digest content, a subject reference or whose private run a figure came from.

export default async function IntelligenceStatusPage() {
  await requireWorkspace('ADMIN');
  const session = await requirePermission('intelligence', 'view');
  const time = viewerTime();
  const status = await loadIntelligenceStatus(session, time.now);
  return (
    <LoopPage label="Intelligence status">
      <PageHead
        trail={[{ label: 'Intelligence' }, { label: 'Execution status' }]}
        title="Intelligence status"
        subtitle={`How Loop’s intelligence is running · read ${time.dateTime(status.generatedAt)}`}
      />
      <IntelligenceStatusView status={status} time={time} />
    </LoopPage>
  );
}
