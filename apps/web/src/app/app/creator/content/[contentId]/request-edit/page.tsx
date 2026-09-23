import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INSTRUCTION_LIMITS } from '@emgloop/shared';
import { requireWorkspace } from '../../../../../../workspaces/guard';
import { CREATOR_HREFS, requireCreator } from '../../../../../../creator/creator-runtime';
import { loadContentRecord, refusedFrom } from '../../../../../../creator/creator-data';
import { requestEditAction } from '../../../../../../creator/creator-actions';
import { viewerTime } from '../../../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock } from '../../../../_loop-os/record';
import { refusalText } from '../../../_parts/vocabulary';

// "Request an edit" (Creator Hub): starts a Production on this content. A plain server form.
//
// The record decides whether an edit can be requested (`record.actions.requestEdit`, derived from
// the state); this page only draws the form or says why there is none. The PRODUCTION_ACTIVE
// refusal is shown in the same words whether the state already knew it or the service refused.

export const dynamic = 'force-dynamic';

export default async function RequestEditPage({ params, searchParams }: { params: { contentId: string }; searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const record = await loadContentRecord(seat, params.contentId);
  if (!record) notFound();
  const time = viewerTime();
  const recordHref = CREATOR_HREFS.contentRecord(record!.id);
  const ready = record!.versions.filter((v) => v.uploadState === 'READY').sort((a, b) => b.number - a.number);
  const refused = refusedFrom(searchParams);
  const active = record!.activeProduction;
  const canRequest = record!.actions.requestEdit && ready.length > 0 && !active;
  const blocked = active ? refusalText('PRODUCTION_ACTIVE', null) : refused ? refusalText(refused.reason, refused.detail) : null;

  return (
    <LoopPage label="Request an edit">
      <PageHead trail={[{ label: 'Content', href: CREATOR_HREFS.content }, { label: record!.title, href: recordHref }, { label: 'Request an edit' }]} title="Request an edit" subtitle={`Starts Production ${record!.productions.length + 1} on ${record!.title}. EMG edits from the version you pick and returns it for your review.`} />
      {blocked ? <StateBlock kind="attention" title={blocked.title} body={blocked.body} action={{ label: 'Back to the record', href: recordHref }} /> : null}
      {!active && !canRequest ? (
        <StateBlock
          kind="empty"
          title="Nothing to request right now."
          body={ready.length === 0 ? 'No finished version exists yet; an edit needs one to start from.' : 'This content is not in a state where an edit can be requested.'}
          action={{ label: 'Back to the record', href: recordHref }}
        />
      ) : null}
      {canRequest ? (
        <Panel title="What you would like changed">
          <form className="ch-form" action={requestEditAction}>
            <input type="hidden" name="contentId" value={record!.id} />
            <label className="loop-field">
              <span className="loop-label">Edit from</span>
              <select className="loop-select" name="sourceVersionId" defaultValue={ready[0]!.id}>
                {ready.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} · {time.dateTime(v.readyAt ?? v.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <label className="loop-field">
              <span className="loop-label">Instructions</span>
              <textarea className="loop-textarea" name="summary" rows={6} required maxLength={INSTRUCTION_LIMITS.maxSummaryChars} placeholder="What should the editor do? Be as specific as you like; timestamped notes come later, in review." />
            </label>
            <label className="loop-field">
              <span className="loop-label">When you'd like it back (optional)</span>
              <input className="loop-input" type="datetime-local" name="requestedReturnAt" />
              <span className="loop-note">In your time zone ({time.timeZone}). EMG sets its own expected return, which you will see on the record.</span>
            </label>
            <div className="loop-btnrow">
              <button type="submit" className="loop-btn loop-btn--primary">
                Send to EMG
              </button>
              <Link className="loop-btn loop-btn--quiet" href={recordHref}>
                Cancel
              </Link>
            </div>
          </form>
        </Panel>
      ) : null}
    </LoopPage>
  );
}
