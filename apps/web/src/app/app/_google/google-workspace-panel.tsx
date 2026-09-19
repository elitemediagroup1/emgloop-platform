// Google Workspace connection: the one panel, used by employee onboarding and by the
// person's Connections page (google-workspace-connection.md §2, §11).
//
// HONEST STATE, PER CAPABILITY. Gmail, Calendar and Drive each show where they stand --
// connected, not connected, access not allowed, or expired -- read from what Google
// actually granted, never from what Loop asked for.
//
// EACH CAPABILITY IS ITS OWN ACT. "Connect" is a plain link to the connect route for that
// capability alone, so Google's consent screen names exactly one kind of access. Plain
// anchors, not router links: a prefetch must never start a consent attempt.
//
// SERVER COMPONENT. Disconnect and remove are server-action forms; no client code, and no
// value here is a token, a code or Google's text.

import {
  GOOGLE_WORKSPACE_CAPABILITIES,
  GOOGLE_WORKSPACE_CAPABILITY_LABELS,
  GOOGLE_WORKSPACE_CAPABILITY_READS,
  type GoogleCapabilityState,
  type GoogleConnectOutcome,
  type GoogleConnectReturnTarget,
  type GoogleWorkspaceCapability,
  type TimeView,
} from '@emgloop/shared';
import type { GoogleWorkspaceStatus } from '@emgloop/database';

import { LOOP_HOME } from '../../../auth/landing';
import { disconnectGoogleAction, removeGoogleCapabilityAction } from '../../../google/actions';
import type { SubjectState } from '../../../crm/subject-display';
import { Facts, Panel, StateBlock, StatePill } from '../_loop-os/record';

const CONNECT_ROUTE = '/api/integrations/google/connect';

type Tone = 'good' | 'warn' | 'crit';

/** What each outcome tells the person. Plain words; never Google's text. */
export const GOOGLE_OUTCOME_MESSAGES: Readonly<Record<GoogleConnectOutcome, { readonly tone: Tone; readonly title: string; readonly body: string }>> = {
  CONNECTED: { tone: 'good', title: 'Access granted', body: 'Google confirmed the access you approved.' },
  PARTIAL: { tone: 'warn', title: 'Some access was not allowed', body: 'Google did not grant everything that was asked. The list below shows exactly what Loop can use; you can allow the rest at any time.' },
  ALREADY_CONNECTED: { tone: 'good', title: 'Already connected', body: 'Loop already has that access.' },
  DECLINED: { tone: 'warn', title: 'Nothing was connected', body: 'You did not allow access on Google’s screen, so Loop stored nothing.' },
  DIFFERENT_ACCOUNT: { tone: 'crit', title: 'That is a different Google account', body: 'Loop is connected to another Google account for you. Disconnect it first to switch accounts. Nothing was changed.' },
  ACCOUNT_IN_USE: { tone: 'crit', title: 'That Google account is already in use', body: 'Another person in this organization has connected that Google account. Each person connects their own account. Nothing was changed.' },
  DOMAIN_NOT_ALLOWED: { tone: 'crit', title: 'That Google account is not allowed here', body: 'Your organization only allows Google accounts from its approved Workspace domains. Nothing was stored.' },
  EMAIL_UNVERIFIED: { tone: 'crit', title: 'Google has not verified that account', body: 'The Google account’s email address is not verified, so Loop stored nothing.' },
  UNEXPECTED_SCOPE: { tone: 'crit', title: 'Google returned access Loop does not use', body: 'The grant included more than Loop asks for, so Loop refused it and stored nothing. You can review Loop’s access in your Google Account.' },
  STATE_INVALID: { tone: 'warn', title: 'That connection attempt is no longer valid', body: 'It expired, was already used, or was started in another session. Start again from this page.' },
  TOO_MANY_ATTEMPTS: { tone: 'warn', title: 'Too many unfinished attempts', body: 'Finish or wait out the attempts already open (ten minutes), then try again.' },
  NOT_CONFIGURED: { tone: 'warn', title: 'Google connections are not available yet', body: 'This Loop deployment has not been set up to connect Google accounts.' },
  NOT_PERMITTED: { tone: 'crit', title: 'You cannot connect Google here', body: 'Your role in this organization does not include connecting a Google account.' },
  INVALID_REQUEST: { tone: 'warn', title: 'That request could not be used', body: 'Start again from this page.' },
  FAILED: { tone: 'crit', title: 'Google could not complete the connection', body: 'Nothing was stored. Try again in a moment.' },
  DISCONNECTED: { tone: 'good', title: 'Google access removed', body: 'Loop deleted its access, and Google confirmed the revocation (or there was nothing left to revoke).' },
  DISCONNECTED_UNCONFIRMED: { tone: 'warn', title: 'Loop’s access is deleted', body: 'Google did not confirm the revocation, or another Loop connection still uses this Google account. Loop no longer holds your access; you can also remove Loop in your Google Account under third-party access.' },
  NOT_CONNECTED: { tone: 'warn', title: 'Nothing to disconnect', body: 'Loop has no live Google connection for you.' },
};

const STATE_PILLS: Readonly<Record<GoogleCapabilityState, SubjectState>> = {
  CONNECTED: { label: 'Connected', tone: 'good' },
  NOT_CONNECTED: { label: 'Not connected', tone: 'neutral' },
  INSUFFICIENT_SCOPE: { label: 'Access not allowed', tone: 'attention' },
  EXPIRED: { label: 'Expired — reconnect', tone: 'critical' },
};

function connectHref(capabilities: readonly GoogleWorkspaceCapability[], mode: GoogleConnectReturnTarget): string {
  const params = new URLSearchParams();
  params.set('capability', capabilities.join(','));
  if (mode === 'ONBOARDING') params.set('return', 'onboarding');
  return `${CONNECT_ROUTE}?${params.toString()}`;
}

function connectLabel(capability: GoogleWorkspaceCapability, state: GoogleCapabilityState): string {
  const name = GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability];
  if (state === 'INSUFFICIENT_SCOPE') return `Allow ${name}`;
  if (state === 'EXPIRED') return `Reconnect ${name}`;
  return `Connect ${name}`;
}

function OutcomeBanner({ outcome }: { outcome: GoogleConnectOutcome }) {
  const message = GOOGLE_OUTCOME_MESSAGES[outcome];
  return (
    <div className={`loop-banner loop-banner--${message.tone}`} role="status" data-google-outcome={outcome}>
      <div className="loop-banner__text">
        <div className="loop-banner__title">{message.title}</div>
        <div className="loop-banner__body">{message.body}</div>
      </div>
    </div>
  );
}

export function GoogleWorkspacePanel(props: {
  mode: GoogleConnectReturnTarget;
  status: GoogleWorkspaceStatus;
  outcome: GoogleConnectOutcome | null;
  /** Capabilities the person kept after removing one, offered for a fresh approval. */
  reconnect: readonly GoogleWorkspaceCapability[];
  time: TimeView;
}) {
  const { mode, status, outcome, reconnect, time } = props;
  const connection = status.connection;
  const live = connection !== null && connection.status !== 'REVOKED';
  const actionable = status.configured && status.canConnect;
  const allConnected = GOOGLE_WORKSPACE_CAPABILITIES.every((c) => status.capabilities[c] === 'CONNECTED');
  const offerReconnect = actionable && reconnect.length > 0 && !live;

  return (
    <div className="loop-stack" data-google-panel={mode}>
      {outcome ? <OutcomeBanner outcome={outcome} /> : null}

      {!status.configured ? (
        <StateBlock
          kind="unavailable"
          title="Google connections are not available yet"
          body="This Loop deployment has not been set up to connect Google accounts. Nothing is connected, and Loop works without it."
        />
      ) : null}
      {status.configured && !status.canConnect ? (
        <StateBlock kind="denied" title="You cannot connect Google here" body="Your role in this organization does not include connecting a Google account." />
      ) : null}

      {offerReconnect ? (
        <StateBlock
          kind="attention"
          title="Approve the access you kept"
          body={`Google cannot remove one kind of access on its own, so Loop revoked the whole grant. Approve ${reconnect
            .map((c) => GOOGLE_WORKSPACE_CAPABILITY_LABELS[c])
            .join(' and ')} again to keep using ${reconnect.length === 1 ? 'it' : 'them'}.`}
        />
      ) : null}
      {offerReconnect ? (
        <p className="loop-btnrow">
          <a className="loop-btn loop-btn--primary" href={connectHref(reconnect, mode)} rel="nofollow">
            Continue to Google
          </a>
        </p>
      ) : null}

      <Panel
        title="Your Google account"
        lead="Connecting is separate from signing in to Loop. Each kind of access below is its own approval on Google’s screen, and you can remove it at any time."
      >
        {connection && live ? (
          <Facts
            rows={[
              { label: 'Account', value: connection.email },
              { label: 'Workspace', value: connection.hostedDomain ?? 'Personal Google account (no Workspace domain)' },
              { label: 'Connected', value: time.dateTime(connection.connectedAt) },
              {
                label: 'Status',
                value: connection.status === 'EXPIRED' ? 'Google no longer accepts this connection. Reconnect to continue.' : 'Connected',
              },
            ]}
          />
        ) : (
          <p className="loop-panel__lead">No Google account is connected. Loop works fully without one.</p>
        )}
      </Panel>

      <Panel title="Access" lead="Each connection below says what Loop reads. Loop sends mail only when you press Send, and never changes or deletes anything in your Google account.">
        <div role="list" aria-label="Google access by kind">
          {GOOGLE_WORKSPACE_CAPABILITIES.map((capability) => {
            const state = status.capabilities[capability];
            return (
              <div role="listitem" key={capability} className="loop-row" data-capability={capability} data-state={state}>
                <div className="grow">
                  <p className="val">
                    {GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability]} <StatePill state={STATE_PILLS[state]} />
                  </p>
                  <p className="muted">{GOOGLE_WORKSPACE_CAPABILITY_READS[capability]}</p>
                </div>
                {actionable ? (
                  <div className="loop-btnrow">
                    {state !== 'CONNECTED' ? (
                      <a className="loop-btn loop-btn--primary" href={connectHref([capability], mode)} rel="nofollow">
                        {connectLabel(capability, state)}
                      </a>
                    ) : mode === 'CONNECTIONS' ? (
                      <form action={removeGoogleCapabilityAction}>
                        <input type="hidden" name="capability" value={capability} />
                        <input type="hidden" name="return" value={mode} />
                        <button className="loop-btn" type="submit">
                          Remove {GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability]}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Panel>

      {mode === 'CONNECTIONS' && live && status.canConnect ? (
        <Panel title="Disconnect Google" lead="Loop deletes its copy of your access and asks Google to revoke it. Nothing already recorded in Loop is changed.">
          <form action={disconnectGoogleAction}>
            <input type="hidden" name="return" value={mode} />
            <button className="loop-btn" type="submit">
              Disconnect Google
            </button>
          </form>
        </Panel>
      ) : null}

      {mode === 'ONBOARDING' ? (
        <div className="loop-btnrow" data-onboarding-continue>
          <a className={'loop-btn' + (allConnected ? ' loop-btn--primary' : '')} href={LOOP_HOME}>
            {allConnected ? 'Continue to Loop' : 'Skip for now'}
          </a>
          {allConnected ? null : (
            <span className="loop-panel__lead">You can connect Google later from Connections. Loop works without it.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
