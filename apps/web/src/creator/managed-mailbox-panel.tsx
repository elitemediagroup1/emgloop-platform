import 'server-only';
import Link from 'next/link';
import type { GooglePrincipal, ManagedMailboxSummary } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { managedMailboxes } from '../google/google-runtime';
import { viewerTime } from '../time/viewer-time';
import { Panel } from '../app/app/_loop-os/record';
import {
  connectManagedMailboxAction,
  disconnectManagedMailboxAction,
} from './managed-mailbox-actions';

const OUTCOMES: Record<string, string> = {
  CONNECTED: 'Mailbox authorized. This source is saved separately from personal connections.',
  DISCONNECTED:
    'Loop’s stored credential was removed. Any pending connection attempts were invalidated.',
  DECLINED: 'Google authorization was declined.',
  NOT_ALLOWED: 'This action is not allowed for this manager, creator or mailbox assignment.',
  NOT_CONFIGURED: 'Google connections are not configured on this deployment.',
  INVALID_REQUEST: 'Enter the intended mailbox and confirm authorization.',
  STATE_INVALID: 'This connection attempt expired or belongs to another session. Start again.',
  WRONG_ACCOUNT:
    'Google returned a different account from the assigned address. Sign in to the exact mailbox shown.',
  SCOPE_REFUSED:
    'Google did not grant the requested read-only access, or returned broader permissions. No new credential was stored.',
  CONFLICT:
    'The mailbox assignment changed or is already associated with another source. Review it and start again.',
  FAILED: 'The connection could not finish. Check the deployment setup and try again.',
  TOO_MANY_ATTEMPTS:
    'Too many pending connection attempts. Wait ten minutes before starting again.',
};
function MailboxRow({
  row,
  profileId,
  time,
}: {
  row: ManagedMailboxSummary;
  profileId: string;
  time: TimeView;
}) {
  return (
    <li className="loop-stack">
      <strong>{row.expectedEmail}</strong>
      <p className="loop-note">
        {row.status === 'CONNECTED' ? 'Authorized' : row.status.toLowerCase().replace(/_/g, ' ')}
        {row.connectedAt ? ` · authorized ${time.dateTime(row.connectedAt)}` : ''}
        {row.lastFailureClass ? ' · needs manager attention' : ''}.
      </p>
      {row.status !== 'DISCONNECTED' ? (
        <form action={disconnectManagedMailboxAction}>
          <input type="hidden" name="mailboxId" value={row.id} />
          <input type="hidden" name="profileId" value={profileId} />
          <label>
            <input type="checkbox" name="confirmed" required /> Remove this source’s stored Google
            authorization from Loop.
          </label>
          <div className="loop-btnrow">
            <button className="loop-btn" type="submit">
              Disconnect mailbox
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export async function ManagedMailboxPanel({
  principal,
  profileId,
  outcome,
}: {
  principal: GooglePrincipal;
  profileId?: string;
  outcome?: string;
}) {
  const { service, configured } = managedMailboxes();
  if (!(await service.repository.permittedFor(principal, 'view'))) return null;
  const rows = await service.repository.inventory(principal, profileId ?? null);
  const expected = profileId ? await service.repository.creatorAddress(principal, profileId) : null;
  const canUpdate = await service.repository.permittedFor(principal, 'update');
  return (
    <ManagedMailboxPanelView
      rows={rows}
      profileId={profileId}
      expected={expected}
      configured={configured}
      canUpdate={canUpdate}
      outcome={outcome}
      time={viewerTime()}
    />
  );
}

export function ManagedMailboxPanelView({
  rows,
  profileId,
  expected,
  configured,
  canUpdate,
  outcome,
  time,
}: {
  rows: readonly ManagedMailboxSummary[] | null;
  profileId?: string;
  expected: string | null;
  configured: boolean;
  canUpdate: boolean;
  outcome?: string;
  time: TimeView;
}) {
  return (
    <section id="mailboxes">
      <Panel
        title={profileId ? 'Assigned creator Gmail' : 'Shared staff Gmail sources'}
        lead={
          profileId
            ? 'Connect this creator’s assigned mailbox from the manager side.'
            : 'Connect each staff mailbox once for the entire creator roster.'
        }
      >
        {outcome && Object.hasOwn(OUTCOMES, outcome) ? (
          <p role="status">{OUTCOMES[outcome]}</p>
        ) : null}
        {rows === null ? (
          <p className="loop-note">
            Managed mailbox connections are awaiting their database migration.
          </p>
        ) : (
          <>
            <p className="loop-note">
              {profileId ? (
                <>
                  Shared staff sources are configured once on the{' '}
                  <Link className="loop-link" href="/app/admin/creator-hub#mailboxes">
                    Creator Hub roster
                  </Link>
                  . Only this creator’s assigned address is connected here.
                </>
              ) : (
                'Use the staff mailboxes handling creator and brand communications. These sources apply across the roster; do not reconnect them for each creator.'
              )}
            </p>
            {rows.length ? (
              <ul className="loop-stack" style={{ listStyle: 'none', padding: 0 }}>
                {rows.slice(0, 100).map((row) => (
                  <MailboxRow key={row.id} row={row} profileId={profileId ?? ''} time={time} />
                ))}
              </ul>
            ) : (
              <p className="loop-note">
                No {profileId ? 'assigned creator' : 'shared staff'} mailbox has been authorized
                here yet.
              </p>
            )}
            {rows.length > 100 ? (
              <p className="loop-note">Only the first 100 sources are displayed.</p>
            ) : null}
            {!configured ? (
              <p className="loop-note">Google connections are not configured on this deployment.</p>
            ) : canUpdate && (!profileId || expected) ? (
              <form action={connectManagedMailboxAction} className="loop-stack">
                <input type="hidden" name="profileId" value={profileId ?? ''} />
                <label className="loop-field">
                  <span className="loop-label">
                    {profileId ? 'Assigned creator address' : 'Shared staff address'}
                  </span>
                  <input
                    className="loop-input"
                    name="email"
                    type="email"
                    maxLength={254}
                    required
                    defaultValue={expected ?? ''}
                    readOnly={!!profileId}
                  />
                </label>
                <label>
                  <input type="checkbox" name="confirmed" required /> I manage this mailbox and
                  authorize ongoing read-only access{' '}
                  {profileId
                    ? 'for this creator’s brand activity'
                    : 'as a shared source for creator brand activity across our roster'}
                  .
                </label>
                <p className="loop-note">
                  Sign in to the exact address above. Loop requests read-only Gmail access and
                  stores an encrypted refresh credential. This does not send email or connect
                  Calendar or Drive.
                </p>
                <div className="loop-btnrow">
                  <button className="loop-btn" type="submit">
                    Authorize mailbox with Google
                  </button>
                </div>
              </form>
            ) : profileId && !expected ? (
              <p className="loop-note">
                First save the creator’s assigned email under “Preload accounts and observed
                analytics” below.
              </p>
            ) : null}
            <p className="loop-note">
              Authorization is separate from capture. Select the authorized sources in the creator email
              pilot to enable background review and creator-safe brand summaries. Disconnect removes
              Loop’s credential and withdraws summaries that depend on this source; you can also
              remove the Google app grant from the mailbox’s Google Account settings.
            </p>
          </>
        )}
      </Panel>
    </section>
  );
}
