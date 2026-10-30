import 'server-only';
import Link from 'next/link';
import { PartyReadModelRepository, prisma, repositories } from '@emgloop/database';
import type { WorkPrincipal } from '@emgloop/database';
import { creatorDomain } from './creator-runtime';
import { creatorMailRepository, creatorMailSharingEnabled } from './creator-mail-runtime';
import { shareCreatorMailAction, withdrawCreatorMailAction } from './creator-mail-actions';
import { Panel, StateBlock } from '../app/app/_loop-os/record';
import { viewerTime } from '../time/viewer-time';

const OUTCOMES: Record<string, string> = {
  SHARED: 'This thread is authorized for automatic creator updates. Its first summary is awaiting refresh.',
  WITHDRAWN: 'Sharing is withdrawn. Its stored creator summary is removed.',
  NOT_ALLOWED: 'Sharing is not enabled for your seat or this deployment.',
  NOT_FOUND: 'Loop could not find those records in your workspace.',
  CONSENT_REQUIRED: 'Your own Gmail content authorization and explicit sharing confirmation are required.',
  RECIPIENT_REQUIRED: 'Bind an active Creator login to this profile before sharing.',
  SCOPE_CONFLICT: 'This thread is already shared under a different scope. Withdraw it before changing the creator or brand.',
};
export async function CreatorMailSharing({ principal, threadId, outcome }: { principal: WorkPrincipal; threadId: string; outcome?: string }) {
  if (!creatorMailSharingEnabled()) return null;
  const canSeePeople = await repositories.iam.can({ ...principal, resource: 'identityResolution', action: 'view' });
  if (!canSeePeople) return null;
  const repo = creatorMailRepository();
  if (!(await repo.present(principal))) return <Panel title="Creator updates"><StateBlock kind="unavailable" compact title="Creator updates are awaiting the database migration." body="No mail is shared yet." /></Panel>;
  const [existing, profiles, firstBrands] = await Promise.all([
    repo.ownerThread(principal, threadId), creatorDomain().creator.listProfiles(principal.organizationId),
    new PartyReadModelRepository(prisma).listEstablished(principal.organizationId, 'COMPANY', { limit: 100 }),
  ]);
  const brands = { items: [...firstBrands.items], nextCursor: firstBrands.nextCursor };
  for (let page = 1; brands.nextCursor && page < 10; page++) {
    const next = await new PartyReadModelRepository(prisma).listEstablished(principal.organizationId, 'COMPANY', { limit: 100, cursor: brands.nextCursor });
    brands.items.push(...next.items); brands.nextCursor = next.nextCursor;
  }
  const ready = profiles.filter(p => p.userId);
  const time = viewerTime();
  return <Panel title="Share a creator update" lead="Publish a short brand update to one creator. Your mailbox and raw messages stay private.">
    {outcome && Object.hasOwn(OUTCOMES, outcome) ? <p role="status" className="loop-note">{OUTCOMES[outcome]}</p> : null}
    {existing ? <>
      <p className="loop-note">Shared with {profiles.find(p => p.id === existing.creatorProfileId)?.displayName ?? 'the linked creator'}. {existing.checkedAt ? `Last checked ${time.relative(existing.checkedAt)}.` : 'Awaiting first read.'} {existing.lastFailureClass ? 'The latest summary is unavailable; no private output is shown.' : ''}</p>
      <form action={withdrawCreatorMailAction}>
        <input type="hidden" name="threadId" value={threadId} /><input type="hidden" name="shareId" value={existing.id} />
        <button className="loop-btn" type="submit">Stop sharing and remove summary</button>
      </form>
    </> : ready.length && brands.items.length ? <form action={shareCreatorMailAction} className="loop-stack">
      <input type="hidden" name="threadId" value={threadId} />
      <label className="loop-field"><span className="loop-label">Creator</span><select className="loop-select" name="creatorProfileId" required defaultValue=""><option value="" disabled>Select a creator</option>{ready.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
      <label className="loop-field"><span className="loop-label">Brand or agency</span><select className="loop-select" name="brandPartyId" required defaultValue=""><option value="" disabled>Select a brand or agency</option>{brands.items.map(b => <option key={b.partyId} value={b.partyId}>{b.displayName ?? 'Unnamed company'}</option>)}</select></label>
      {brands.nextCursor ? <p className="loop-note">The first 1,000 companies are listed. Other companies must be selected through a narrower list before sharing.</p> : null}
      <label><input type="checkbox" name="confirmed" required /> I authorize automatic summaries of this specific thread for this creator. It concerns only this creator and brand; internal-only or mixed-creator threads must not be shared.</label>
      <p className="loop-note">Summaries omit prices, commissions, private contact details and internal assessments. AI can make mistakes; withdraw this share if the discussion changes scope.</p>
      <button className="loop-btn loop-btn--primary" type="submit">Enable automatic updates for this thread</button>
    </form> : <p className="loop-note">Add a creator with a bound login and an established brand or agency before sharing. <Link href="/app/admin/creator-hub">Open Creator Hub</Link>.</p>}
  </Panel>;
}
