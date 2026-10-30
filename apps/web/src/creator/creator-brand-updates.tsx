// The creator sees only published, scoped paraphrases. No mailbox IDs, private subjects or citations
// leave the repository projection. Grouping by brand is presentation, not another model invocation.
import 'server-only';
import { CreatorBrandMailRepository, prisma, type PublishedCreatorBrandUpdate } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { CreatorUpdatesRefresh } from './CreatorUpdatesRefresh';
import { creatorMailSharingEnabled } from './creator-mail-runtime';
import { type CreatorSeat } from './creator-runtime';
import { Panel, StateBlock } from '../app/app/_loop-os/record';
import { settle } from '../app/app/_home/settle';
const STAGES: Record<string, string> = { OUTREACH: 'Outreach sent', DISCUSSING: 'In discussion', AWAITING_EMG: 'Waiting on EMG', AWAITING_BRAND: 'Waiting on the brand', AWAITING_CREATOR: 'Needs you', CONFIRMED: 'Confirmed', DECLINED: 'Did not go ahead', PAUSED: 'Paused' };
export function CreatorBrandUpdatesView({ rows, time }: { rows: readonly PublishedCreatorBrandUpdate[]; time: TimeView }) {
  const brands = new Map<string, PublishedCreatorBrandUpdate[]>();
  for (const row of rows) brands.set(row.brandId, [...(brands.get(row.brandId) ?? []), row]);
  return <Panel title="Brand updates" lead="What EMG is discussing on your behalf, grouped by brand or agency.">
    {!rows.length ? <StateBlock kind="empty" compact title="No brand updates shared yet." body="EMG will link the conversations it is handling for you. An empty list does not mean no outreach has happened." /> : <div className="loop-stack">
      {[...brands].map(([brandId, updates]) => <section key={brandId} aria-label={updates[0]!.brand}>
        <h3>{updates[0]!.brand}</h3>
        {updates.map(update => <div key={update.id} className="loop-stack" style={{ gap: 6, marginBottom: 16 }}>
          {update.summary ? <>
            <span className="loop-label">{STAGES[update.stage ?? ''] ?? 'Update'}{update.current ? '' : ' · earlier reading'}</span>
            <p>{update.summary}</p>
            {update.nextStep ? <p><strong>Next:</strong> {update.nextStep}</p> : null}
            <p className="loop-note">AI summary {update.generatedAt ? time.relative(update.generatedAt) : 'time unavailable'}. Source conversation through {update.evidenceAt ? time.dateTime(update.evidenceAt) : 'an unknown time'}.</p>
          </> : <p className="loop-note">This conversation is linked. A shareable summary is not available yet.</p>}
          <p className="loop-note">{update.checkedAt ? `Last checked ${time.relative(update.checkedAt)}.` : 'Awaiting first check.'} {!update.current ? 'A current reading is pending; do not treat this as live status.' : ''}</p>
        </div>)}
      </section>)}
    </div>}
    <p className="loop-note">AI interpretations can be wrong. Only explicitly shared conversations are covered; private emails and internal commercial details are not shown.</p>
  </Panel>;
}
export async function CreatorBrandUpdates({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  if (!creatorMailSharingEnabled()) return null;
  const repo = new CreatorBrandMailRepository(prisma);
  const result = await settle(async () => await repo.present({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }) ? repo.forCreator({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId, time.now) : null);
  if (!result.ok || result.value === null) return <Panel title="Brand updates"><StateBlock kind="unavailable" compact title="Brand updates are not available right now." body="This is not a finding that there are no brand conversations." /></Panel>;
  return <><CreatorUpdatesRefresh /><CreatorBrandUpdatesView rows={result.value} time={time} /></>;
}
