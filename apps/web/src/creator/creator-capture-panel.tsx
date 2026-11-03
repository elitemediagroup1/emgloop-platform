import 'server-only';
import { captureReadings } from '@emgloop/database';
import type { WorkPrincipal } from '@emgloop/database';
import { Panel } from '../app/app/_loop-os/record';
import { managedMailboxes } from '../google/google-runtime';
import { managedCreatorMailRepository, creatorMailSharingEnabled } from './creator-mail-runtime';
import { CreatorBrandUpdatesView } from './creator-brand-updates';
import { CreatorUpdatesRefresh } from './CreatorUpdatesRefresh';
import { startCreatorCaptureAction, advanceCreatorCaptureAction, pauseCreatorCaptureAction } from './creator-capture-actions';
import { viewerTime } from '../time/viewer-time';
import { CreatorCaptureScreening } from './creator-capture-screening';
const OUTCOMES: Record<string, string> = { STARTED: 'The selected mailbox pilot has started. Summaries will appear as conversations are checked.', PAUSED: 'Capture is paused and its creator-facing readings have been removed.', CHECKED: 'Checked the next due capture step. Pending sources keep their actual wait time.', INVALID: 'Select between one and four connected sources.', NOT_ALLOWED: 'Check the manager authorization, assigned mailbox and bound Creator login.', FAILED: 'The capture step could not finish. No unchecked output was published.' };

const FAILURES: Record<string, string> = {
  SEARCH_UNAVAILABLE: 'Gmail search unavailable; retry pending',
  MODEL_POLICY_REFUSED: 'AI policy or budget refused the call; retry pending',
  MODEL_OUTPUT_REJECTED: 'AI output failed validation; retry pending',
  MODEL_REFUSED: 'AI provider declined to summarize; retry pending',
  MODEL_CALL_FAILED: 'AI call failed; retry pending',
  MODEL_OUTPUT_INVALID: 'AI summary was missing; retry pending',
  SCOPE_ENDED: 'capture authorization or creator scope ended',
};

export async function CreatorCapturePanel({ principal, profileId, ownEmail, outcome }: { principal: WorkPrincipal; profileId: string; ownEmail: string; outcome?: string }) {
  if (!creatorMailSharingEnabled()) return null;
  const repo = managedCreatorMailRepository(), sources = managedMailboxes().service.repository;
  if (!(await sources.permittedFor(principal, 'view'))) return null;
  if (!(await repo.present(principal.organizationId))) return <Panel title="Creator email pilot"><p className="loop-note">Capture is awaiting its database migration. Existing mailbox connections remain saved.</p></Panel>;
  const [staff, assigned, captures] = await Promise.all([sources.inventory(principal, null), sources.inventory(principal, profileId), repo.status(principal, profileId)]);
  const available = [...(staff ?? []), ...(assigned ?? [])].filter(s => s.status === 'CONNECTED');
  const active = (captures ?? []).filter(c => c.enabled), selected = new Set(active.map(c => c.mailboxId));
  const allReadings = active.flatMap(c => captureReadings(c.readings));
  const time = viewerTime();
  const updates = await repo.updates(principal, profileId, time.now, true);
  const ownActive = active.some(c => c.ownerUserId === principal.userId);
  const displayedOutcome = outcome === 'PAUSED' && active.length ? undefined : outcome;
  return <section id="capture"><Panel title="Creator email pilot" lead="Combine selected shared staff and assigned-creator mailboxes into this creator’s brand updates.">
    <CreatorUpdatesRefresh />
    {displayedOutcome && Object.hasOwn(OUTCOMES, displayedOutcome) ? <p role="status">{OUTCOMES[displayedOutcome]}</p> : null}
    <p className="loop-note">{active.length} sources enabled · {allReadings.length} source threads checked · {active.reduce((n, c) => n + c.pendingThreadIds.length, 0)} source threads queued. These are source checks, not unique brand counts.</p>
    {active.map(c => <p className="loop-note" key={c.id}>{available.find(s => s.id === c.mailboxId)?.expectedEmail ?? 'Source needs reconnection'}: {c.lastCheckedAt ? `last checked ${time.dateTime(c.lastCheckedAt)}` : 'awaiting first check'} · {c.listedCount} threads found this pass{c.capped ? ' · 100-thread source limit reached' : ''}{c.lastFailureClass ? ` · ${FAILURES[c.lastFailureClass] ?? 'source processing unavailable; existing readings may be stale'}` : ''}.</p>)}
    {allReadings.some(r => r.state !== 'CURRENT') ? <p className="loop-note">Some source threads are held, unmatched, unreadable or awaiting AI. They are excluded from current activity. Brand matching requires an established company, and mixed-creator discussions are withheld.</p> : null}
    <CreatorCaptureScreening sources={active.map(c => ({ label: available.find(s => s.id === c.mailboxId)?.expectedEmail ?? 'Unavailable source', readings: captureReadings(c.readings) }))} />
    <form action={startCreatorCaptureAction} className="loop-stack">
      <input type="hidden" name="profileId" value={profileId} />
      {available.map(s => <label key={s.id}><input type="checkbox" name="sourceId" value={s.id} defaultChecked={active.length ? selected.has(s.id) : s.kind === 'CREATOR' || s.expectedEmail.toLowerCase() === ownEmail.toLowerCase()} /> {s.expectedEmail} · {s.kind === 'CREATOR' ? 'assigned creator mailbox' : 'shared staff mailbox'}</label>)}
      {!available.length ? <p className="loop-note">Authorize a staff or assigned creator mailbox first.</p> : <>
        <label><input type="checkbox" name="confirmed" required /> Enable automatic, minimized AI brand summaries for this creator from only the selected mailboxes. Internal-only and other creators’ discussions must not be published.</label>
        <p className="loop-note">The pilot searches the last 30 days and examines up to 100 matching threads per source. It includes sent messages and relevant archived replies, not just Inbox. Staff searches use the creator’s saved full name and social handles; automatic attribution requires a creator match in the subject. Assigned-mailbox searches do not require creator keywords. Automatic brand candidates need a subject match or an exact full-company match to an external email domain, and still need an accepted AI summary. Generic-subject threads are held for explicit sharing. This is bounded coverage, not a complete outreach-history count. Starting again replaces this pilot’s readings and source selection.</p>
        <button className="loop-btn loop-btn--primary" type="submit">{active.length ? 'Restart with selected sources' : 'Start selected mailbox pilot'}</button>
      </>}
    </form>
    {ownActive ? <form action={advanceCreatorCaptureAction}><input type="hidden" name="profileId" value={profileId} /><button className="loop-btn" type="submit">Check next due conversation now</button></form> : null}
    {active.length ? <form action={pauseCreatorCaptureAction}><input type="hidden" name="profileId" value={profileId} /><button className="loop-btn" type="submit">Pause and remove pilot readings</button></form> : null}
  </Panel><CreatorBrandUpdatesView rows={updates} time={time} sourceNote="Manager preview of accepted readings from the selected managed-mailbox pilot only. Duplicated messages across mailboxes are combined when their Message-ID is available; brand counts are deduplicated by canonical brand. This preview is not a complete mailbox or outreach-history audit." /></section>;
}
