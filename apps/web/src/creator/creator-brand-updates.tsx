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
const STAGES: Record<string, string> = { OUTREACH: 'Awaiting first reply', DISCUSSING: 'In discussion', AWAITING_EMG: 'Waiting on EMG', AWAITING_BRAND: 'Waiting on the brand', AWAITING_CREATOR: 'Needs you', NEGOTIATING: 'Negotiating', CONFIRMED: 'Confirmed', DECLINED: 'Did not go ahead', PAUSED: 'Paused' };
type BrandGroup = { brandId: string; brand: string; updates: PublishedCreatorBrandUpdate[] };
const BUCKETS = [
  { title: 'Outreach', stages: ['OUTREACH'], empty: 'No current unanswered outreach is shared yet.', description: 'Brands contacted on your behalf that have not yet given a substantive reply.' },
  { title: 'Conversations', stages: ['DISCUSSING', 'AWAITING_EMG', 'AWAITING_BRAND', 'AWAITING_CREATOR'], empty: 'No current brand conversations are shared yet.', description: 'Two-way discussions with brands and agencies.' },
  { title: 'Active deals', stages: ['NEGOTIATING', 'CONFIRMED'], empty: 'No current active deals are shared yet.', description: 'Specific partnerships being negotiated or confirmed.' },
] as const;
function Update({ update, time }: { update: PublishedCreatorBrandUpdate; time: TimeView }) {
  return <div className="loop-stack" style={{ gap: 6, marginBottom: 16 }}>
    {update.summary ? <>
      <span className="loop-label">{STAGES[update.stage ?? ''] ?? 'Update'}{update.current ? '' : ' · earlier reading'}</span>
      <p>{update.summary}</p>
      {update.nextStep ? <p><strong>Next:</strong> {update.nextStep}</p> : null}
      <p className="loop-note">AI summary {update.generatedAt ? time.relative(update.generatedAt) : 'time unavailable'}. Source conversation through {update.evidenceAt ? time.dateTime(update.evidenceAt) : 'an unknown time'}.</p>
    </> : <p className="loop-note">This conversation is linked. A shareable summary is not available yet.</p>}
    <p className="loop-note">{update.checkedAt ? `Last checked ${time.relative(update.checkedAt)}.` : 'Awaiting first check.'} {!update.current ? 'A current reading is pending; do not treat this as live status.' : ''}</p>
  </div>;
}
function Brand({ group, time }: { group: BrandGroup; time: TimeView }) {
  return <details className="loop-card"><summary>{group.brand}</summary>
    {group.updates.map(update => <Update key={update.id} update={update} time={time} />)}
  </details>;
}
export function CreatorBrandUpdatesView({ rows, time }: { rows: readonly PublishedCreatorBrandUpdate[]; time: TimeView }) {
  const brands = new Map<string, BrandGroup>();
  for (const row of rows) {
    const group = brands.get(row.brandId) ?? { brandId: row.brandId, brand: row.brand, updates: [] };
    group.updates.push(row); brands.set(row.brandId, group);
  }
  // One current stage per canonical brand. Latest source activity wins, not input order or generation time.
  const latest = (group: BrandGroup) => {
    const newest = [...group.updates].sort((a, b) => (b.evidenceAt?.getTime() ?? b.checkedAt?.getTime() ?? 0) - (a.evidenceAt?.getTime() ?? a.checkedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))[0];
    return newest?.current && newest.summary && newest.stage ? newest : undefined;
  };
  const groups = [...brands.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.brandId.localeCompare(b.brandId));
  const other = groups.filter(g => !BUCKETS.some(b => (b.stages as readonly string[]).includes(latest(g)?.stage ?? '')));
  return <Panel title="Brand updates" lead="Your outreach, conversations and active deals at a glance.">
    <div className="loop-stack">
      {BUCKETS.map(bucket => {
        const selected = groups.filter(g => (bucket.stages as readonly string[]).includes(latest(g)?.stage ?? ''));
        const needsYou = selected.filter(g => latest(g)?.stage === 'AWAITING_CREATOR').length;
        const waiting = selected.filter(g => latest(g)?.stage === 'AWAITING_BRAND').length;
        const negotiating = selected.filter(g => latest(g)?.stage === 'NEGOTIATING').length;
        const count = selected.length;
        return <section className="loop-card" key={bucket.title} aria-label={bucket.title}>
          <h3>{bucket.title}</h3>
          <p>{count ? bucket.title === 'Outreach' ? `EMG has reached out to ${count} ${count === 1 ? 'brand' : 'brands'} awaiting a first reply.`
            : bucket.title === 'Conversations' ? `${count} ${count === 1 ? 'brand conversation is' : 'brand conversations are'} underway. ${waiting} waiting on the brand; ${needsYou} need you.`
            : `${count} ${count === 1 ? 'brand has' : 'brands have'} an active partnership discussion: ${negotiating} negotiating, ${count - negotiating} confirmed.`
            : bucket.empty}</p>
          {count ? <details><summary>View {bucket.title.toLowerCase()} · {count} {count === 1 ? 'brand' : 'brands'}</summary>
            <p className="loop-note">{bucket.description} Open a brand for its summaries and next steps.</p>
            {selected.map(group => <Brand key={group.brandId} group={group} time={time} />)}
          </details> : null}
        </section>;
      })}
      {other.length ? <details><summary>Earlier, paused or pending updates · {other.length} {other.length === 1 ? 'brand' : 'brands'}</summary>
        {other.map(group => <Brand key={group.brandId} group={group} time={time} />)}
      </details> : null}
    </div>
    <p className="loop-note">Counts cover currently summarized, explicitly shared Gmail conversations only, not your entire outreach history. This view includes up to 100 shared threads. Each brand is counted once in its latest stage. An empty list does not mean no outreach has happened. AI interpretations can be wrong; private emails and internal commercial details are not shown.</p>
  </Panel>;
}
export async function CreatorBrandUpdates({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  if (!creatorMailSharingEnabled()) return null;
  const repo = new CreatorBrandMailRepository(prisma);
  const result = await settle(async () => await repo.present({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }) ? repo.forCreator({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId, time.now) : null);
  if (!result.ok || result.value === null) return <Panel title="Brand updates"><StateBlock kind="unavailable" compact title="Brand updates are not available right now." body="This is not a finding that there are no brand conversations." /></Panel>;
  return <><CreatorUpdatesRefresh /><CreatorBrandUpdatesView rows={result.value} time={time} /></>;
}
