import { requireSession } from '../../../../auth/guard';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../../_loop-os/record';
import { businessPrincipal, businessRepository } from '../../../../tiktok-business/runtime';
import { readBusinessEnvironment, BUSINESS_CALLBACKS } from '../../../../tiktok-business/environment';
import { connectTto, connectBusinessCreator, disconnectTto, disconnectBusinessCreator } from '../../../../tiktok-business/actions';
import { businessAuthorized, prisma } from '@emgloop/database';
export const dynamic = 'force-dynamic';
const messages: Record<string, string> = {
  CONNECTED: 'Authorization saved securely. Content import and analytics synchronization are not enabled by this connection setup.',
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
  const configured = !!readBusinessEnvironment(kind);
  const connected = status?.status === 'CONNECTED' && (!status.expiresAt || +status.expiresAt > Date.now());
  return <WorkspaceShell session={session}><LoopPage label="TikTok One"><PageHead trail={[{ label: 'Home', href: '/app' }, { label: 'TikTok One' }]} title="TikTok One connection" subtitle={kind === 'TTO' ? 'Connect your agency’s TikTok One authorization.' : 'Authorize your own TikTok creator account.'} />
    {searchParams?.outcome && messages[searchParams.outcome] ? <p role="status">{messages[searchParams.outcome]}</p> : null}
    {!permitted ? <p>Your account cannot manage this connection.</p> : <section className="loop-card">
      <h2>{kind === 'TTO' ? 'Agency authorization' : 'Creator authorization'}</h2>
      <p>{!migrated ? 'Database setup is pending.' : connected ? 'Authorization connected. No content has been imported through this connection.' : status?.status === 'CONNECTED' ? 'Authorization expired. Reconnect to continue.' : 'Not connected.'}</p>
      {!configured ? <p>TikTok app approval and server configuration are still required.</p> : null}
      {configured && migrated && !connected ? <form action={kind === 'TTO' ? connectTto : connectBusinessCreator}><button type="submit">Authorize with TikTok</button></form> : null}
      {status?.status === 'CONNECTED' ? <form action={kind === 'TTO' ? disconnectTto : disconnectBusinessCreator}><button type="submit">Disconnect from Loop</button></form> : null}
      <p>This setup does not publish posts, create ads, send invitations or manage payments.</p>
      {kind === 'TTO' ? <><h3>App registration callback paths</h3><p>Advertiser: <code>{BUSINESS_CALLBACKS.TTO}</code></p><p>TikTok account holder: <code>{BUSINESS_CALLBACKS.CREATOR}</code></p></> : null}
    </section>}
  </LoopPage></WorkspaceShell>;
}
