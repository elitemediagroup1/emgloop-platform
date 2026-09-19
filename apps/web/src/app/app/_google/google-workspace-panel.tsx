// Google Workspace connection: the one panel, used by employee onboarding and by the
// person's Connections page (google-workspace-connection.md §2, §11).
//
// HONEST STATE, PER CAPABILITY. CONNECTED IS NOT READY. What Google granted says Loop MAY read a
// source; only a completed read says Loop HAS. So Gmail and Calendar show their readiness
// (@emgloop/shared `sourceReadiness`): setting up, ready with when Loop last read it, reading,
// could not read, permission needed, or reconnect required. Drive is authorized but unused --
// nothing reads it -- so it says exactly that and offers no Connect (GOOGLE_WORKSPACE_CAPABILITY_IN_USE).
//
// EACH CAPABILITY IS ITS OWN ACT. "Connect" is a plain link to the connect route for that
// capability alone, so Google's consent screen names exactly one kind of access. Plain
// anchors, not router links: a prefetch must never start a consent attempt.
//
// SERVER COMPONENT. Disconnect and remove are server-action forms; no client code, and no
// value here is a token, a code or Google's text.

import {
  GOOGLE_WORKSPACE_CAPABILITIES,
  GOOGLE_WORKSPACE_CAPABILITIES_IN_USE,
  GOOGLE_WORKSPACE_CAPABILITY_IN_USE,
  GOOGLE_WORKSPACE_CAPABILITY_LABELS,
  GOOGLE_WORKSPACE_CAPABILITY_READS,
  type GoogleCapabilityState,
  type SourceReadiness,
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
  CONNECTED: { tone: 'good', title: 'Access granted', body: 'Google confirmed the access you approved. Each source below says whether Loop has read it yet.' },
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

/** What Loop has read from one source, for the person who connected it (daily-loop/source-state). */
export interface GoogleSourceView {
  readonly readiness: SourceReadiness;
  readonly lastReadAt: Date | null;
}

const SOURCE_NOUN: Readonly<Record<GoogleWorkspaceCapability, string>> = { gmail: 'mail', calendar: 'calendar', drive: 'Drive' };

type RowAction = 'CONNECT' | 'ALLOW' | 'RECONNECT' | 'REMOVE' | null;

/**
 * One capability's row: the pill, the one line under it, and the one thing the person can do.
 *
 * "Ready" is said ONLY for a source Loop has read. A grant with no completed read is "Setting up",
 * never "Connected" -- that word is what made a person conclude Loop was using their mail when it
 * had read none of it.
 */
export function capabilityPresentation(
  capability: GoogleWorkspaceCapability,
  state: GoogleCapabilityState,
  source: GoogleSourceView | undefined,
  time: TimeView,
): { readonly pill: SubjectState; readonly detail: string | null; readonly action: RowAction } {
  const noun = SOURCE_NOUN[capability];
  const name = GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability];
  if (!GOOGLE_WORKSPACE_CAPABILITY_IN_USE[capability]) {
    // Authorized, perhaps, but nothing reads it: its description says so. Keep a person's earlier
    // authorization removable; never offer to create one.
    // Granted (CONNECTED, or EXPIRED since) is an authorization the person can remove. Never granted
    // (not connected, or asked for and refused) is simply not in use.
    return state === 'CONNECTED' || state === 'EXPIRED'
      ? { pill: { label: 'Authorized · not used', tone: 'neutral' }, detail: null, action: 'REMOVE' }
      : { pill: { label: 'Not in use yet', tone: 'neutral' }, detail: null, action: null };
  }
  if (state === 'NOT_CONNECTED') return { pill: { label: 'Not connected', tone: 'neutral' }, detail: null, action: 'CONNECT' };
  if (state === 'INSUFFICIENT_SCOPE') {
    return {
      pill: { label: 'Permission needed', tone: 'attention' },
      detail:
        capability === 'gmail'
          ? 'Google did not grant everything Gmail needs. Loop needs permission to read your mail and to send the replies you write. Choose Allow Gmail and tick every box on Google’s screen.'
          : `Google did not grant ${name} access. Choose Allow ${name} and tick the box on Google’s screen.`,
      action: 'ALLOW',
    };
  }
  if (state === 'EXPIRED') {
    return {
      pill: { label: 'Reconnect required', tone: 'critical' },
      detail: `Google no longer accepts Loop’s access, so Loop cannot read your ${noun}. Reconnect to continue.`,
      action: 'RECONNECT',
    };
  }
  if (!source) {
    // Connected, but Loop could not check what it has read. Say so; never guess "ready".
    return { pill: { label: 'Connected', tone: 'neutral' }, detail: `Loop could not check what it has read from your ${noun} just now.`, action: 'REMOVE' };
  }
  const last = source.lastReadAt ? time.relative(source.lastReadAt) : null;
  switch (source.readiness) {
    case 'READY':
      return { pill: { label: 'Ready', tone: 'good' }, detail: last ? `Last read ${last}.` : null, action: 'REMOVE' };
    case 'READING':
      return { pill: { label: 'Reading', tone: 'neutral' }, detail: `Loop is reading your ${noun} now.${last ? ` Last read ${last}.` : ''}`, action: 'REMOVE' };
    case 'SYNC_FAILED':
      return {
        pill: { label: 'Could not read', tone: 'critical' },
        detail: last
          ? `Loop could not read your ${noun} on its last try. It last read it ${last}, and tries again automatically.`
          : `Loop’s first read of your ${noun} did not finish. It tries again in the background.`,
        action: 'REMOVE',
      };
    case 'NOT_CONFIGURED':
      // The grant is stored, but this deployment cannot use it. Never "setting up": nothing is.
      return { pill: { label: 'Unavailable', tone: 'neutral' }, detail: 'This Loop deployment cannot read Google right now.', action: null };
    case 'INITIALIZING':
      return {
        pill: { label: 'Setting up', tone: 'attention' },
        detail:
          capability === 'gmail'
            ? 'Loop is reading your mail for the first time, in the background. It appears in Mail once that first read is done.'
            : 'Loop reads your calendar for the first time the next time you open Home, or in the background.',
        action: 'REMOVE',
      };
    default:
      // A readiness that contradicts the grant (not connected, permission needed, reconnect) cannot
      // come from the same status. Say Loop could not check, rather than guess.
      return { pill: { label: 'Connected', tone: 'neutral' }, detail: `Loop could not check what it has read from your ${noun} just now.`, action: 'REMOVE' };
  }
}

function connectHref(capabilities: readonly GoogleWorkspaceCapability[], mode: GoogleConnectReturnTarget): string {
  const params = new URLSearchParams();
  params.set('capability', capabilities.join(','));
  if (mode === 'ONBOARDING') params.set('return', 'onboarding');
  return `${CONNECT_ROUTE}?${params.toString()}`;
}

function connectLabel(capability: GoogleWorkspaceCapability, action: Exclude<RowAction, 'REMOVE' | null>): string {
  const name = GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability];
  if (action === 'ALLOW') return `Allow ${name}`;
  if (action === 'RECONNECT') return `Reconnect ${name}`;
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
  /** What Loop has read from each source it uses. Absent for a source: treated as not read yet. */
  sources?: Partial<Record<GoogleWorkspaceCapability, GoogleSourceView>>;
  time: TimeView;
}) {
  const { mode, status, outcome, time } = props;
  // A capability Loop does not use is never re-offered: approving it again would only re-grant
  // something nothing reads.
  const reconnect = props.reconnect.filter((c) => GOOGLE_WORKSPACE_CAPABILITY_IN_USE[c]);
  const connection = status.connection;
  const live = connection !== null && connection.status !== 'REVOKED';
  const actionable = status.configured && status.canConnect;
  const allConnected = GOOGLE_WORKSPACE_CAPABILITIES_IN_USE.every((c) => status.capabilities[c] === 'CONNECTED');
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
                value:
                  connection.status === 'EXPIRED'
                    ? 'Google no longer accepts this connection. Reconnect to continue.'
                    : 'Linked. What Loop has read from it is shown under Access.',
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
            const shown = capabilityPresentation(capability, state, props.sources?.[capability], time);
            return (
              <div
                role="listitem"
                key={capability}
                className="loop-row"
                data-capability={capability}
                data-state={state}
                data-readiness={GOOGLE_WORKSPACE_CAPABILITY_IN_USE[capability] ? (props.sources?.[capability]?.readiness ?? 'UNKNOWN') : 'NOT_IN_USE'}
              >
                <div className="grow">
                  <p className="val">
                    {GOOGLE_WORKSPACE_CAPABILITY_LABELS[capability]} <StatePill state={shown.pill} />
                  </p>
                  {shown.detail ? <p data-readiness-detail>{shown.detail}</p> : null}
                  <p className="muted">{GOOGLE_WORKSPACE_CAPABILITY_READS[capability]}</p>
                </div>
                {actionable && shown.action ? (
                  <div className="loop-btnrow">
                    {shown.action !== 'REMOVE' ? (
                      <a className="loop-btn loop-btn--primary" href={connectHref([capability], mode)} rel="nofollow">
                        {connectLabel(capability, shown.action)}
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
