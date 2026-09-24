// The creator's TikTok connection, on their Profile page (Creator Hub).
//
// HONEST STATE. The row says exactly where the connection stands (not configured here, not
// connected, connected, partly connected, reconnect required) and, once connected, shows only
// what TikTok actually returned on the last completed read: the counts, when they were read,
// and up to ten recent public videos as listed. A count that was not returned is "not read",
// never zero. A read that failed this visit says so and never pretends the shown counts are new.
//
// CONNECT IS A PLAIN LINK to the connect route -- a plain anchor, not a router link, so a
// prefetch can never start a consent attempt. SERVER COMPONENT: Disconnect is a server-action
// form; no client code, and no value here is a token, a code or TikTok's text.

import {
  TIKTOK_SCOPES,
  TIKTOK_SCOPE_LABELS,
  TIKTOK_SCOPE_READS,
  isTikTokConnectOutcome,
  type TikTokConnectOutcome,
  type TikTokConnectionState,
  type TikTokScope,
  type TimeView,
} from '@emgloop/shared';
import type { TikTokRefusal, TikTokStatus } from '@emgloop/database';

import { disconnectTikTokAction } from '../../../../tiktok/actions';
import { Facts, StateBlock } from '../../_loop-os/record';
import { Pill, compactNumber, type Tone } from './vocabulary';

export const TIKTOK_CONNECT_ROUTE = '/api/integrations/tiktok/connect';

type BannerTone = 'good' | 'warn' | 'crit';

/** What each outcome tells the creator. Plain words; never TikTok's text. */
export const TIKTOK_OUTCOME_MESSAGES: Readonly<Record<TikTokConnectOutcome, { readonly tone: BannerTone; readonly title: string; readonly body: string }>> = {
  CONNECTED: { tone: 'good', title: 'TikTok connected', body: 'TikTok confirmed the access you approved. Your counts and recent public videos are shown below as TikTok reported them.' },
  PARTIAL: { tone: 'warn', title: 'TikTok connected, with some access not allowed', body: 'You did not allow everything on TikTok’s screen. The row below shows exactly what Loop can read; you can allow the rest at any time.' },
  ALREADY_CONNECTED: { tone: 'good', title: 'Already connected', body: 'Loop already has that access.' },
  DECLINED: { tone: 'warn', title: 'Nothing was connected', body: 'You did not allow access on TikTok’s screen, so Loop stored nothing.' },
  DIFFERENT_ACCOUNT: { tone: 'crit', title: 'That is a different TikTok account', body: 'Loop is connected to another TikTok account for you. Disconnect it first to switch accounts. Nothing was changed.' },
  ACCOUNT_IN_USE: { tone: 'crit', title: 'That TikTok account is already connected to someone else', body: 'Another creator in this organization has connected that TikTok account. Each creator connects their own. Nothing was changed.' },
  UNEXPECTED_SCOPE: { tone: 'crit', title: 'TikTok returned access Loop does not use', body: 'The grant included more than Loop asks for, so Loop refused it and stored nothing. You can review Loop’s access in your TikTok settings under Security and permissions, Apps and services.' },
  STATE_INVALID: { tone: 'warn', title: 'That connection attempt is no longer valid', body: 'It expired, was already used, or was started in another session. Start again from this page.' },
  TOO_MANY_ATTEMPTS: { tone: 'warn', title: 'Too many unfinished attempts', body: 'Finish or wait out the attempts already open (ten minutes), then try again.' },
  NOT_CONFIGURED: { tone: 'warn', title: 'TikTok connections are not available yet', body: 'This Loop deployment has not been set up to connect TikTok accounts.' },
  NOT_PERMITTED: { tone: 'crit', title: 'You cannot connect TikTok here', body: 'A TikTok account is connected to a creator profile, and this login is not bound to one.' },
  INVALID_REQUEST: { tone: 'warn', title: 'That request could not be used', body: 'Start again from this page.' },
  FAILED: { tone: 'crit', title: 'TikTok could not complete the connection', body: 'Nothing was stored. Try again in a moment.' },
  DISCONNECTED: { tone: 'good', title: 'TikTok access removed', body: 'Loop deleted its access and TikTok confirmed the revocation (or there was nothing left to revoke). The counts and videos read under it are no longer shown.' },
  DISCONNECTED_UNCONFIRMED: { tone: 'warn', title: 'Loop’s access is deleted', body: 'TikTok did not confirm the revocation, or another Loop connection still uses this TikTok account. Loop no longer holds your access; you can also remove Loop in your TikTok settings under Security and permissions, Apps and services.' },
  NOT_CONNECTED: { tone: 'warn', title: 'Nothing to disconnect', body: 'Loop has no live TikTok connection for you.' },
};

/** The outcome a redirect carried back to the page. Presentation only: an unknown value is ignored. */
export function tiktokOutcomeParam(value: string | string[] | undefined): TikTokConnectOutcome | null {
  return typeof value === 'string' && isTikTokConnectOutcome(value) ? value : null;
}

/** The profile's stored TikTok entry, read defensively. Only what Loop wrote is shown; nothing is invented. */
export interface TikTokEntryView {
  readonly handle: string | null;
  readonly profileUrl: string | null;
  readonly seeded: boolean;
  readonly readAt: Date | null;
  readonly stats: { readonly followers: number | null; readonly following: number | null; readonly likes: number | null; readonly videos: number | null } | null;
  readonly recentVideos: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly shareUrl: string | null;
    readonly createdAt: Date | null;
    readonly viewCount: number | null;
    readonly likeCount: number | null;
  }[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const when = (v: unknown): Date | null => {
  const text = str(v);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
};
const httpsUrl = (v: unknown): string | null => {
  const text = str(v);
  return text && /^https:\/\//.test(text) ? text : null;
};

export function readTikTokEntry(raw: unknown): TikTokEntryView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const stats = r.stats && typeof r.stats === 'object' && !Array.isArray(r.stats) ? (r.stats as Record<string, unknown>) : null;
  const videos = Array.isArray(r.recentVideos) ? r.recentVideos : [];
  return {
    handle: str(r.handle)?.replace(/^@+/, '') ?? null,
    profileUrl: httpsUrl(r.profileUrl),
    seeded: r.state === 'SEEDED_DEMO',
    readAt: when(r.readAt),
    stats: stats ? { followers: num(stats.followers), following: num(stats.following), likes: num(stats.likes), videos: num(stats.videos) } : null,
    recentVideos: videos
      .map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null))
      .filter((v): v is Record<string, unknown> => v !== null && typeof v.id === 'string')
      .map((v) => ({ id: v.id as string, title: str(v.title), shareUrl: httpsUrl(v.shareUrl), createdAt: when(v.createdAt), viewCount: num(v.viewCount), likeCount: num(v.likeCount) })),
  };
}

const STATE_PILL: Readonly<Record<TikTokConnectionState, { readonly tone: Tone; readonly label: string }>> = {
  NOT_CONFIGURED: { tone: 'neutral', label: 'Unavailable' },
  NOT_CONNECTED: { tone: 'neutral', label: 'Not connected' },
  CONNECTED: { tone: 'good', label: 'Connected' },
  PARTIAL: { tone: 'attention', label: 'Partly connected' },
  EXPIRED: { tone: 'attention', label: 'Reconnect required' },
};

function OutcomeBanner({ outcome }: { outcome: TikTokConnectOutcome }) {
  const message = TIKTOK_OUTCOME_MESSAGES[outcome];
  return (
    <div className={`loop-banner loop-banner--${message.tone}`} role="status" data-tiktok-outcome={outcome}>
      <div className="loop-banner__text">
        <div className="loop-banner__title">{message.title}</div>
        <div className="loop-banner__body">{message.body}</div>
      </div>
    </div>
  );
}

function ConnectLink({ label }: { label: string }) {
  return (
    <a className="loop-btn loop-btn--primary" href={TIKTOK_CONNECT_ROUTE} rel="nofollow">
      {label}
    </a>
  );
}

/** What this visit's read said, when it did not complete. Null: it completed, or none was attempted. */
export type TikTokReadProblem = Extract<TikTokRefusal, 'UNAVAILABLE' | 'INSUFFICIENT_SCOPE'> | 'READ_FAILED' | null;

export function TikTokConnectionRow(props: {
  status: TikTokStatus | { readonly permitted: false };
  entry: TikTokEntryView | null;
  outcome: TikTokConnectOutcome | null;
  readProblem: TikTokReadProblem;
  time: TimeView;
}) {
  const { status, entry, outcome, readProblem, time } = props;
  if (!status.permitted) {
    return <StateBlock kind="denied" compact title="TikTok cannot be connected here" body="A TikTok account is connected to a creator profile, and this login is not bound to one." />;
  }
  const state = status.state;
  const connection = status.connection;
  const live = state === 'CONNECTED' || state === 'PARTIAL';
  const handle = connection?.handle ?? entry?.handle ?? null;
  const missing: readonly TikTokScope[] = connection?.missingScopes ?? [];
  const connectLabel = state === 'PARTIAL' ? 'Allow the rest' : state === 'EXPIRED' ? 'Reconnect TikTok' : 'Connect TikTok';
  const pill = STATE_PILL[state];

  return (
    <div className="loop-stack" data-tiktok-panel data-tiktok-state={state}>
      {outcome ? <OutcomeBanner outcome={outcome} /> : null}

      <div className="ch-row ch-row--static" data-social-state={state}>
        <span className="ch-row__main">
          <span className="ch-row__title">
            TikTok
            <Pill tone={pill.tone} small>
              {pill.label}
            </Pill>
          </span>
          <span className="ch-row__meta">
            {handle ? (entry?.profileUrl && live ? <a href={entry.profileUrl} rel="noreferrer noopener">@{handle}</a> : `@${handle}`) : 'No handle recorded'}
            {!live && entry?.seeded ? ' · listed by EMG as demo data' : ''}
            {state === 'EXPIRED' ? ' · TikTok no longer accepts Loop’s access, so nothing is read until you reconnect' : ''}
          </span>
        </span>
        <span className="ch-row__side">
          {state === 'NOT_CONFIGURED' ? (
            <span className="loop-btn" role="link" aria-disabled="true" title="TikTok connections are not set up on this deployment">
              Connect TikTok<span className="loop-sr-only">. TikTok connections are not set up on this deployment</span>
            </span>
          ) : state === 'CONNECTED' ? null : (
            <ConnectLink label={connectLabel} />
          )}
        </span>
      </div>

      {state === 'NOT_CONNECTED' || state === 'EXPIRED' ? (
        <div className="loop-panel__lead" data-tiktok-consent>
          <p className="loop-note">Connecting lets Loop read, from your own TikTok account only:</p>
          <ul className="loop-note" style={{ margin: '6px 0 0 18px' }}>
            {TIKTOK_SCOPES.map((scope) => (
              <li key={scope}>
                <strong>{TIKTOK_SCOPE_LABELS[scope]}.</strong> {TIKTOK_SCOPE_READS[scope]}
              </li>
            ))}
          </ul>
          <p className="loop-note" style={{ marginTop: 6 }}>
            Loop never posts to TikTok and never reads private videos. How this data is handled is in the <a href="/privacy">Privacy Policy</a>.
          </p>
        </div>
      ) : null}

      {live ? (
        <>
          {missing.length > 0 ? (
            <StateBlock
              kind="attention"
              compact
              title="Some access was not allowed on TikTok’s screen"
              body={`Loop cannot read: ${missing.map((s) => TIKTOK_SCOPE_LABELS[s]).join(', ')}. Choose Allow the rest and tick every box to complete the connection.`}
            />
          ) : null}
          {readProblem === 'UNAVAILABLE' || readProblem === 'READ_FAILED' ? (
            <StateBlock kind="error" compact title="Loop could not read your TikTok account just now" body={entry?.readAt ? `What is shown is from the last completed read, ${time.relative(entry.readAt)}. Loop tries again on your next visit.` : 'Nothing has been read yet. Loop tries again on your next visit.'} />
          ) : readProblem === 'INSUFFICIENT_SCOPE' ? (
            <StateBlock kind="attention" compact title="TikTok refused a read" body="TikTok no longer allows part of the access you granted. Choose Reconnect and tick every box." action={{ label: 'Reconnect TikTok', href: null, reason: 'Use the Allow the rest link above' }} />
          ) : null}

          <Facts
            rows={[
              { label: 'Followers', value: entry?.stats?.followers != null ? compactNumber(entry.stats.followers) : null, unknownText: connection?.grantedScopes.includes('user.info.stats') ? 'Not read yet' : 'Not allowed' },
              { label: 'Following', value: entry?.stats?.following != null ? compactNumber(entry.stats.following) : null, unknownText: connection?.grantedScopes.includes('user.info.stats') ? 'Not read yet' : 'Not allowed' },
              { label: 'Likes', value: entry?.stats?.likes != null ? compactNumber(entry.stats.likes) : null, unknownText: connection?.grantedScopes.includes('user.info.stats') ? 'Not read yet' : 'Not allowed' },
              { label: 'Videos', value: entry?.stats?.videos != null ? compactNumber(entry.stats.videos) : null, unknownText: connection?.grantedScopes.includes('user.info.stats') ? 'Not read yet' : 'Not allowed' },
              { label: 'Last read', value: entry?.readAt ? time.relative(entry.readAt) : null, unknownText: 'Not read yet' },
            ]}
          />

          {connection?.grantedScopes.includes('video.list') ? (
            entry && entry.recentVideos.length > 0 ? (
              <div>
                <p className="ch-h">Recent public videos, as listed</p>
                <ul className="ch-list" aria-label="Recent public videos">
                  {entry.recentVideos.map((v) => (
                    <li key={v.id} className="ch-row ch-row--static" data-tiktok-video={v.id}>
                      <span className="ch-row__main">
                        <span className="ch-row__title">{v.shareUrl ? <a href={v.shareUrl} rel="noreferrer noopener">{v.title ?? 'Untitled video'}</a> : (v.title ?? 'Untitled video')}</span>
                        <span className="ch-row__meta">
                          {v.createdAt ? `Posted ${time.date(v.createdAt)}` : 'Posting date not reported'}
                          {v.viewCount !== null ? ` · ${compactNumber(v.viewCount)} views` : ''}
                          {v.likeCount !== null ? ` · ${compactNumber(v.likeCount)} likes` : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <StateBlock kind="empty" compact title="No public videos listed." body={entry?.readAt ? 'TikTok returned no public videos on the last read.' : 'Videos appear here after the first read.'} />
            )
          ) : null}

          <form action={disconnectTikTokAction}>
            <p className="loop-note" style={{ marginBottom: 8 }}>
              Disconnecting deletes Loop’s copy of your access and asks TikTok to revoke it. The counts and videos read under it are removed from your profile.
            </p>
            <button className="loop-btn" type="submit">
              Disconnect TikTok
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
