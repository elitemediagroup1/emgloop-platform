// Teams + Telegram connections: one panel on the person's Connections page.
//
// ONE TILE PER PROVIDER, HONEST STATE. Each tile shows the truthful ConnectionState the worker
// derived -- and authentication alone is never "Ready": a connection whose background observation
// is gated reads "Connected (limited)", stated plainly, not dressed up. With the default
// deployment nothing is configured, so each tile says exactly that and offers no Connect it cannot
// honour (principles 1-4: never fabricate, never fake, honest empty states).
//
// AN INTELLIGENCE SOURCE, NOT A CHAT CLIENT. Each tile carries the provider profile's plain
// sentence: Loop observes the source to surface what matters and points the person back to Teams/
// Telegram to reply. There is no composer, inbox or conversation browser here, by design.
//
// GOVERNED HISTORICAL BASELINE (Telegram). A live Telegram tile can import a bounded window of past
// history -- WHO/WHEN metadata only, never message content. The employee picks the depth from a closed
// allowlist (there is no all-time option); the sub-state, and any progress shown, trace to the
// checkpoint. The copy never says Loop reads conversations: it reads who and when.
//
// SERVER COMPONENT. Connect, disconnect and the baseline controls are server-action forms; no client
// code, and no value here is a secret, a code, or a provider's text.

import { SOURCE_CONNECTION_BASELINE_WINDOWS, SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS, type ConnectionActionOutcome, type ConnectionState, type SourceBaselineActionOutcome, type SourceContentActionOutcome, type TimeView } from '@emgloop/shared';
import type { ProviderConnectionView, SourceConnectionStatus } from '@emgloop/database';

import { beginConnectSourceAction, disconnectSourceAction, authorizeBaselineAction, changeBaselineScopeAction, revokeBaselineAction, authorizeContentAction, revokeContentAction } from '../../../connections/actions';
import { TelegramConnectFlow } from './telegram-connect-flow';
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

/** What each baseline outcome tells the person. Plain words; who/when only, never "reading your messages". */
export const BASELINE_OUTCOME_MESSAGES: Readonly<Record<SourceBaselineActionOutcome, { readonly tone: Tone; readonly title: string; readonly body: string }>> = {
  AUTHORIZED: { tone: 'good', title: 'Importing history', body: 'Loop will read who and when from your chosen window of past messages — metadata only, never their contents. You can change the window or stop it at any time.' },
  SCOPE_CHANGED: { tone: 'good', title: 'History window changed', body: 'Loop will use the new window for the who/when it imports. Nothing already recorded is changed.' },
  REVOKED: { tone: 'good', title: 'History import stopped', body: 'Loop will import no more history. What it already recorded is who/when only, and expires on the normal schedule.' },
  NOT_IMPORTING: { tone: 'warn', title: 'Not importing history', body: 'There was no history import to change. Loop keeps observing new messages going forward.' },
  NOT_PERMITTED: { tone: 'crit', title: 'You cannot do this here', body: 'Your role in this organization does not include changing a communication source.' },
  NOT_CONFIGURED: { tone: 'warn', title: 'Not available yet', body: 'This Loop deployment has not been set up to import history for this source yet.' },
  NO_CONNECTION: { tone: 'warn', title: 'Connect first', body: 'There is no live connection to import history from. Connect the account first.' },
  INVALID: { tone: 'warn', title: 'That request could not be used', body: 'Choose one of the offered windows and try again.' },
};

/** What each content-processing outcome tells the person. AI CONTENT processing is a separate consent. */
export const CONTENT_OUTCOME_MESSAGES: Readonly<Record<SourceContentActionOutcome, { readonly tone: Tone; readonly title: string; readonly body: string }>> = {
  AUTHORIZED: { tone: 'good', title: 'AI triage on', body: 'Loop will read your recent conversations — the last few days already imported — and new messages going forward, and use AI to flag the few things still needing you. It reads each message only for that moment and stores no message contents; the results are private to you on your Home, with a link back to Telegram. It never replies for you. You can turn it off at any time.' },
  REVOKED: { tone: 'good', title: 'AI triage off', body: 'Loop will stop processing message contents for this account. Anything it already flagged stays in your queue until you clear it, and no message contents were kept.' },
  NOTHING_TO_DO: { tone: 'warn', title: 'Nothing to change', body: 'AI triage was not on for this account.' },
  NOT_PERMITTED: { tone: 'crit', title: 'You cannot do this here', body: 'Your role in this organization does not include changing a communication source.' },
  NOT_CONFIGURED: { tone: 'warn', title: 'Not available yet', body: 'This Loop deployment has not been set up for AI triage on this source yet.' },
  NO_CONNECTION: { tone: 'warn', title: 'Connect first', body: 'There is no live connection to process content for. Connect the account first.' },
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

function BaselineBanner({ outcome }: { outcome: SourceBaselineActionOutcome }) {
  const message = BASELINE_OUTCOME_MESSAGES[outcome];
  return (
    <div className={`loop-banner loop-banner--${message.tone}`} role="status" data-baseline-outcome={outcome}>
      <div className="loop-banner__text">
        <div className="loop-banner__title">{message.title}</div>
        <div className="loop-banner__body">{message.body}</div>
      </div>
    </div>
  );
}

function ContentBanner({ outcome }: { outcome: SourceContentActionOutcome }) {
  const message = CONTENT_OUTCOME_MESSAGES[outcome];
  return (
    <div className={`loop-banner loop-banner--${message.tone}`} role="status" data-content-outcome={outcome}>
      <div className="loop-banner__text">
        <div className="loop-banner__title">{message.title}</div>
        <div className="loop-banner__body">{message.body}</div>
      </div>
    </div>
  );
}

/** The one honest sentence a baseline sub-state reads. Who/when only, never message content. */
export function baselinePresentation(view: ProviderConnectionView, time: TimeView): { readonly headline: string; readonly progress: string | null } {
  const days = view.baselineWindowDays;
  const reached = view.oldestReachedAt ? `Reached back to ${time.date(view.oldestReachedAt)} so far — who and when only.` : null;
  switch (view.baselineState) {
    case 'NOT_STARTED':
      return { headline: `History baseline queued: your last ${days} days — metadata only (who and when, never message contents).`, progress: null };
    case 'IN_PROGRESS':
      return { headline: `Reading your last ${days} days of history — metadata only (who and when, never message contents).`, progress: reached };
    case 'COMPLETE':
      return { headline: `History baseline: your last ${days} days — metadata only (who and when, never message contents).`, progress: reached };
    case 'REVOKED':
      return { headline: 'History import stopped. What Loop recorded is who/when only, and expires on the normal schedule.', progress: null };
    default:
      return { headline: 'Not importing history. Loop observes new messages going forward — who and when only.', progress: null };
  }
}

/** A depth chooser, submitting a server action. No content shown; the offered windows are bounded. */
function WindowSelect({ selected }: { selected: number }) {
  return (
    <select name="windowDays" defaultValue={String(selected)} aria-label="How far back to import (days)">
      {SOURCE_CONNECTION_BASELINE_WINDOWS.map((d) => (
        <option key={d} value={String(d)}>{`Last ${d} days`}</option>
      ))}
    </select>
  );
}

/**
 * The baseline controls for a LIVE Telegram tile. When there is no active baseline (none, or revoked),
 * it offers to import a bounded window; when one is active, it offers to change the window or stop it.
 * Every control is a server-action form -- the person and organization are the session's, never the form.
 */
function BaselineSection({ view, time }: { view: ProviderConnectionView; time: TimeView }) {
  // A baseline belongs only to a live, updatable Telegram tile. `canDisconnect` is exactly
  // "the person may update AND the connection is live", which is the gate a baseline needs.
  if (view.profile.provider !== 'TELEGRAM' || !view.canDisconnect || !view.profile.baseline) return null;
  const shown = baselinePresentation(view, time);
  const selected = view.baselineWindowDays ?? SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS;
  const active = view.baselineState === 'NOT_STARTED' || view.baselineState === 'IN_PROGRESS' || view.baselineState === 'COMPLETE';
  return (
    <div className="loop-stack" data-baseline-state={view.baselineState ?? 'NONE'}>
      <p data-baseline-detail>{shown.headline}</p>
      {shown.progress ? <p className="muted" data-baseline-progress>{shown.progress}</p> : null}
      <div className="loop-btnrow">
        {active ? (
          <>
            <form action={changeBaselineScopeAction} className="loop-btnrow">
              <input type="hidden" name="provider" value={view.profile.provider} />
              <WindowSelect selected={selected} />
              <button className="loop-btn" type="submit">Change window</button>
            </form>
            <form action={revokeBaselineAction}>
              <input type="hidden" name="provider" value={view.profile.provider} />
              <button className="loop-btn" type="submit">Stop importing history</button>
            </form>
          </>
        ) : (
          <form action={authorizeBaselineAction} className="loop-btnrow">
            <input type="hidden" name="provider" value={view.profile.provider} />
            <WindowSelect selected={selected} />
            <button className="loop-btn loop-btn--primary" type="submit">Import history</button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * The AI content-triage consent control for a LIVE Telegram tile. It authorizes Loop to process message
 * CONTENT with AI -- a SEPARATE consent from connecting and from the history baseline. Connecting alone
 * is NOT this consent. Every control is a server-action form; the person and organization are the
 * session's, never the form. The copy is honest: Loop reads content, uses AI, surfaces privately, never
 * replies, and keeps no message contents. v2: the one consent covers both the recent history already
 * imported and new messages going forward; both are read transiently and never stored.
 */
function ContentSection({ view }: { view: ProviderConnectionView }) {
  if (view.profile.provider !== 'TELEGRAM' || !view.canDisconnect) return null;
  const on = view.contentAuthorized;
  return (
    <div className="loop-stack" data-content-authorized={on ? 'yes' : 'no'}>
      <p data-content-detail>
        {on
          ? 'AI triage is on: Loop reads your recent conversations — the last few days already imported — and new messages going forward, flagging the few things still needing you, privately to you. It reads each message only for that moment, keeps no message contents, and never replies for you.'
          : 'Optional, and separate from connecting: let Loop use AI to read your recent conversations (the last few days already imported) and new messages going forward, and flag the few things still needing you. It reads each message only for that moment, keeps no message contents, surfaces the results privately to you, and never replies for you.'}
      </p>
      <div className="loop-btnrow">
        {on ? (
          <form action={revokeContentAction}>
            <input type="hidden" name="provider" value={view.profile.provider} />
            <button className="loop-btn" type="submit">Turn off AI triage</button>
          </form>
        ) : (
          <form action={authorizeContentAction}>
            <input type="hidden" name="provider" value={view.profile.provider} />
            <button className="loop-btn" type="submit">Turn on AI triage</button>
          </form>
        )}
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
        <BaselineSection view={view} time={time} />
        <ContentSection view={view} />
      </div>
      <div className="loop-btnrow">
        {view.canConnect && view.profile.provider === 'TELEGRAM' ? (
          <TelegramConnectFlow label={view.profile.label} />
        ) : view.canConnect ? (
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

export function SourceConnectionsPanel(props: { status: SourceConnectionStatus | null; outcome: ConnectionActionOutcome | null; baselineOutcome?: SourceBaselineActionOutcome | null; contentOutcome?: SourceContentActionOutcome | null; time: TimeView }) {
  const { status, outcome, baselineOutcome, contentOutcome, time } = props;

  // The status read failed (e.g. this deployment's web reached its database before the connections
  // migration did). Say so honestly and let the rest of the page render -- never crash the view.
  if (status === null) {
    return (
      <StateBlock
        kind="unavailable"
        title="Connections could not be loaded"
        body="Loop could not read your communication sources just now. The rest of the page still works; this section will appear once it is ready."
      />
    );
  }

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
      {baselineOutcome ? <BaselineBanner outcome={baselineOutcome} /> : null}
      {contentOutcome ? <ContentBanner outcome={contentOutcome} /> : null}

      {!anyConfigured ? (
        <StateBlock
          kind="unavailable"
          title="Communication sources are not available yet"
          body="This Loop deployment has not been set up to connect Microsoft Teams or Telegram. Nothing is connected, and Loop works without them."
        />
      ) : null}

      <Panel
        title="Microsoft Teams and Telegram"
        lead="Connect your own Teams or Telegram account as an intelligence source: Loop observes it to surface what matters and connect it with what it already knows. It is not a chat client — you reply in Teams or Telegram itself. Each account is your own, and you can disconnect at any time."
      >
        <div role="list" aria-label="Communication sources">
          {status.providers.map((view) => (
            <div role="listitem" key={view.profile.provider}>
              <ProviderTile view={view} time={time} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="How Loop uses this" lead="Loop is the system that understands what matters across your sources — not another place to chat.">
        <Facts
          rows={[
            { label: 'Observes', value: 'Loop watches this source to surface what matters and connect it with what it already knows.' },
            { label: 'Not a chat client', value: 'You read and reply in Teams or Telegram. When something needs a reply, Loop points you back to the conversation there.' },
            { label: 'History, metadata only', value: 'If you import history, Loop reads who a past conversation was with and when — never message contents — for a bounded window you choose, and you can stop it at any time.' },
            { label: 'Kept, and governed', value: 'Loop keeps the intelligence it derives, with a link back to where it came from. It minimizes and governs raw content — it never becomes a mirror or archive of your messages.' },
            { label: 'Private to you', value: 'These connections are yours alone; nothing here becomes organization-wide on its own.' },
          ]}
        />
      </Panel>
    </div>
  );
}
