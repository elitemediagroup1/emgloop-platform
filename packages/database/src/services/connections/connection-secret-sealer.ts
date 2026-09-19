// Sealing for provider connection secrets (Microsoft Teams OAuth refresh token; Telegram
// MTProto session). ONE implementation, mirroring GoogleTokenSealer: the AES-256-GCM core
// (services/sealing) with this payload's own 4-byte header and version, and the (org, user,
// provider, credentialKind, purpose) as associated data -- so a secret sealed for one person,
// organization, provider or kind does NOT open for another, and a key rotation makes old
// secrets unopenable (the employee reconnects) rather than silently wrong.
//
// The raw secret is never logged, never returned except via open() to the caller that needs it,
// and never exposed to the AI. This is the "treat session material as a production secret" rule.
import { createHash } from 'crypto';
import { aesGcmSealingKey, openAesGcm, sealAesGcm, type AesGcmSealingProfile } from '../sealing/aes-gcm-sealing';
import type { ConnectionCredentialKind, ConnectionProvider } from '@emgloop/shared';

export const CONNECTION_SECRET_SEAL_VERSION = 'aes-gcm.1';
export const CONNECTION_SECRET_PURPOSE = 'connection.secret';

// 'L','C','S',1 -- distinct from the Google token header so bytes can never be cross-parsed.
const PROFILE: AesGcmSealingProfile = Object.freeze({
  header: Uint8Array.from([0x4c, 0x43, 0x53, 0x01]),
  version: CONNECTION_SECRET_SEAL_VERSION,
});

export interface ConnectionSecretBinding {
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: ConnectionProvider;
  readonly credentialKind: ConnectionCredentialKind;
}

export interface SealedConnectionSecret {
  readonly sealVersion: string;
  readonly keyRef: string;
  readonly sealed: Uint8Array;
}

export class ConnectionSecretUnopenable extends Error {
  constructor() {
    super('stored connection secret could not be opened');
    this.name = 'ConnectionSecretUnopenable';
  }
}

/** A stable, non-reversible name for a key: `connection-secret/<16 hex>`. */
export function connectionSecretKeyRef(key: Uint8Array): string {
  const digest = createHash('sha256').update('loop-connection-secret-key-ref:').update(Buffer.from(key)).digest('hex');
  return `connection-secret/${digest.slice(0, 16)}`;
}

function binding(b: ConnectionSecretBinding): string[] {
  return [b.organizationId, b.userId, b.provider, b.credentialKind, CONNECTION_SECRET_PURPOSE];
}

export class ConnectionSecretSealer {
  readonly keyRef: string;
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    this.keyRef = connectionSecretKeyRef(key);
    this.key = aesGcmSealingKey(this.keyRef, key);
  }

  seal(b: ConnectionSecretBinding, secret: string): SealedConnectionSecret {
    if (typeof secret !== 'string' || secret === '') throw new Error('a connection secret is required');
    return {
      sealVersion: CONNECTION_SECRET_SEAL_VERSION,
      keyRef: this.keyRef,
      sealed: sealAesGcm(PROFILE, this.key, this.keyRef, binding(b), new TextEncoder().encode(secret)),
    };
  }

  open(b: ConnectionSecretBinding, payload: SealedConnectionSecret): string {
    if (payload.sealVersion !== CONNECTION_SECRET_SEAL_VERSION || payload.keyRef !== this.keyRef) {
      throw new ConnectionSecretUnopenable();
    }
    const opened = openAesGcm(PROFILE, this.key, this.keyRef, binding(b), payload.sealed);
    if (!opened) throw new ConnectionSecretUnopenable();
    return new TextDecoder().decode(opened);
  }
}
