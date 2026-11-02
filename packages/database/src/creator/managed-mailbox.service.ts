import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { readGoogleGmailThread, searchGoogleGmailThreads, type GmailCallOptions, type GmailThreadSearchResult } from '@emgloop/providers';
import type { GmailThreadResult } from '@emgloop/shared';
import { GoogleTokenSealer } from '../services/google/google-token-sealer';
import {
  sha256Hex,
  type GoogleOAuthPort,
  type GooglePrincipal,
  type GoogleSessionPrincipal,
  type GoogleCallbackQuery,
} from '../services/google/google-workspace.service';
import {
  ManagedMailboxRepository,
  MANAGED_GMAIL_READ_SCOPE,
  MANAGED_MAILBOX_STATE_PREFIX,
  normalizedMailboxEmail,
  type ManagedMailboxOutcome,
} from './managed-mailbox.repository';

const TOKEN = /^mm1_[A-Za-z0-9_-]{32,256}$/;
const CODE = /^[A-Za-z0-9._\/~+-]{8,2048}$/;
const IDENTITY_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'];
const grantIsReadOnly = (scope: string | null | undefined) => {
  const values = (scope ?? '').split(/\s+/).filter(Boolean);
  return (
    values.includes(MANAGED_GMAIL_READ_SCOPE) &&
    values.every((s) => s === MANAGED_GMAIL_READ_SCOPE || IDENTITY_SCOPES.includes(s))
  );
};
/** Namespaced associated data, NOT a new login. A private connection's ciphertext cannot open here. */
const binding = (organizationId: string, mailboxId: string, googleSubject: string) => ({
  organizationId,
  userId: `managed-mailbox/${mailboxId}`,
  googleSubject,
});

export class ManagedMailboxService {
  readonly repository: ManagedMailboxRepository;
  constructor(
    prisma: PrismaClient,
    private readonly deps: {
      configured: { oauth: GoogleOAuthPort; sealer: GoogleTokenSealer } | null;
      now?: () => Date;
      randomToken?: () => string;
      readThread?: typeof readGoogleGmailThread;
      searchThreads?: typeof searchGoogleGmailThreads;
      fetchImpl?: GmailCallOptions['fetchImpl'];
    },
  ) {
    this.repository = new ManagedMailboxRepository(prisma);
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private random() {
    return this.deps.randomToken?.() ?? randomBytes(32).toString('base64url');
  }

  async begin(
    principal: GoogleSessionPrincipal,
    input: { creatorProfileId: string | null; expectedEmail: string; confirmed: boolean },
  ): Promise<{ url: string } | { outcome: ManagedMailboxOutcome }> {
    if (
      !input.confirmed ||
      !normalizedMailboxEmail(input.expectedEmail) ||
      (input.creatorProfileId && input.creatorProfileId.length > 200)
    )
      return { outcome: 'INVALID_REQUEST' };
    if (!(await this.repository.permittedFor(principal, 'update')))
      return { outcome: 'NOT_ALLOWED' };
    const configured = this.deps.configured;
    if (!configured) return { outcome: 'NOT_CONFIGURED' };
    const state = `${MANAGED_MAILBOX_STATE_PREFIX}${this.random()}`,
      nonce = this.random();
    const result = await this.repository.begin(principal, {
      ...input,
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      now: this.now(),
    });
    if (result.outcome !== 'OPENED') return result;
    return {
      url: configured.oauth.authorizationUrl({
        state,
        nonce,
        scopes: ['openid', 'email', MANAGED_GMAIL_READ_SCOPE],
        loginHint: result.email,
        includeGrantedScopes: false,
      }),
    };
  }

  async complete(
    principal: GoogleSessionPrincipal,
    query: GoogleCallbackQuery,
  ): Promise<{ outcome: ManagedMailboxOutcome; creatorProfileId: string | null }> {
    const end = (outcome: ManagedMailboxOutcome, creatorProfileId: string | null = null) => ({
      outcome,
      creatorProfileId,
    });
    if (typeof query.state !== 'string' || !TOKEN.test(query.state)) return end('STATE_INVALID');
    const attempt = await this.repository.consume(principal, sha256Hex(query.state), this.now());
    if (!attempt) return end('STATE_INVALID');
    const target = await this.repository.target(principal, attempt.mailboxId);
    if (!target) return end('NOT_ALLOWED');
    const back = (outcome: ManagedMailboxOutcome) => end(outcome, target.creatorProfileId);
    const configured = this.deps.configured;
    if (!configured) return back('NOT_CONFIGURED');
    if (query.error) return back(query.error === 'access_denied' ? 'DECLINED' : 'FAILED');
    if (typeof query.code !== 'string' || !CODE.test(query.code)) return back('INVALID_REQUEST');
    if (!(await configured.oauth.signingKeysReady())) return back('FAILED');
    const exchanged = await configured.oauth.exchangeCode(query.code);
    if (!exchanged.ok) return back('FAILED');
    const grant = exchanged.grant;
    if (!grant.idToken || !grant.refreshToken) return back('FAILED');
    if (!grantIsReadOnly(grant.scope)) return back('SCOPE_REFUSED');
    const identity = await configured.oauth.checkIdToken(grant.idToken, {
      nonceMatches: (nonce) => sha256Hex(nonce) === attempt.nonceHash,
      nowSeconds: Math.floor(this.now().getTime() / 1000),
      allowedHostedDomains: [],
    });
    if (!identity.ok) return back('FAILED');
    if (normalizedMailboxEmail(identity.identity.email) !== attempt.expectedEmail)
      return back('WRONG_ACCOUNT');
    const sealed = configured.sealer.seal(
      binding(principal.organizationId, attempt.mailboxId, identity.identity.subject),
      grant.refreshToken,
    );
    return back(
      await this.repository.store(principal, attempt, {
        subject: identity.identity.subject,
        email: identity.identity.email,
        sealed,
        now: this.now(),
      }),
    );
  }

  /** A manager-side read primitive for future ingestion. Bodies stay transient; no send capability exists. */
  async readThread(
    principal: GooglePrincipal,
    mailboxId: string,
    threadId: string,
  ): Promise<GmailThreadResult> {
    const unavailable = (): GmailThreadResult => ({ ok: false, failure: 'UNAVAILABLE' });
    if (!threadId || threadId.length > 200) return unavailable();
    return this.withAccess(principal, mailboxId, options => (this.deps.readThread ?? readGoogleGmailThread)({ ...options, threadId }), unavailable);
  }

  async searchThreads(principal: GooglePrincipal, mailboxId: string, query: string, pageToken?: string | null): Promise<GmailThreadSearchResult> {
    return this.withAccess(principal, mailboxId, options => (this.deps.searchThreads ?? searchGoogleGmailThreads)({ ...options, query, pageToken }), () => ({ ok: false, threadIds: [], nextPageToken: null, failure: 'UNAVAILABLE' }));
  }

  private async withAccess<T>(principal: GooglePrincipal, mailboxId: string, operation: (options: GmailCallOptions) => Promise<T>, unavailable: () => T): Promise<T> {
    const configured = this.deps.configured;
    if (!configured || !this.deps.fetchImpl) return unavailable();
    const row = await this.repository.credential(principal, mailboxId);
    if (
      !row?.refreshTokenSealed ||
      !row.googleSubject ||
      !row.sealVersion ||
      !row.keyRef ||
      !row.grantedScopes.includes(MANAGED_GMAIL_READ_SCOPE)
    )
      return unavailable();
    let refreshToken: string;
    try {
      refreshToken = configured.sealer.open(
        binding(row.organizationId, row.id, row.googleSubject),
        { sealed: row.refreshTokenSealed, keyRef: row.keyRef, sealVersion: row.sealVersion },
      );
    } catch {
      await this.repository.expire(principal, row.id, row.revision, 'TOKEN_UNOPENABLE');
      return unavailable();
    }
    const refreshed = await configured.oauth.refresh(refreshToken);
    if (!refreshed.ok) {
      if (refreshed.failure === 'INVALID_GRANT')
        await this.repository.expire(principal, row.id, row.revision, 'REFRESH_REFUSED');
      return unavailable();
    }
    // A broader refreshed credential is refused rather than silently widening the source.
    if (refreshed.grant.scope && !grantIsReadOnly(refreshed.grant.scope)) return unavailable();
    if ((await this.repository.credential(principal, mailboxId))?.revision !== row.revision)
      return unavailable();
    const result = await operation({
      fetchImpl: this.deps.fetchImpl,
      accessToken: refreshed.grant.accessToken,
      selfAddress: row.expectedEmail,
    });
    return (await this.repository.credential(principal, mailboxId))?.revision === row.revision
      ? result
      : unavailable();
  }
}
