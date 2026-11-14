import { requireSession } from '../../../../auth/guard';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../../_loop-os/record';
import { ttoMediaRepository, ttoMediaService } from '../../../../tiktok-business/runtime';
import { profileTtoHandle } from '@emgloop/database';
import { selectTtoSource, refreshTtoCreator } from '../../../../tiktok-business/actions';
import { businessPrincipal, businessRepository } from '../../../../tiktok-business/runtime';
import { readBusinessEnvironment, BUSINESS_CALLBACKS } from '../../../../tiktok-business/environment';
import { connectTto, connectBusinessCreator, disconnectTto, disconnectBusinessCreator } from '../../../../tiktok-business/actions';
import { businessAuthorized, prisma } from '@emgloop/database';
export const dynamic = 'force-dynamic';
const messages: Record<string, string> = {
  CONNECTED: 'Authorization saved securely. Public creator imports can now use your agency’s authorized TikTok One account.',
  SOURCE_SELECTED: 'TikTok One source selected. Creator imports will run automatically.',
  SYNCED: 'Creator content updated from TikTok One.',
  NOT_DUE: 'An update is already pending or this creator was checked recently.',
  IMPORT_UNAVAILABLE: 'TikTok did not provide a usable public creator report. Check marketplace availability and API permissions.',
  DISCONNECTED: 'Loop deleted this connection and its pending attempts. You can also remove EMG Loop in TikTok’s authorization settings; provider revocation has not been confirmed.',
  STATE_INVALID: 'This attempt expired, was already used, or belongs to another signed-in session. Start again here.',
  DECLINED: 'Authorization was declined. Nothing was connected.',
  WITHDRAWN: 'Access changed during authorization or this account is already assigned. Disconnect before switching accounts.',
  INVALID_REQUEST: 'TikTok did not return a usable authorization code. Start again here.',
  NOT_READY: 'Configuration, migration or authorization is not ready. Ask an administrator to check setup.',
  NOT_CONFIGURED: 'The Business API app is not configured on this deployment.',
  FAILED: 'Authorization could not be completed. Nothing from this attempt was published.',
};
export default async function BusinessTikTokPage({ searchParams }: { searchParams?: { outcome?: string } }) {
  const session = await requireSession();
  const p = await businessPrincipal();
  const kind = session.systemRole === 'CREATOR' ? 'CREATOR' : 'TTO';
  const permitted = p ? await businessAuthorized(prisma, p, kind) : null;
  let status: Awaited<ReturnType<ReturnType<typeof businessRepository>['status']>> = null;
  let migrated = false;
  if (permitted && p) { try { status = await businessRepository().status(p, kind); migrated = true; } catch { /* honest unavailable state */ } }
  let accounts: string[] = [];
  let roster: Awaited<ReturnType<ReturnType<typeof ttoMediaRepository>['roster']>> = [];
  let importsReady = false;
  if(permitted && p && kind==='TTO') { try { roster=await ttoMediaRepository().roster(p); importsReady=true; if(status?.status==='CONNECTED')accounts=await ttoMediaService().choices(p); } catch { /* no secret or provider body is rendered */ } }
  const configured = !!readBusinessEnvironment(kind);
  const connected = status?.status === 'CONNECTED' && (!status.expiresAt || +status.expiresAt > Date.now());
  return <WorkspaceShell session={session}><LoopPage label="TikTok One"><PageHead trail={[{ label: 'Home', href: '/app' }, { label: 'TikTok One' }]} title="TikTok One connection" subtitle={kind === 'TTO' ? 'Connect your agency’s TikTok One authorization.' : 'Authorize your own TikTok creator account.'} />
    {searchParams?.outcome && messages[searchParams.outcome] ? <p role="status">{messages[searchParams.outcome]}</p> : null}
    {!permitted ? <p>Your account cannot manage this connection.</p> : <section className="loop-card">
      <h2>{kind === 'TTO' ? 'Agency authorization' : 'Creator authorization'}</h2>
      <p>{!migrated ? 'Database setup is pending.' : connected ? 'Authorization connected.' : status?.status === 'CONNECTED' ? 'Authorization expired. Reconnect to continue.' : 'Not connected.'}</p>
      {!configured ? <p>TikTok app approval and server configuration are still required.</p> : null}
      {configured && migrated && !connected ? <form action={kind === 'TTO' ? connectTto : connectBusinessCreator}><button type="submit">Authorize with TikTok</button></form> : null}
      {status?.status === 'CONNECTED' ? <form action={kind === 'TTO' ? disconnectTto : disconnectBusinessCreator}><button type="submit">Disconnect from Loop</button></form> : null}
      {kind==='TTO' && connected ? <><h3>Creator content imports</h3><p>Public TikTok profile, video thumbnails and metrics refresh automatically. Creators must have an exact TikTok handle in their Loop profile and be available in TikTok One’s marketplace. No additional creator login is needed for this public data.</p>{!importsReady?<p>Content import database setup is pending.</p>:null}{accounts.length>0?<form action={selectTtoSource}><label>TikTok One source <select name="accountId" required>{accounts.map(id=><option key={id} value={id}>{id}</option>)}</select></label><button type="submit">Use this source</button></form>:<p>Authorized marketplace accounts are unavailable. Check the approved public insights permissions.</p>}{importsReady?<ul className="ch-list">{roster.map(row=><li key={row.id}><strong>{row.displayName}</strong><p>{profileTtoHandle(row.preferences)?`@${profileTtoHandle(row.preferences)}`:'Add a TikTok handle in their profile'} · {row.ttoSnapshot?.lastReadAt?'Public report saved':'No public report saved'}{row.ttoSnapshot?.lastFailure?` · ${row.ttoSnapshot.lastFailure}`:''}</p><form action={refreshTtoCreator}><input type="hidden" name="profileId" value={row.id}/><button type="submit">Update content</button></form></li>)}</ul>:null}</>:null}
      <p>This setup does not publish posts, create ads, send invitations or manage payments.</p>
      {kind === 'TTO' ? <><h3>App registration callback paths</h3><p>Advertiser: <code>{BUSINESS_CALLBACKS.TTO}</code></p><p>TikTok account holder: <code>{BUSINESS_CALLBACKS.CREATOR}</code></p></> : null}
    </section>}
  </LoopPage></WorkspaceShell>;
}
