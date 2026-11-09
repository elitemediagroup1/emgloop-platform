import { createHash, randomBytes } from 'crypto';
import { META_SCOPES, MetaApi, MetaApiError, metaAuthorizationUrl, type MetaReport } from '@emgloop/providers';
import { MetaConnectionRepository, type MetaPrincipal } from '../../repositories/meta-connection.repository';
import { MetaTokenSealer } from './meta-token-sealer';
export const metaStateHash = (state: string) => createHash('sha256').update(state).digest('hex');
export class MetaService {
  constructor(readonly repository: MetaConnectionRepository, private readonly configured: { api: MetaApi; sealer: MetaTokenSealer } | null) {}
  async begin(p: MetaPrincipal, sessionId: string) {
    if (!this.configured) return null;
    const state = randomBytes(32).toString('base64url');
    if (!await this.repository.openState(p, sessionId, metaStateHash(state), new Date())) return null;
    return metaAuthorizationUrl(this.configured.api.config, state);
  }
  async callback(p: MetaPrincipal, sessionId: string, input: { state: string | null; code: string | null; error: string | null }): Promise<string> {
    if (!this.configured) return 'NOT_CONFIGURED';
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !await this.repository.consumeState(p, sessionId, metaStateHash(input.state), new Date())) return 'STATE_INVALID';
    if (input.error) return 'CONSENT_DECLINED';
    if (!input.code || input.code.length > 4096) return 'INVALID_REQUEST';
    const grant = await this.configured.api.exchange(input.code);
    // Partial consent is visible, never promoted to a working insights connection.
    if (!META_SCOPES.every(s => grant.scopes.includes(s))) return 'PERMISSION_REQUIRED';
    const stored = await this.repository.stage(p, sessionId, metaStateHash(input.state), { metaUserId: grant.userId, scopes: grant.scopes, tokenExpiresAt: grant.expiresIn === 0 ? new Date('9999-12-31T23:59:59.000Z') : new Date(Date.now() + grant.expiresIn * 1000), tokenSealed: this.configured.sealer.seal(p, `attempt:${metaStateHash(input.state)}`, grant.token) });
    return stored ? 'SELECT_ACCOUNT' : 'STATE_INVALID';
  }
  async choices(p: MetaPrincipal, sessionId: string) {
    if (!this.configured) return [];
    const pending = await this.repository.pending(p, sessionId);
    if (!pending?.tokenSealed) return [];
    const token = this.configured.sealer.open(p, `attempt:${pending.stateHash}`, pending.tokenSealed);
    return (await this.configured.api.pages(token)).map(page => ({ id: page.id, name: page.name, hasInstagram: page.instagramId !== null }));
  }
  async select(p: MetaPrincipal, sessionId: string, pageId: string) {
    if (!this.configured || !/^\d+$/.test(pageId)) return false;
    const pending = await this.repository.pending(p, sessionId);
    if (!pending?.tokenSealed || !pending.metaUserId || !pending.tokenExpiresAt) return false;
    const token = this.configured.sealer.open(p, `attempt:${pending.stateHash}`, pending.tokenSealed);
    // Re-fetch, don't trust a submitted Page/Instagram id or a stale browser list.
    const page = (await this.configured.api.pages(token)).find(candidate => candidate.id === pageId);
    if (!page) return false;
    return this.repository.connect(p, sessionId, pending.id, { metaUserId: pending.metaUserId, pageId, pageName: page.name, instagramId: page.instagramId, scopes: pending.scopes, tokenExpiresAt: pending.tokenExpiresAt, tokenSealed: this.configured.sealer.seal(p, `grant:${pending.metaUserId}:${pageId}`, token) });
  }
  async sync(p: MetaPrincipal): Promise<string> {
    if (!this.configured) return 'NOT_CONFIGURED';
    const connection = await this.repository.claim(p);
    if (!connection?.leaseId) return 'NOT_DUE';
    const leaseId = connection.leaseId;
    try {
      if (+connection.tokenExpiresAt <= Date.now()) throw new MetaApiError('TOKEN_EXPIRED');
      if (!connection.tokenSealed) throw new Error('TOKEN_UNOPENABLE');
      const token = this.configured.sealer.open(p, `grant:${connection.metaUserId}:${connection.pageId}`, connection.tokenSealed);
      const page = (await this.configured.api.pages(token)).find(row => row.id === connection.pageId);
      if (!page) throw new MetaApiError('PERMISSION_REQUIRED');
      // A replaced Instagram account is never silently assigned to this creator.
      if (page.instagramId !== connection.instagramId) throw new MetaApiError('PERMISSION_REQUIRED');
      const reports: MetaReport[] = await Promise.all([this.configured.api.report(page, 'FACEBOOK', new Date()), ...(page.instagramId ? [this.configured.api.report(page, 'INSTAGRAM', new Date(), token)] : [])]);
      const published = await this.repository.publish(p, connection.id, leaseId, reports, new Date());
      return published ? 'SYNCED' : 'WITHDRAWN';
    } catch (error) {
      const failure = error instanceof MetaApiError ? error.failure : error instanceof Error && error.message === 'TOKEN_UNOPENABLE' ? 'TOKEN_UNOPENABLE' : 'UNAVAILABLE';
      await this.repository.failure(p, connection.id, leaseId, failure);
      return failure;
    }
  }
}
