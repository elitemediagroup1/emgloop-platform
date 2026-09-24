// The TikTok Login Kit connection lifecycle, for a managed creator's own account.
//
// THE PERSON IS ALWAYS THE SIGNED SESSION'S. Every method takes the principal the web tier
// resolved from the session cookie -- organization, user and session id -- and nothing from
// the request decides whose connection is touched.
//
// THE AUTHORITY IS THE CREATOR SEAT. A creator holds no organization permission, so every
// method asks the creator port whether a CreatorProfile binds this login here. No profile,
// no connection: the refusal is NOT_PERMITTED and nothing is stored.
//
// CONNECTING IS AN EXPLICIT, DECLINABLE ACT. `beginConnect` asks TikTok for the four
// registered scopes; what TikTok GRANTED -- never what Loop asked for -- is what gets stored,
// and a narrower grant reads PARTIAL.
//
// NOTHING SECRET LEAVES. Both tokens are sealed before they reach the repository and opened
// only to call TikTok; the refresh token ROTATES on every refresh and the returned one is
// what is kept. Outcomes are codes from @emgloop/shared, never TikTok's text.
//
// A READ IS BOUNDED. A visit spends a TikTok call only when the last completed read is older
// than TIKTOK_READ_MIN_INTERVAL_MS; what it returns is merged into the creator's profile and,
// for the follower count, recorded as an audience observation from the platform.
//
// TikTok, the sealer, the creator port, the clock and randomness are injected: the web tier
// wires the real ones (apps/web/src/tiktok/tiktok-runtime.ts); tests wire doubles.

import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { TikTokReadFailure, TikTokRevokeResult, TikTokTokenResult, TikTokVideoListResult } from '@emgloop/providers';
import {
  TIKTOK_DISCONNECTED_PATCH,
  TIKTOK_READ_MIN_INTERVAL_MS,
  TIKTOK_SCOPES,
  TIKTOK_VIDEO_LIST_MAX,
  TIKTOK_VIDEO_TITLE_MAX_CHARS,
  parseTikTokGrantedScopes,
  tiktokConnectionState,
  tiktokMissingScopes,
  type TikTokAudienceStats,
  type TikTokConnectOutcome,
  type TikTokConnectionState,
  type TikTokConnectionStatus,
  type TikTokRevocationReason,
  type TikTokScope,
  type TikTokSocialAccountEntry,
  type TikTokUserInfo,
  type TikTokVideoSummary,
} from '@emgloop/shared';

import {
  TikTokConnectionRepository,
  type TikTokActor,
  type TikTokConnectionRecord,
  type TikTokRevocation,
  type TikTokSealedCredential,
} from '../../repositories/tiktok-connection.repository';
import { TikTokTokenUnopenable, type TikTokTokenSealer } from './tiktok-token-sealer';

export interface TikTokPrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly name?: string | null;
}

export interface TikTokSessionPrincipal extends TikTokPrincipal {
  /** The id of the signed session row the request arrived in. */
  readonly sessionId: string;
}

/** TikTok, as the service needs it. The web tier binds client key, secret and redirect URI. */
export interface TikTokOAuthPort {
  authorizationUrl(request: { readonly scopes: readonly string[]; readonly state: string }): string;
  exchangeCode(code: string): Promise<TikTokTokenResult>;
  refresh(refreshToken: string): Promise<TikTokTokenResult>;
  revoke(accessToken: string): Promise<TikTokRevokeResult>;
  userInfo(accessToken: string, grantedScopes: readonly string[]): Promise<{ readonly ok: true; readonly user: TikTokUserInfo } | { readonly ok: false; readonly failure: TikTokReadFailure }>;
  videoList(accessToken: string, maxCount: number): Promise<{ readonly ok: true; readonly page: TikTokVideoListResult } | { readonly ok: false; readonly failure: TikTokReadFailure }>;
}

export type TikTokSocialAccountPatch = Partial<TikTokSocialAccountEntry> & { readonly platform: 'TIKTOK' };

/** The creator seat, as the connection needs it (services/tiktok/tiktok-creator-port.ts binds the real one). */
export interface TikTokCreatorPort {
  /** The creator profile bound to this login in this organization, or null: the whole authorization. */
  seatOf(principal: TikTokPrincipal): Promise<{ readonly creatorProfileId: string } | null>;
  /** Merge (never replace) the TikTok entry of the profile's social accounts. */
  mergeSocialAccount(organizationId: string, creatorProfileId: string, patch: TikTokSocialAccountPatch): Promise<void>;
  /** A follower count read from the platform, as an audience observation. */
  recordAudience(organizationId: string, creatorProfileId: string, followers: number, now: Date): Promise<void>;
}

export interface TikTokServiceDeps {
  /** Null when this deployment has no TikTok client or token key: every connect is refused as NOT_CONFIGURED. */
  readonly configured: { readonly oauth: TikTokOAuthPort; readonly sealer: TikTokTokenSealer } | null;
  readonly creator: TikTokCreatorPort;
  readonly now?: () => Date;
  /** 32 random bytes, base64url. */
  readonly randomToken?: () => string;
}

export interface TikTokStatus {
  readonly permitted: true;
  readonly configured: boolean;
  readonly state: TikTokConnectionState;
  readonly connection: {
    readonly status: TikTokConnectionStatus;
    /** The username TikTok last reported, or null when `user.info.profile` was not granted. */
    readonly handle: string | null;
    readonly grantedScopes: readonly TikTokScope[];
    readonly missingScopes: readonly TikTokScope[];
    readonly connectedAt: Date;
    readonly lastReadAt: Date | null;
    readonly lastFailureClass: string | null;
    readonly expiredAt: Date | null;
    readonly revokedAt: Date | null;
    /** Revoked, but TikTok did not confirm (or was not asked because another connection shares the account). */
    readonly revocationUnconfirmed: boolean;
  } | null;
}

export type TikTokBeginResult = { readonly kind: 'redirect'; readonly url: string } | { readonly kind: 'return'; readonly outcome: TikTokConnectOutcome };

export interface TikTokCallbackQuery {
  readonly state?: string | null;
  readonly code?: string | null;
  readonly error?: string | null;
}

export type TikTokRefusal = 'NOT_CONFIGURED' | 'NOT_PERMITTED' | 'NOT_CONNECTED' | 'EXPIRED' | 'UNAVAILABLE' | 'INSUFFICIENT_SCOPE';

export type TikTokAccessTokenResult =
  | { readonly ok: true; readonly accessToken: string; readonly record: TikTokConnectionRecord }
  | { readonly ok: false; readonly state: Exclude<TikTokRefusal, 'INSUFFICIENT_SCOPE'> };

export type TikTokReadResult =
  /** `fresh` false: the last read was recent enough, and no call was made. */
  | { readonly ok: true; readonly fresh: boolean; readonly readAt: Date }
  | { readonly ok: false; readonly state: TikTokRefusal };

const TOKEN_TEXT = /^[A-Za-z0-9_-]{16,512}$/;
/** An authorization code is opaque text: bounded, printable, no whitespace. */
const CODE_TEXT = /^[\x21-\x7e]{8,2048}$/;
/** An access token this close to its expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

function iso(date: Date): string {
  return date.toISOString();
}

function videoSummaries(page: TikTokVideoListResult): TikTokVideoSummary[] {
  return page.videos.slice(0, TIKTOK_VIDEO_LIST_MAX).map((v) => ({ ...v, title: v.title ? v.title.slice(0, TIKTOK_VIDEO_TITLE_MAX_CHARS) : null }));
}

export class TikTokService {
  private readonly connections: TikTokConnectionRepository;
  private readonly now: () => Date;
  private readonly randomToken: () => string;

  constructor(
    prisma: PrismaClient,
    private readonly deps: TikTokServiceDeps,
  ) {
    this.connections = new TikTokConnectionRepository(prisma);
    this.now = deps.now ?? (() => new Date());
    this.randomToken = deps.randomToken ?? defaultRandomToken;
  }

  /** What the creator may see about their own connection. */
  async status(principal: TikTokPrincipal): Promise<TikTokStatus | { readonly permitted: false }> {
    if (!(await this.deps.creator.seatOf(principal))) return { permitted: false };
    const record = await this.connections.find(principal.organizationId, principal.userId);
    const configured = this.deps.configured !== null;
    return {
      permitted: true,
      configured,
      state: tiktokConnectionState(configured, record),
      connection: record
        ? {
            status: record.status,
            handle: record.handleAtLink,
            grantedScopes: record.grantedScopes,
            missingScopes: tiktokMissingScopes(record.grantedScopes),
            connectedAt: record.connectedAt,
            lastReadAt: record.lastReadAt,
            lastFailureClass: record.lastFailureClass,
            expiredAt: record.expiredAt,
            revokedAt: record.revokedAt,
            revocationUnconfirmed: record.status === 'REVOKED' && record.revocationConfirmedAt === null && record.lastFailureClass !== null,
          }
        : null,
    };
  }

  /**
   * Start a connect attempt: record a single-use state bound to this session, and return
   * TikTok's consent URL for the four registered scopes.
   */
  async beginConnect(principal: TikTokSessionPrincipal): Promise<TikTokBeginResult> {
    const back = (outcome: TikTokConnectOutcome): TikTokBeginResult => ({ kind: 'return', outcome });
    if (!(await this.deps.creator.seatOf(principal))) return back('NOT_PERMITTED');
    const configured = this.deps.configured;
    if (!configured) return back('NOT_CONFIGURED');

    const record = await this.connections.find(principal.organizationId, principal.userId);
    if (record?.status === 'CONNECTED' && tiktokMissingScopes(record.grantedScopes).length === 0) return back('ALREADY_CONNECTED');

    const state = this.randomToken();
    const opened = await this.connections.openState(principal.organizationId, principal.userId, {
      sessionId: principal.sessionId,
      stateHash: sha256Hex(state),
      now: this.now(),
    });
    if (opened === 'TOO_MANY_ATTEMPTS') return back('TOO_MANY_ATTEMPTS');
    return { kind: 'redirect', url: configured.oauth.authorizationUrl({ scopes: TIKTOK_SCOPES, state }) };
  }

  /**
   * Finish a connect attempt from TikTok's redirect. The state is consumed first, in this
   * session only; any refusal stores nothing. After the grant is stored, the account's facts
   * are read once so the profile shows them straight away; a failed first read does not undo
   * the connection.
   */
  async completeConnect(principal: TikTokSessionPrincipal | null, query: TikTokCallbackQuery): Promise<TikTokConnectOutcome> {
    const state = typeof query.state === 'string' && TOKEN_TEXT.test(query.state) ? query.state : null;
    if (!principal || !state) return 'STATE_INVALID';
    const { organizationId, userId } = principal;
    const now = this.now();
    if (!(await this.connections.consumeState(organizationId, userId, principal.sessionId, sha256Hex(state), now))) return 'STATE_INVALID';
    const seat = await this.deps.creator.seatOf(principal);
    if (!seat) return 'NOT_PERMITTED';
    const configured = this.deps.configured;
    if (!configured) return 'NOT_CONFIGURED';

    if (typeof query.error === 'string' && query.error !== '') return query.error === 'access_denied' ? 'DECLINED' : 'FAILED';
    const code = typeof query.code === 'string' && CODE_TEXT.test(query.code) ? query.code : null;
    if (!code) return 'INVALID_REQUEST';

    const exchanged = await configured.oauth.exchangeCode(code);
    if (!exchanged.ok) return 'FAILED';
    const grant = exchanged.grant;
    const granted = parseTikTokGrantedScopes(grant.scope);
    if (!granted.ok) return granted.reason === 'UNEXPECTED_SCOPE' ? 'UNEXPECTED_SCOPE' : 'FAILED';
    if (!grant.refreshToken || grant.expiresInSeconds <= 0) return 'FAILED';
    // Without the basic scope there is no account to name: nothing usable was granted.
    if (!granted.scopes.includes('user.info.basic')) return 'DECLINED';

    const binding = { organizationId, userId, tiktokOpenId: grant.openId };
    const credential: TikTokSealedCredential = {
      refresh: configured.sealer.seal(binding, 'refresh', grant.refreshToken),
      access: configured.sealer.seal(binding, 'access', grant.accessToken),
      accessExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000),
    };
    const stored = await this.connections.storeGrant(
      organizationId,
      userId,
      { tiktokOpenId: grant.openId, handleAtLink: null, grantedScopes: granted.scopes, requestedScopes: TIKTOK_SCOPES, credential, now },
      { userId, name: principal.name ?? null },
    );
    if (stored.outcome !== 'STORED') return stored.outcome;

    await this.deps.creator.mergeSocialAccount(organizationId, seat.creatorProfileId, { platform: 'TIKTOK', state: 'CONNECTED', connectedAt: iso(now) });
    // The first read: best effort. The connection stands whether or not TikTok answers now.
    await this.readOnVisit(principal, { force: true });
    return tiktokMissingScopes(granted.scopes).length === 0 ? 'CONNECTED' : 'PARTIAL';
  }

  /**
   * An access token for one call, in memory. Refreshed first when it is about to expire,
   * which rotates the refresh token; a refused refresh expires the connection and deletes it.
   */
  async accessToken(principal: TikTokPrincipal): Promise<TikTokAccessTokenResult> {
    const configured = this.deps.configured;
    if (!configured) return { ok: false, state: 'NOT_CONFIGURED' };
    if (!(await this.deps.creator.seatOf(principal))) return { ok: false, state: 'NOT_PERMITTED' };
    const { organizationId, userId } = principal;
    const held = await this.connections.credential(organizationId, userId);
    if (!held) {
      const record = await this.connections.find(organizationId, userId);
      return { ok: false, state: record?.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_CONNECTED' };
    }
    const { record, credential } = held;
    const binding = { organizationId, userId, tiktokOpenId: record.tiktokOpenId };
    const now = this.now();
    const expire = async (failureClass: 'TOKEN_UNOPENABLE' | 'REFRESH_REFUSED'): Promise<TikTokAccessTokenResult> => {
      await this.connections.markExpired(organizationId, userId, record.id, failureClass, now);
      return { ok: false, state: 'EXPIRED' };
    };

    let accessToken: string;
    let refreshToken: string;
    try {
      accessToken = configured.sealer.open(binding, 'access', credential.access);
      refreshToken = configured.sealer.open(binding, 'refresh', credential.refresh);
    } catch (err) {
      if (!(err instanceof TikTokTokenUnopenable)) throw err;
      return expire('TOKEN_UNOPENABLE');
    }
    if (credential.accessExpiresAt.getTime() - now.getTime() > EXPIRY_MARGIN_MS) return { ok: true, accessToken, record };

    const refreshed = await configured.oauth.refresh(refreshToken);
    if (!refreshed.ok) {
      if (refreshed.failure === 'INVALID_GRANT') return expire('REFRESH_REFUSED');
      return { ok: false, state: 'UNAVAILABLE' };
    }
    const grant = refreshed.grant;
    if (grant.expiresInSeconds <= 0) return { ok: false, state: 'UNAVAILABLE' };
    let grantedScopes: readonly TikTokScope[] | null = null;
    if (grant.scope !== null) {
      const granted = parseTikTokGrantedScopes(grant.scope);
      if (!granted.ok) return { ok: false, state: 'UNAVAILABLE' };
      grantedScopes = granted.scopes;
    }
    // The rotated refresh token replaces the old one. Should TikTok ever answer without one,
    // the one that just worked is kept rather than lost.
    const rotated: TikTokSealedCredential = {
      refresh: configured.sealer.seal(binding, 'refresh', grant.refreshToken ?? refreshToken),
      access: configured.sealer.seal(binding, 'access', grant.accessToken),
      accessExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000),
    };
    if (!(await this.connections.recordRefresh(organizationId, userId, record.id, { credential: rotated, grantedScopes }, now))) {
      return { ok: false, state: 'NOT_CONNECTED' };
    }
    const current = grantedScopes ? { ...record, grantedScopes } : record;
    return { ok: true, accessToken: grant.accessToken, record: current };
  }

  /**
   * Read the account's facts for the creator's Profile page, when the last read is old enough
   * (or `force`). What TikTok returns is merged into the profile; the follower count is recorded
   * as an audience observation. A failed read records its class and changes nothing else.
   */
  async readOnVisit(principal: TikTokPrincipal, options: { readonly force?: boolean } = {}): Promise<TikTokReadResult> {
    const configured = this.deps.configured;
    if (!configured) return { ok: false, state: 'NOT_CONFIGURED' };
    const seat = await this.deps.creator.seatOf(principal);
    if (!seat) return { ok: false, state: 'NOT_PERMITTED' };
    const { organizationId, userId } = principal;
    const now = this.now();
    const record = await this.connections.find(organizationId, userId);
    if (!record || record.status !== 'CONNECTED') return { ok: false, state: record?.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_CONNECTED' };
    if (!options.force && record.lastReadAt && now.getTime() - record.lastReadAt.getTime() < TIKTOK_READ_MIN_INTERVAL_MS) {
      return { ok: true, fresh: false, readAt: record.lastReadAt };
    }

    const token = await this.accessToken(principal);
    if (!token.ok) return { ok: false, state: token.state };
    const scopes = token.record.grantedScopes;

    const info = await configured.oauth.userInfo(token.accessToken, scopes);
    if (!info.ok) {
      const forbidden = info.failure === 'FORBIDDEN';
      await this.connections.recordReadFailure(organizationId, userId, record.id, forbidden ? 'READ_FORBIDDEN' : 'READ_UNAVAILABLE', now);
      return { ok: false, state: forbidden ? 'INSUFFICIENT_SCOPE' : 'UNAVAILABLE' };
    }
    const user = info.user;

    let recentVideos: readonly TikTokVideoSummary[] | undefined;
    if (scopes.includes('video.list')) {
      const listed = await configured.oauth.videoList(token.accessToken, TIKTOK_VIDEO_LIST_MAX);
      // A video list that did not arrive leaves the last one in place; the counts are still new.
      if (listed.ok) recentVideos = videoSummaries(listed.page);
    }

    const stats: TikTokAudienceStats | undefined = scopes.includes('user.info.stats')
      ? { followers: user.followerCount, following: user.followingCount, likes: user.likesCount, videos: user.videoCount }
      : undefined;
    const patch: TikTokSocialAccountPatch = {
      platform: 'TIKTOK',
      state: 'CONNECTED',
      connectedAt: iso(record.connectedAt),
      readAt: iso(now),
      ...(user.username ? { handle: user.username } : {}),
      ...(user.profileDeepLink && /^https:\/\//.test(user.profileDeepLink) ? { profileUrl: user.profileDeepLink } : {}),
      ...(stats ? { stats } : {}),
      ...(stats?.followers != null ? { audience: stats.followers } : {}),
      ...(recentVideos ? { recentVideos } : {}),
    };
    await this.deps.creator.mergeSocialAccount(organizationId, seat.creatorProfileId, patch);
    if (stats?.followers != null) await this.deps.creator.recordAudience(organizationId, seat.creatorProfileId, stats.followers, now);
    await this.connections.recordRead(organizationId, userId, record.id, now, user.username);
    return { ok: true, fresh: true, readAt: now };
  }

  /** Disconnect the creator's own TikTok connection: delete, withdraw what was read, then ask TikTok to revoke. */
  async disconnect(principal: TikTokPrincipal, reason: Extract<TikTokRevocationReason, 'SELF_DISCONNECT'> = 'SELF_DISCONNECT'): Promise<TikTokConnectOutcome> {
    const seat = await this.deps.creator.seatOf(principal);
    if (!seat) return 'NOT_PERMITTED';
    const actor: TikTokActor = { userId: principal.userId, name: principal.name ?? null };
    const revocation = await this.connections.revoke(principal.organizationId, principal.userId, { reason, actor, now: this.now() });
    if (!revocation) return 'NOT_CONNECTED';
    await this.deps.creator.mergeSocialAccount(principal.organizationId, seat.creatorProfileId, TIKTOK_DISCONNECTED_PATCH);
    return this.finishRevocation(revocation, actor);
  }

  /**
   * After a revocation committed, ask TikTok to revoke what was deleted, and record the answer.
   *
   *   DISCONNECTED              TikTok confirmed, the grant was already dead, or there was no
   *                             credential left to revoke.
   *   DISCONNECTED_UNCONFIRMED  Loop's copy is gone, but TikTok did not confirm: the call
   *                             failed, the credential could not be opened, or another live
   *                             connection shares this TikTok account and was protected.
   */
  async finishRevocation(revocation: TikTokRevocation, actor: TikTokActor): Promise<'DISCONNECTED' | 'DISCONNECTED_UNCONFIRMED'> {
    const { organizationId, connectionId } = revocation;
    const unconfirmed = async (failureClass: 'REVOKE_UNCONFIRMED' | 'REVOKE_SKIPPED_SHARED_GRANT' | 'TOKEN_UNOPENABLE') => {
      await this.connections.recordRevocationResult(organizationId, connectionId, { confirmed: false, failureClass }, this.now(), actor);
      return 'DISCONNECTED_UNCONFIRMED' as const;
    };
    const confirmed = async () => {
      await this.connections.recordRevocationResult(organizationId, connectionId, { confirmed: true }, this.now(), actor);
      return 'DISCONNECTED' as const;
    };
    if (!revocation.credential) return 'DISCONNECTED';
    const configured = this.deps.configured;
    if (!configured) return unconfirmed('REVOKE_UNCONFIRMED');
    if (await this.connections.liveGrantElsewhere(revocation.tiktokOpenId, connectionId)) return unconfirmed('REVOKE_SKIPPED_SHARED_GRANT');

    const binding = { organizationId, userId: revocation.userId, tiktokOpenId: revocation.tiktokOpenId };
    let accessToken: string;
    try {
      accessToken = configured.sealer.open(binding, 'access', revocation.credential.access);
      // TikTok revokes an ACCESS token. One that has expired is replaced first, from the refresh
      // token that was deleted with it; a refresh TikTok refuses means the grant is already gone.
      if (revocation.credential.accessExpiresAt.getTime() - this.now().getTime() <= EXPIRY_MARGIN_MS) {
        const refreshed = await configured.oauth.refresh(configured.sealer.open(binding, 'refresh', revocation.credential.refresh));
        if (!refreshed.ok) return refreshed.failure === 'INVALID_GRANT' ? confirmed() : unconfirmed('REVOKE_UNCONFIRMED');
        accessToken = refreshed.grant.accessToken;
      }
    } catch (err) {
      if (!(err instanceof TikTokTokenUnopenable)) throw err;
      return unconfirmed('TOKEN_UNOPENABLE');
    }
    const result = await configured.oauth.revoke(accessToken);
    return result.ok ? confirmed() : unconfirmed('REVOKE_UNCONFIRMED');
  }
}
