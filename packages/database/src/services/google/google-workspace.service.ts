// The Google Workspace connection lifecycle. Private V1.
//
// Architecture: docs/architecture/google-workspace-connection.md §11.
//
// THE PERSON IS ALWAYS THE SIGNED SESSION'S. Every method takes the principal the web tier
// resolved from the session cookie -- organization, user and session id -- and nothing
// from the request decides whose connection is touched.
//
// CONNECTING IS AN EXPLICIT, DECLINABLE ACT, ONE CAPABILITY AT A TIME. `beginConnect`
// asks Google for the identity scopes plus the capability the person chose; the grant is
// cumulative (`include_granted_scopes`), and what Google GRANTED -- never what Loop asked
// for -- is what gets stored.
//
// NOTHING SECRET LEAVES. The refresh token is sealed before it reaches the repository and
// opened only to call Google; access tokens live in memory for one call. Outcomes are
// codes from @emgloop/shared, never Google's text.
//
// Google, the sealer, authorization, the clock and randomness are injected: the web tier
// wires the real ones (apps/web/src/google/google-runtime.ts); tests wire doubles.

import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { GoogleIdTokenResult, GoogleOAuthFailure, GoogleRevokeResult, GoogleTokenResult } from '@emgloop/providers';
import {
  GOOGLE_WORKSPACE_CAPABILITY_SCOPES,
  googleCapabilitiesOf,
  googleCapabilityScopes,
  googleCapabilityStates,
  googleScopesFor,
  isGoogleConnectReturnTarget,
  parseGoogleGrantedScopes,
  parseGoogleWorkspaceCapabilities,
  type GoogleCapabilityState,
  type GoogleConnectOutcome,
  type GoogleConnectReturnTarget,
  type GoogleConnectionStatus,
  type GoogleRevocationReason,
  type GoogleWorkspaceCapability,
} from '@emgloop/shared';

import {
  GoogleConnectionRepository,
  type GoogleActor,
  type GoogleRevocation,
} from '../../repositories/google-connection.repository';
import { GoogleTokenUnopenable, type GoogleTokenSealer } from './google-token-sealer';

export interface GooglePrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly name?: string | null;
}

export interface GoogleSessionPrincipal extends GooglePrincipal {
  /** The id of the signed session row the request arrived in. */
  readonly sessionId: string;
}

/** Google, as the service needs it. The web tier binds client id, secret and redirect URI. */
export interface GoogleOAuthPort {
  authorizationUrl(request: { readonly scopes: readonly string[]; readonly state: string; readonly nonce: string; readonly loginHint: string | null }): string;
  exchangeCode(code: string): Promise<GoogleTokenResult>;
  refresh(refreshToken: string): Promise<GoogleTokenResult>;
  revoke(token: string): Promise<GoogleRevokeResult>;
  /** Whether Google's signing keys are in hand (fetched if not). Asked before a code is exchanged. */
  signingKeysReady(): Promise<boolean>;
  /** Verify the ID token's signature against Google's published keys, then its claims. */
  checkIdToken(
    idToken: string,
    expected: { readonly nonceMatches: (nonce: string) => boolean; readonly nowSeconds: number; readonly allowedHostedDomains: readonly string[] },
  ): Promise<GoogleIdTokenResult>;
}

export type GoogleAuthority = 'view' | 'update' | 'manage';

export interface GoogleWorkspaceServiceDeps {
  /** Null when this deployment has no Google client or token key: every connect is refused as NOT_CONFIGURED. */
  readonly configured: { readonly oauth: GoogleOAuthPort; readonly sealer: GoogleTokenSealer } | null;
  /** The IAM decision for the principal's own connection (`googleWorkspace:<action>`). */
  readonly authorize: (principal: GooglePrincipal, action: GoogleAuthority) => Promise<boolean>;
  readonly now?: () => Date;
  /** 32 random bytes, base64url. */
  readonly randomToken?: () => string;
}

export interface GoogleWorkspaceStatus {
  readonly permitted: true;
  readonly configured: boolean;
  readonly canConnect: boolean;
  readonly connection: {
    readonly status: GoogleConnectionStatus;
    readonly email: string;
    readonly hostedDomain: string | null;
    readonly connectedAt: Date;
    readonly lastUsedAt: Date | null;
    readonly expiredAt: Date | null;
    readonly revokedAt: Date | null;
    /** Revoked, but Google did not confirm (or was not asked because another connection shares the account). */
    readonly revocationUnconfirmed: boolean;
  } | null;
  readonly capabilities: Readonly<Record<GoogleWorkspaceCapability, GoogleCapabilityState>>;
}

export type GoogleBeginResult =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'return'; readonly returnTo: GoogleConnectReturnTarget; readonly outcome: GoogleConnectOutcome };

export interface GoogleCallbackQuery {
  readonly state?: string | null;
  readonly code?: string | null;
  readonly error?: string | null;
}

export interface GoogleCallbackResult {
  readonly returnTo: GoogleConnectReturnTarget;
  readonly outcome: GoogleConnectOutcome;
}

export type GoogleAccessTokenResult =
  | { readonly ok: true; readonly accessToken: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly state: 'NOT_CONFIGURED' | 'NOT_PERMITTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED' | 'UNAVAILABLE' };

const TOKEN_TEXT = /^[A-Za-z0-9_-]{16,512}$/;
const CODE_TEXT = /^[A-Za-z0-9._\/~+-]{8,2048}$/;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameHash(value: string, hash: string): boolean {
  return sha256Hex(value) === hash;
}

export class GoogleWorkspaceService {
  private readonly connections: GoogleConnectionRepository;
  private readonly now: () => Date;
  private readonly randomToken: () => string;

  constructor(
    prisma: PrismaClient,
    private readonly deps: GoogleWorkspaceServiceDeps,
  ) {
    this.connections = new GoogleConnectionRepository(prisma);
    this.now = deps.now ?? (() => new Date());
    this.randomToken = deps.randomToken ?? defaultRandomToken;
  }

  /** What the person may see about their own connection, per capability. */
  async status(principal: GooglePrincipal): Promise<GoogleWorkspaceStatus | { readonly permitted: false }> {
    if (!(await this.deps.authorize(principal, 'view'))) return { permitted: false };
    const [record, canConnect] = await Promise.all([
      this.connections.find(principal.organizationId, principal.userId),
      this.deps.authorize(principal, 'update'),
    ]);
    return {
      permitted: true,
      configured: this.deps.configured !== null,
      canConnect,
      connection: record
        ? {
            status: record.status,
            email: record.emailAtLink,
            hostedDomain: record.hostedDomain,
            connectedAt: record.connectedAt,
            lastUsedAt: record.lastUsedAt,
            expiredAt: record.expiredAt,
            revokedAt: record.revokedAt,
            revocationUnconfirmed: record.status === 'REVOKED' && record.revocationConfirmedAt === null && record.lastFailureClass !== null,
          }
        : null,
      capabilities: googleCapabilityStates(record),
    };
  }

  /**
   * Start a connect attempt: record a single-use state bound to this session, and return
   * Google's consent URL for the identity scopes plus the requested capabilities.
   */
  async beginConnect(
    principal: GoogleSessionPrincipal,
    request: { readonly capabilities: unknown; readonly returnTo: unknown },
  ): Promise<GoogleBeginResult> {
    const returnTo: GoogleConnectReturnTarget = isGoogleConnectReturnTarget(request.returnTo) ? request.returnTo : 'CONNECTIONS';
    const back = (outcome: GoogleConnectOutcome): GoogleBeginResult => ({ kind: 'return', returnTo, outcome });

    const capabilities = parseGoogleWorkspaceCapabilities(request.capabilities);
    if (!capabilities) return back('INVALID_REQUEST');
    if (!(await this.deps.authorize(principal, 'update'))) return back('NOT_PERMITTED');
    const configured = this.deps.configured;
    if (!configured) return back('NOT_CONFIGURED');

    const record = await this.connections.find(principal.organizationId, principal.userId);
    if (record?.status === 'CONNECTED' && capabilities.every((c) => record.grantedScopes.includes(GOOGLE_WORKSPACE_CAPABILITY_SCOPES[c]))) {
      return back('ALREADY_CONNECTED');
    }

    const state = this.randomToken();
    const nonce = this.randomToken();
    const opened = await this.connections.openState(principal.organizationId, principal.userId, {
      sessionId: principal.sessionId,
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      capabilities,
      returnTo,
      now: this.now(),
    });
    if (opened === 'TOO_MANY_ATTEMPTS') return back('TOO_MANY_ATTEMPTS');

    const loginHint = record && record.status !== 'REVOKED' ? record.googleSubject : null;
    return { kind: 'redirect', url: configured.oauth.authorizationUrl({ scopes: googleScopesFor(capabilities), state, nonce, loginHint }) };
  }

  /**
   * Finish a connect attempt from Google's redirect. The state is consumed first, in this
   * session only; any refusal stores nothing.
   */
  async completeConnect(principal: GoogleSessionPrincipal | null, query: GoogleCallbackQuery): Promise<GoogleCallbackResult> {
    const state = typeof query.state === 'string' && TOKEN_TEXT.test(query.state) ? query.state : null;
    if (!principal || !state) return { returnTo: 'CONNECTIONS', outcome: 'STATE_INVALID' };
    const { organizationId, userId } = principal;
    const stateHash = sha256Hex(state);
    const returnTo = (await this.connections.returnTargetOf(organizationId, userId, stateHash)) ?? 'CONNECTIONS';
    const end = (outcome: GoogleConnectOutcome): GoogleCallbackResult => ({ returnTo, outcome });

    const now = this.now();
    const attempt = await this.connections.consumeState(organizationId, userId, principal.sessionId, stateHash, now);
    if (!attempt) return end('STATE_INVALID');
    if (!(await this.deps.authorize(principal, 'update'))) return end('NOT_PERMITTED');
    const configured = this.deps.configured;
    if (!configured) return end('NOT_CONFIGURED');

    if (typeof query.error === 'string' && query.error !== '') return end(query.error === 'access_denied' ? 'DECLINED' : 'FAILED');
    const code = typeof query.code === 'string' && CODE_TEXT.test(query.code) ? query.code : null;
    if (!code) return end('INVALID_REQUEST');

    // Without Google's signing keys the ID token cannot be verified, so the code is not
    // exchanged: Google issues no grant that Loop would only have to discard.
    if (!(await configured.oauth.signingKeysReady())) return end('FAILED');

    const exchanged = await configured.oauth.exchangeCode(code);
    if (!exchanged.ok) return end('FAILED');
    const grant = exchanged.grant;

    const granted = parseGoogleGrantedScopes(grant.scope);
    if (!granted.ok) return end(granted.reason === 'UNEXPECTED_SCOPE' ? 'UNEXPECTED_SCOPE' : 'FAILED');
    if (!grant.idToken || !grant.refreshToken) return end('FAILED');

    // The signature is verified before any claim is read (a refusal of any kind stores nothing).
    const identity = await configured.oauth.checkIdToken(grant.idToken, {
      nonceMatches: (nonce) => sameHash(nonce, attempt.nonceHash),
      nowSeconds: Math.floor(now.getTime() / 1000),
      allowedHostedDomains: await this.connections.allowedHostedDomains(organizationId),
    });
    if (!identity.ok) {
      if (identity.refusal === 'DOMAIN_NOT_ALLOWED') return end('DOMAIN_NOT_ALLOWED');
      if (identity.refusal === 'EMAIL_UNVERIFIED') return end('EMAIL_UNVERIFIED');
      return end('FAILED');
    }

    // Nothing granted and nothing to keep: the person declined the capability on Google's
    // screen. (Whether this is the account already connected is decided by the repository,
    // inside the storing transaction.)
    const current = await this.connections.find(organizationId, userId);
    if (granted.capabilities.length === 0 && (current === null || current.status === 'REVOKED')) return end('DECLINED');

    const sealed = configured.sealer.seal({ organizationId, userId, googleSubject: identity.identity.subject }, grant.refreshToken);
    const stored = await this.connections.storeGrant(
      organizationId,
      userId,
      {
        googleSubject: identity.identity.subject,
        emailAtLink: identity.identity.email,
        hostedDomain: identity.identity.hostedDomain,
        grantedScopes: granted.capabilityScopes,
        requestedScopes: googleCapabilityScopes(attempt.capabilities),
        sealed,
        now,
      },
      { userId, name: principal.name ?? null },
    );
    if (stored.outcome !== 'STORED') return end(stored.outcome);
    return end(attempt.capabilities.every((c) => granted.capabilities.includes(c)) ? 'CONNECTED' : 'PARTIAL');
  }

  /** Disconnect the person's own Google connection: delete, then ask Google to revoke. */
  async disconnect(principal: GooglePrincipal, reason: Extract<GoogleRevocationReason, 'SELF_DISCONNECT' | 'CAPABILITY_REMOVED'> = 'SELF_DISCONNECT'): Promise<GoogleConnectOutcome> {
    if (!(await this.deps.authorize(principal, 'update'))) return 'NOT_PERMITTED';
    const actor: GoogleActor = { userId: principal.userId, name: principal.name ?? null };
    const revocation = await this.connections.revoke(principal.organizationId, principal.userId, { reason, actor, now: this.now() });
    if (!revocation) return 'NOT_CONNECTED';
    return this.finishRevocation(revocation, actor);
  }

  /**
   * Remove one capability. Google cannot revoke one scope of a grant, so the whole grant
   * is revoked and deleted, and the capabilities the person keeps are returned for the
   * caller to ask for again -- a fresh, narrower consent.
   */
  async removeCapability(
    principal: GooglePrincipal,
    capabilityRaw: unknown,
  ): Promise<{ readonly outcome: GoogleConnectOutcome; readonly reconnect: readonly GoogleWorkspaceCapability[] }> {
    const parsed = parseGoogleWorkspaceCapabilities(capabilityRaw);
    if (!parsed || parsed.length !== 1) return { outcome: 'INVALID_REQUEST', reconnect: [] };
    const [removed] = parsed;
    if (!(await this.deps.authorize(principal, 'update'))) return { outcome: 'NOT_PERMITTED', reconnect: [] };
    const record = await this.connections.find(principal.organizationId, principal.userId);
    if (!record || record.status === 'REVOKED') return { outcome: 'NOT_CONNECTED', reconnect: [] };
    const keep = googleCapabilitiesOf(record.grantedScopes).filter((c) => c !== removed);
    const outcome = await this.disconnect(principal, 'CAPABILITY_REMOVED');
    return { outcome, reconnect: outcome === 'DISCONNECTED' || outcome === 'DISCONNECTED_UNCONFIRMED' ? keep : [] };
  }

  /**
   * An access token for one capability, for one call, in memory. The first caller is a
   * later Calendar/Gmail/Drive read; nothing reads Google data yet.
   */
  async accessToken(principal: GooglePrincipal, capability: GoogleWorkspaceCapability): Promise<GoogleAccessTokenResult> {
    const configured = this.deps.configured;
    if (!configured) return { ok: false, state: 'NOT_CONFIGURED' };
    if (!(await this.deps.authorize(principal, 'view'))) return { ok: false, state: 'NOT_PERMITTED' };
    const { organizationId, userId } = principal;
    const credential = await this.connections.credential(organizationId, userId);
    if (!credential) {
      const record = await this.connections.find(organizationId, userId);
      return { ok: false, state: record?.status === 'EXPIRED' ? 'EXPIRED' : 'NOT_CONNECTED' };
    }
    const scope = GOOGLE_WORKSPACE_CAPABILITY_SCOPES[capability];
    if (!credential.record.grantedScopes.includes(scope)) return { ok: false, state: 'INSUFFICIENT_SCOPE' };

    const now = this.now();
    let refreshToken: string;
    try {
      refreshToken = configured.sealer.open({ organizationId, userId, googleSubject: credential.record.googleSubject }, credential.sealed);
    } catch (err) {
      if (!(err instanceof GoogleTokenUnopenable)) throw err;
      await this.connections.markExpired(organizationId, userId, credential.record.id, 'TOKEN_UNOPENABLE', now);
      return { ok: false, state: 'EXPIRED' };
    }

    const refreshed = await configured.oauth.refresh(refreshToken);
    if (!refreshed.ok) {
      if (refreshed.failure === 'INVALID_GRANT') {
        await this.connections.markExpired(organizationId, userId, credential.record.id, 'REFRESH_REFUSED', now);
        return { ok: false, state: 'EXPIRED' };
      }
      return { ok: false, state: 'UNAVAILABLE' };
    }
    let grantedScopes: readonly string[] | null = null;
    if (refreshed.grant.scope !== null) {
      const granted = parseGoogleGrantedScopes(refreshed.grant.scope);
      if (!granted.ok) return { ok: false, state: 'UNAVAILABLE' };
      grantedScopes = granted.capabilityScopes;
    }
    await this.connections.recordUse(organizationId, userId, credential.record.id, grantedScopes, now);
    if (grantedScopes !== null && !grantedScopes.includes(scope)) return { ok: false, state: 'INSUFFICIENT_SCOPE' };
    return { ok: true, accessToken: refreshed.grant.accessToken, expiresAt: new Date(now.getTime() + refreshed.grant.expiresInSeconds * 1000) };
  }

  /**
   * After a revocation committed -- a disconnect, or a member disabled or removed by
   * `IamRepository` -- ask Google to revoke what was deleted, and record the answer.
   *
   *   DISCONNECTED              Google confirmed, or there was no credential left to revoke.
   *   DISCONNECTED_UNCONFIRMED  Loop's copy is gone, but Google did not confirm: the call
   *                             failed, the credential could not be opened, or another live
   *                             connection shares this Google account and was protected.
   */
  async finishRevocation(revocation: GoogleRevocation, actor: GoogleActor): Promise<'DISCONNECTED' | 'DISCONNECTED_UNCONFIRMED'> {
    const { organizationId, connectionId } = revocation;
    const unconfirmed = async (failureClass: 'REVOKE_UNCONFIRMED' | 'REVOKE_SKIPPED_SHARED_GRANT' | 'TOKEN_UNOPENABLE') => {
      await this.connections.recordRevocationResult(organizationId, connectionId, { confirmed: false, failureClass }, this.now(), actor);
      return 'DISCONNECTED_UNCONFIRMED' as const;
    };
    if (!revocation.sealed) return 'DISCONNECTED';
    const configured = this.deps.configured;
    if (!configured) return unconfirmed('REVOKE_UNCONFIRMED');
    if (await this.connections.liveGrantElsewhere(revocation.googleSubject, connectionId)) return unconfirmed('REVOKE_SKIPPED_SHARED_GRANT');
    let token: string;
    try {
      token = configured.sealer.open(
        { organizationId, userId: revocation.userId, googleSubject: revocation.googleSubject },
        revocation.sealed,
      );
    } catch (err) {
      if (!(err instanceof GoogleTokenUnopenable)) throw err;
      return unconfirmed('TOKEN_UNOPENABLE');
    }
    const result = await configured.oauth.revoke(token);
    if (!result.ok) return unconfirmed('REVOKE_UNCONFIRMED');
    await this.connections.recordRevocationResult(organizationId, connectionId, { confirmed: true }, this.now(), actor);
    return 'DISCONNECTED';
  }
}

/** For tests and callers that need to name a failure class without importing the providers package at runtime. */
export type { GoogleOAuthFailure };
