// The creator sees only published, scoped paraphrases. No mailbox IDs, private subjects or citations
// leave the repository projection. Grouping by brand is presentation, not another model invocation.
import 'server-only';
import type { ReactNode } from 'react';
import { CreatorBrandMailRepository, prisma, type PublishedCreatorBrandUpdate } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { CreatorUpdatesRefresh } from './CreatorUpdatesRefresh';
import { creatorMailSharingEnabled } from './creator-mail-runtime';
import { type CreatorSeat } from './creator-runtime';
import { settle } from '../app/app/_home/settle';
import { managedCreatorMailRepository, creatorRelationshipService } from './creator-mail-runtime';
import { CreatorRefreshButton } from './CreatorRefreshButton';
const STAGES: Record<string, string> = { OUTREACH: 'Awaiting first reply', DISCUSSING: 'In discussion', AWAITING_EMG: 'Waiting on EMG', AWAITING_BRAND: 'Waiting on the brand', AWAITING_CREATOR: 'Needs you', NEGOTIATING: 'Negotiating', CONFIRMED: 'Confirmed', DECLINED: 'Did not go ahead', PAUSED: 'Paused' };
type BrandGroup = { brandId: string; brand: string; updates: PublishedCreatorBrandUpdate[] };
const BUCKETS = [
  { title: 'Outreach', stages: ['OUTREACH'], empty: 'No current unanswered outreach is shared yet.', description: 'Brands contacted on your behalf that have not yet given a substantive reply.' },
  { title: 'Conversations', stages: ['NEGOTIATING', 'DISCUSSING', 'AWAITING_EMG', 'AWAITING_BRAND', 'AWAITING_CREATOR'], empty: 'No current brand conversations are shared yet.', description: 'Two-way discussions with brands and agencies.' },
  { title: 'Active deals', stages: ['CONFIRMED'], empty: 'No current active deals are shared yet.', description: 'Agreed partnerships supported by an accepted brief or contract, or an approved partnership payable.' },
] as const;
function StageSymbol({ title }: { title: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {title === 'Outreach' ? <><path d="m21 3-7 18-4-7-7-4L21 3Z"/><path d="m10 14 6-6"/></>
      : title === 'Conversations' ? <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-5 3 1.5-5.5A7.5 7.5 0 1 1 20 11.5Z"/><path d="M8 11h8M8 8h5"/></>
      : <><rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a23 23 0 0 0 18 0M10 13h4v3h-4z"/></>}
  </svg>;
}
function Update({ update, time }: { update: PublishedCreatorBrandUpdate; time: TimeView }) {
  return <div className="loop-stack ch-brand-event" style={{ gap: 6, marginBottom: 16 }}>
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
  const ordered = [...group.updates].sort((a, b) =>
    (b.evidenceAt?.getTime() ?? 0) - (a.evidenceAt?.getTime() ?? 0) ||
    (b.generatedAt?.getTime() ?? 0) - (a.generatedAt?.getTime() ?? 0));
  const latest = ordered.find(u => u.synthesized && u.summary && u.stage) ?? ordered.find(u => u.summary && u.stage);
  const distinct = new Map<string, PublishedCreatorBrandUpdate>();
  for (const update of ordered) {
    // Cross-mailbox copies of a single accepted reading should not look like
    // independent brand conversations. Preserve distinct historical events.
    const identity = [update.evidenceAt?.toISOString() ?? '', update.stage ?? '', update.summary ?? ''].join('|');
    if (!distinct.has(identity)) distinct.set(identity, update);
  }
  return <details className="loop-card ch-brand-relationship"><summary><span className="ch-brand-name">{group.brand}</span>{latest ? <span className="ch-brand-status">{STAGES[latest.stage ?? ''] ?? 'Update'}{latest.current ? '' : ' · earlier'}</span> : null}</summary>
    {latest ? <div className="loop-stack ch-brand-position" style={{ gap: 6, marginBottom: 12 }}>
      <span className="loop-label">Latest known position · {STAGES[latest.stage ?? ''] ?? 'Update'}</span>
      <p>{latest.summary}</p>
      {latest.nextStep ? <p><strong>Next:</strong> {latest.nextStep}</p> : null}
      <p className="loop-note">{latest.synthesized ? 'Consolidated across accepted authorized conversations through' : 'Based on the most recent accepted source conversation,'} {latest.evidenceAt ? time.dateTime(latest.evidenceAt) : 'date unavailable'}. {latest.synthesized ? 'Updates when source evidence changes.' : 'Additional accepted correspondence can update this position.'}</p>
    </div> : null}
    <details><summary>Conversation history · {distinct.size} {distinct.size === 1 ? 'update' : 'updates'}</summary>
      {[...distinct.values()].map(update => <Update key={update.id} update={update} time={time} />)}
    </details>
  </details>;
}
export function CreatorBrandUpdatesView({ rows, time, sourceNote, actions, available = true }: { available?: boolean; rows: readonly PublishedCreatorBrandUpdate[]; time: TimeView; sourceNote?: string; actions?: ReactNode }) {
  const brands = new Map<string, BrandGroup>();
  for (const row of rows) {
    const group = brands.get(row.brandId) ?? { brandId: row.brandId, brand: row.brand, updates: [] };
    group.updates.push(row); brands.set(row.brandId, group);
  }
  // One current stage per canonical brand. Latest source activity wins, not input order or generation time.
  const latest = (group: BrandGroup) => {
    const synthesized = group.updates.find(u => u.synthesized);
    if (synthesized) return synthesized;
    const newest = [...group.updates].sort((a, b) => (b.evidenceAt?.getTime() ?? b.checkedAt?.getTime() ?? 0) - (a.evidenceAt?.getTime() ?? a.checkedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))[0];
    // The most recent evidence establishes the last known stage even when its check is stale.
    // Staleness remains visible on each update; do not erase historical outreach from counts.
    return newest?.summary && newest.stage ? newest : undefined;
  };
  const groups = [...brands.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.brandId.localeCompare(b.brandId));
  const other = groups.filter(g => !BUCKETS.some(b => (b.stages as readonly string[]).includes(latest(g)?.stage ?? '')));
  return <section className="loop-panel ch-brand-board" aria-label="Brand updates">
    <header className="ch-brand-board__head"><div><span className="ch-studio-section-label">Your partnership pipeline</span><h2 className="loop-panel__title">Brand updates</h2><p className="loop-panel__lead">From first hello to agreed partnership.</p></div>{actions}</header>
    <div className="ch-brand-grid">
      {BUCKETS.map(bucket => {
        const selected = groups.filter(g => (bucket.stages as readonly string[]).includes(latest(g)?.stage ?? ''));
        const needsYou = selected.filter(g => latest(g)?.stage === 'AWAITING_CREATOR').length;
        const waiting = selected.filter(g => latest(g)?.stage === 'AWAITING_BRAND').length;
        const count = selected.length;
        const recent = selected.map(g => ({ group: g, update: latest(g)! })).sort((a, b) => (b.update.evidenceAt?.getTime() ?? b.update.checkedAt?.getTime() ?? 0) - (a.update.evidenceAt?.getTime() ?? a.update.checkedAt?.getTime() ?? 0) || a.group.brandId.localeCompare(b.group.brandId))[0];
        return <section className="loop-card ch-brand-stage" key={bucket.title} aria-label={bucket.title} data-brand-stage={bucket.title}>
          <div className="ch-brand-stage__top"><span className="ch-brand-stage__symbol" aria-hidden="true"><StageSymbol title={bucket.title} /></span><span className={`ch-brand-stage__count${available ? '' : ' ch-brand-stage__count--unknown'}`} aria-hidden="true">{available ? count : 'Unavailable'}</span></div>
          <h3>{bucket.title}</h3>
          <p>{!available ? 'Brand updates are unavailable in this environment. Your saved activity has not been removed.' : count ? bucket.title === 'Outreach' ? `EMG has reached out to ${count} ${count === 1 ? 'brand' : 'brands'} awaiting a first reply.`
            : bucket.title === 'Conversations' ? `${count} ${count === 1 ? 'brand conversation is' : 'brand conversations are'} underway. ${waiting} waiting on the brand; ${needsYou} need you.`
            : `${count} ${count === 1 ? 'brand has' : 'brands have'} an agreed partnership underway.`
            : bucket.empty}</p>
          {!available ? null : recent ? <div className="ch-brand-glance">
            <span className="ch-brand-glance__label">{recent.update.current ? 'Latest development' : 'Latest known development'}</span>
            <strong>{recent.group.brand}</strong>
            <p>{recent.update.summary}</p>
            <span className="ch-brand-glance__date">{recent.update.evidenceAt ? time.date(recent.update.evidenceAt) : 'Source date unavailable'}{recent.update.current ? '' : ' · Awaiting updated review'}</span>
          </div> : <div className="ch-brand-glance ch-brand-glance--empty"><span className="ch-brand-glance__label">{bucket.title === 'Active deals' ? 'Built on an agreement' : 'Your next chapter'}</span><p>{bucket.title === 'Active deals' ? 'Accepted partnerships appear here once supported by a brief, contract or approved partnership payable.' : 'Your team’s accepted updates will appear here.'}</p></div>}
          {count ? <details className="ch-brand-expand"><summary>View {bucket.title.toLowerCase()} · {count} {count === 1 ? 'brand' : 'brands'}</summary>
            <p className="loop-note">{bucket.description} Open a brand for its summaries and next steps.</p>
            {selected.map(group => <Brand key={group.brandId} group={group} time={time} />)}
          </details> : null}
        </section>;
      })}
      {other.length ? <details className="ch-brand-archive"><summary>Earlier, paused or pending updates · {other.length} {other.length === 1 ? 'brand' : 'brands'}</summary>
        {other.map(group => <Brand key={group.brandId} group={group} time={time} />)}
      </details> : null}
    </div>
    <p className="loop-note ch-brand-caption">{available ? 'Counts reflect accepted, authorized conversations. Historical review may still be in progress.' : 'Counts and summaries cannot be loaded here. This does not mean no outreach or partnerships exist.'}</p>
    <details className="ch-brand-coverage"><summary>Coverage and privacy</summary><p className="loop-note">{sourceNote ?? 'Counts cover currently summarized, explicitly shared Gmail conversations only, not your entire outreach history. Managed capture is bounded and may omit older or unmatched threads.'} Each brand is counted once by its latest accepted stage; older readings are labeled and may no longer reflect the current relationship. An empty list does not mean no outreach has happened. AI interpretations can be wrong; private emails and internal commercial details are not shown.</p></details>
  </section>;
}
export async function CreatorBrandUpdates({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  if (!creatorMailSharingEnabled()) return <CreatorBrandUpdatesView rows={[]} time={time} available={false} />;
  const repo = new CreatorBrandMailRepository(prisma);
  const result = await settle(async () => await repo.present({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }) ? repo.forCreator({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId, time.now) : null);
  if (!result.ok || result.value === null) return <CreatorBrandUpdatesView rows={[]} time={time} available={false} />;
  const managed = await settle(() => managedCreatorMailRepository().updates({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId, time.now));
  const synthesized = await settle(() => creatorRelationshipService().projections({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId));
  return <><CreatorUpdatesRefresh />{!managed.ok ? <p className="loop-note">Managed mailbox updates could not be read. Counts may be incomplete.</p> : null}<CreatorBrandUpdatesView actions={<CreatorRefreshButton />} rows={[...result.value, ...(managed.ok ? managed.value : []), ...(synthesized.ok ? synthesized.value : [])]} time={time} sourceNote="Counts cover accepted explicit thread shares and analyzed managed-mailbox pilot conversations, not your entire outreach history. Accepted historical evidence is retained durably. Historical discovery continues in bounded pages; withheld or unprocessed conversations are excluded. Refresh runs daily at 7:00 a.m. Eastern and when requested." /></>;
}
