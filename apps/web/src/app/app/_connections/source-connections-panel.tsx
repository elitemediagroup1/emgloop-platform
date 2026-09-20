// Teams + Telegram connections: one panel on the person's Connections page.
//
// ONE TILE PER PROVIDER, HONEST STATE. Each tile shows the truthful ConnectionState the worker
// derived -- and authentication alone is never "Ready": a connection whose background observation
// is gated reads "Connected (limited)", stated plainly, not dressed up. With the default
// deployment nothing is configured, so each tile says exactly that and offers no Connect it cannot
// honour (principles 1-4: never fabricate, never fake, honest empty states).
//
// WHAT LOOP OBSERVES IS STATED BEFORE YOU CONNECT. Each tile carries the provider profile's plain
// sentence -- who you exchanged messages with and when, never message content -- so consent is
// informed, not implied.
//
// SERVER COMPONENT. Connect and disconnect are server-action forms; no client code, and no value
// here is a secret, a code, or a provider's text. The Teams adapter (personal vs work/school) is an
// internal detail and is never surfaced -- there is one "Microsoft Teams" tile.

import { type ConnectionActionOutcome, type ConnectionState, type TimeView } from '@emgloop/shared';
import type { ProviderConnectionView, SourceConnectionStatus } from '@emgloop/database';

import { beginConnectSourceAction, disconnectSourceAction } from '../../../connections/actions';
import type { SubjectState } from '../../../crm/subject-display';
import { Facts, Panel, StateBlock, StatePill } from '../_loop-os/record';

type Tone = 'good' | 'warn' | 'crit';

/** What each connect/disconnect outcome tells the person. Plain words; never a provider's text. */
export const CONNECTION_OUTCOME_MESSAGES: Readonly<Record<ConnectionActionOutcome, { readonly tone: Tone; readonly title: string; readonly body: string }>> = {
  STARTED: {
    tone: 'good',
    title: 'Connection started',
    body: 'Finish signing in to complete the connection. Loop begins observing only once sign-in is done, and shows what it observes below.',
  },
  ALREADY_CONNECTED: { tone: 'good', title: 'Already connected', body: 'This account is already connected. Disconnect it first if you want to connect a different one.' },
  DISCONNECTED: { tone: 'good', title: 'Disconnected', body: 'Loop deleted its access and stopped observing. Nothing already recorded in Loop is changed.' },
  NOTHING_TO_DO: { tone: 'warn', title: 'Nothing to disconnect', body: 'Loop had no live connection for you here.' },
  NOT_CONFIGURED: {
    tone: 'warn',
    title: 'Not available yet',
    body: 'This Loop deployment has not been set up to connect this source yet. Nothing is connected, and Loop works without it.',
  },
  NOT_PERMITTED: { tone: 'crit', title: 'You cannot connect this here', body: 'Your role in this organization does not include connecting a communication source.' },
  INVALID: { tone: 'warn', title: 'That request could not be used', body: 'Start again from this page.' },
};

/** One connection state's tile presentation. "Ready" is said ONLY when observation is operational. */
export function connectionPresentation(view: ProviderConnectionView, time: TimeView): { readonly pill: SubjectState; readonly detail: string | null } {
  const last = view.lastObservedAt ? time.relative(view.lastObservedAt) : null;
  const state: ConnectionState = view.state;
  switch (state) {
    case 'NOT_CONNECTED':
      return { pill: { label: 'Not connected', tone: 'neutral' }, detail: null };
    case 'CONNECTING':
      return { pill: { label: 'Connecting…', tone: 'attention' }, detail: 'Waiting for you to finish signing in. This continues in the app you are signing in to.' };
    case 'SETTING_UP':
      return { pill: { label: 'Setting up', tone: 'attention' }, detail: 'Loop is preparing the connection. This finishes in the background.' };
    case 'READY':
      return { pill: { label: 'Ready', tone: 'good' }, detail: last ? `Observing. Last checked ${last}.` : 'Observing.' };
    case 'CONNECTED_LIMITED':
      return {
        pill: { label: 'Connected (limited)', tone: 'attention' },
        detail: 'Signed in, but Loop cannot observe this source in the background right now. It is connected, not fully observing.',
      };
    case 'RECONNECT_REQUIRED':
      return { pill: { label: 'Reconnect required', tone: 'critical' }, detail: 'The account no longer accepts Loop’s access. Reconnect to continue observing.' };
    case 'FAILED':
      return { pill: { label: 'Problem', tone: 'critical' }, detail: 'Loop could not use this connection on its last try. You can try connecting again.' };
    case 'DISCONNECTED':
      return { pill: { label: 'Disconnected', tone: 'neutral' }, detail: null };
    default:
      return { pill: { label: 'Unknown', tone: 'neutral' }, detail: null };
  }
}

function connectLabel(view: ProviderConnectionView): string {
  return view.state === 'RECONNECT_REQUIRED' ? `Reconnect ${view.profile.label}` : view.state === 'FAILED' ? `Try ${view.profile.label} again` : `Connect ${view.profile.label}`;
}

function OutcomeBanner({ outcome }: { outcome: ConnectionActionOutcome }) {
  const message = CONNECTION_OUTCOME_MESSAGES[outcome];
  return (
    <div className={`loop-banner loop-banner--${message.tone}`} role="status" data-connection-outcome={outcome}>
      <div className="loop-banner__text">
        <div className="loop-banner__title">{message.title}</div>
        <div className="loop-banner__body">{message.body}</div>
      </div>
    </div>
  );
}

function ProviderTile({ view, time }: { view: ProviderConnectionView; time: TimeView }) {
  const shown = connectionPresentation(view, time);
  const live = view.canDisconnect;
  return (
    <div className="loop-row" data-provider={view.profile.provider} data-state={view.state} data-configured={view.configured ? 'yes' : 'no'}>
      <div className="grow">
        <p className="val">
          {view.profile.label} <StatePill state={shown.pill} />
        </p>
        {shown.detail ? <p data-connection-detail>{shown.detail}</p> : null}
        <p className="muted">{view.profile.observes}</p>
        {view.accountLabel && live ? <p className="muted">Account: {view.accountLabel}</p> : null}
        {view.connectedAt && live ? <p className="muted">Connected {time.dateTime(view.connectedAt)}.</p> : null}
        {!view.configured ? <p className="muted">This deployment cannot connect {view.profile.label} yet.</p> : null}
      </div>
      <div className="loop-btnrow">
        {view.canConnect ? (
          <form action={beginConnectSourceAction}>
            <input type="hidden" name="provider" value={view.profile.provider} />
            <button className="loop-btn loop-btn--primary" type="submit">
              {connectLabel(view)}
            </button>
          </form>
        ) : null}
        {view.canDisconnect ? (
          <form action={disconnectSourceAction}>
            <input type="hidden" name="provider" value={view.profile.provider} />
            <button className="loop-btn" type="submit">
              Disconnect {view.profile.label}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

export function SourceConnectionsPanel(props: { status: SourceConnectionStatus; outcome: ConnectionActionOutcome | null; time: TimeView }) {
  const { status, outcome, time } = props;

  if (!status.permitted) {
    return (
      <StateBlock
        kind="denied"
        title="You cannot connect communication sources here"
        body="Your role in this organization does not include connecting Microsoft Teams or Telegram."
      />
    );
  }

  const anyConfigured = status.providers.some((p) => p.configured);

  return (
    <div className="loop-stack" data-source-connections-panel>
      {outcome ? <OutcomeBanner outcome={outcome} /> : null}

      {!anyConfigured ? (
        <StateBlock
          kind="unavailable"
          title="Communication sources are not available yet"
          body="This Loop deployment has not been set up to connect Microsoft Teams or Telegram. Nothing is connected, and Loop works without them."
        />
      ) : null}

      <Panel
        title="Microsoft Teams and Telegram"
        lead="Connect your own Teams or Telegram account so Loop can see who you talk to and when — never what is said. Connecting is separate from signing in to Loop, each account is your own, and you can disconnect at any time."
      >
        <div role="list" aria-label="Communication sources">
          {status.providers.map((view) => (
            <div role="listitem" key={view.profile.provider}>
              <ProviderTile view={view} time={time} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="What Loop keeps" lead="For these sources Loop records who a message was between and when — metadata only. It never stores message text, titles, media or attachments, and it never sends this to an AI.">
        <Facts
          rows={[
            { label: 'Recorded', value: 'Who and when — contacts and timing of your conversations.' },
            { label: 'Never recorded', value: 'Message text, subjects, media, attachments or names of chats.' },
            { label: 'Private to you', value: 'These connections are yours alone; no one else in your organization sees them.' },
          ]}
        />
      </Panel>
    </div>
  );
}
