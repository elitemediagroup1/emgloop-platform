import { createHash, randomBytes } from 'crypto';
import type { TikTokBusinessGrant, TikTokBusinessKind } from '@emgloop/providers';
import { businessAuthorizationUrl } from '@emgloop/providers';
import { TikTokBusinessRepository, type BusinessPrincipal } from '../../repositories/tiktok-business.repository';
import { aesGcmSealingKey, sealAesGcm, openAesGcm } from '../sealing/aes-gcm-sealing';
export const businessStateHash = (state: string) => createHash('sha256').update(state).digest('hex');
export interface BusinessConfigured {
  key: Uint8Array; authorizationUrl: string; redirectUri: string;
  exchange(kind: TikTokBusinessKind, code: string): Promise<TikTokBusinessGrant>;
}
const PROFILE = { header: Uint8Array.from([0x4c, 0x54, 0x42, 1]), version: 'tiktok-business.aes-gcm.1' };
export class TikTokBusinessService {
  constructor(private readonly repository: Pick<TikTokBusinessRepository, 'begin' | 'consume' | 'store'>, private readonly config: BusinessConfigured | null) {}
  async begin(p: BusinessPrincipal, kind: TikTokBusinessKind): Promise<string | null> {
    if (!this.config) return null;
    const state = randomBytes(32).toString('hex');
    const url = businessAuthorizationUrl(this.config.authorizationUrl, this.config.redirectUri, state);
    if (!await this.repository.begin(p, kind, businessStateHash(state), new Date())) return null;
    return url;
  }
  async complete(p: BusinessPrincipal, kind: TikTokBusinessKind, query: { state: string | null; authCode: string | null; error: string | null }): Promise<string> {
    if (!this.config) return 'NOT_CONFIGURED';
    if (!query.state || !/^[a-f0-9]{64}$/.test(query.state)) return 'STATE_INVALID';
    const hash = businessStateHash(query.state);
    if (!await this.repository.consume(p, kind, hash, new Date())) return 'STATE_INVALID';
    if (query.error) return 'DECLINED';
    if (!query.authCode || query.authCode.length > 4096 || !/^[\x21-\x7e]+$/.test(query.authCode)) return 'INVALID_REQUEST';
    const grant = await this.config.exchange(kind, query.authCode);
    const now = new Date();
    const keyRef = `tiktok-business/${createHash('sha256').update(this.config.key).digest('hex').slice(0, 16)}`;
    const tokenSealed = Buffer.from(sealAesGcm(PROFILE, aesGcmSealingKey(keyRef, this.config.key), keyRef,
      [p.organizationId, p.userId, kind, grant.openId ?? 'TTO'], new TextEncoder().encode(JSON.stringify(grant))));
    const stored = await this.repository.store(p, kind, hash, { tokenSealed, externalId: grant.openId, expiresAt: grant.expiresIn === null ? null : new Date(+now + grant.expiresIn * 1000) }, now);
    return stored ? 'CONNECTED' : 'WITHDRAWN';
  }
}

/** Only server services receive the opened grant. Same binding and format as the existing callback. */
export function openBusinessGrant(p: { organizationId: string; userId: string }, kind: TikTokBusinessKind, externalId: string | null, tokenSealed: Uint8Array, key: Uint8Array): TikTokBusinessGrant {
  const keyRef = `tiktok-business/${createHash('sha256').update(key).digest('hex').slice(0,16)}`;
  const bytes = openAesGcm(PROFILE, aesGcmSealingKey(keyRef,key), keyRef, [p.organizationId,p.userId,kind,externalId ?? 'TTO'], tokenSealed);
  if (!bytes) throw new Error('TOKEN_UNOPENABLE');
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!raw || typeof raw !== 'object' || !('accessToken' in raw) || typeof raw.accessToken !== 'string' || !raw.accessToken) throw new Error('TOKEN_UNOPENABLE');
  return raw as TikTokBusinessGrant;
}
