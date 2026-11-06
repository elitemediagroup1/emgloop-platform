import { createHash } from 'crypto';
import { aesGcmSealingKey, sealAesGcm, openAesGcm } from '../sealing/aes-gcm-sealing';
import type { MetaPrincipal } from '../../repositories/meta-connection.repository';
const PROFILE = { header: Uint8Array.from([0x4c, 0x4d, 0x54, 0x01]), version: 'meta.aes-gcm.1' };
export class MetaTokenSealer {
  private readonly key: Buffer;
  private readonly keyRef: string;
  constructor(key: Uint8Array) {
    this.keyRef = `meta/${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    this.key = aesGcmSealingKey(this.keyRef, key);
  }
  private binding(p: MetaPrincipal, purpose: string) { return [p.organizationId, p.userId, p.creatorProfileId, purpose]; }
  seal(p: MetaPrincipal, purpose: string, token: string) { return Buffer.from(sealAesGcm(PROFILE, this.key, this.keyRef, this.binding(p, purpose), new TextEncoder().encode(token))); }
  open(p: MetaPrincipal, purpose: string, bytes: Uint8Array) {
    const value = openAesGcm(PROFILE, this.key, this.keyRef, this.binding(p, purpose), bytes);
    if (!value) throw new Error('TOKEN_UNOPENABLE');
    return new TextDecoder().decode(value);
  }
}
