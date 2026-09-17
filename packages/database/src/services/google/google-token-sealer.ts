// Sealing a Google refresh token with a key only the web tier holds.
//
// Architecture: google-workspace-connection.md §7 and §11.5.
//
// THE SAME FORMAT AND DISCIPLINE AS THE BRAIN CHECKPOINT SEALER, through the one shared
// AES-256-GCM core (services/sealing/aes-gcm-sealing.ts), with this payload's own header
// ("LGT" 0x01), so a Google token and a Brain checkpoint can never be read as each other.
//
// BOUND TO WHOSE TOKEN IT IS. The organization, the Loop user, the Google account (`sub`)
// and the purpose are the associated data: a sealed token copied onto another person's or
// another organization's row does not open.
//
// THE KEY IS THE CALLER'S. This class is handed 32 bytes. Its reference is derived from
// the key itself (a one-way fingerprint), so rotating the key changes the reference and a
// token sealed under the old key is recognised as unopenable -- the person reconnects --
// rather than being tried against the wrong key. The key never reaches the database.

import { createHash } from 'crypto';

import { aesGcmSealingKey, openAesGcm, sealAesGcm, type AesGcmSealingProfile } from '../sealing/aes-gcm-sealing';

export const GOOGLE_TOKEN_SEAL_VERSION = 'aes-gcm.1';
export const GOOGLE_TOKEN_PURPOSE = 'google.refresh_token';

const PROFILE: AesGcmSealingProfile = Object.freeze({
  header: Uint8Array.from([0x4c, 0x47, 0x54, 0x01]),
  version: GOOGLE_TOKEN_SEAL_VERSION,
});

export interface GoogleTokenBinding {
  readonly organizationId: string;
  readonly userId: string;
  readonly googleSubject: string;
}

export interface SealedGoogleToken {
  readonly sealVersion: string;
  readonly keyRef: string;
  readonly sealed: Uint8Array;
}

export class GoogleTokenUnopenable extends Error {
  constructor() {
    super('stored Google credential could not be opened');
    this.name = 'GoogleTokenUnopenable';
  }
}

/** A stable, non-reversible name for a key: `google-token/<16 hex>`. */
export function googleTokenKeyRef(key: Uint8Array): string {
  const digest = createHash('sha256').update('loop-google-token-key-ref:').update(Buffer.from(key)).digest('hex');
  return `google-token/${digest.slice(0, 16)}`;
}

function binding(b: GoogleTokenBinding): string[] {
  return [b.organizationId, b.userId, b.googleSubject, GOOGLE_TOKEN_PURPOSE];
}

export class GoogleTokenSealer {
  readonly keyRef: string;
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    this.keyRef = googleTokenKeyRef(key);
    this.key = aesGcmSealingKey(this.keyRef, key);
  }

  seal(b: GoogleTokenBinding, token: string): SealedGoogleToken {
    if (typeof token !== 'string' || token === '') throw new Error('a token is required');
    return {
      sealVersion: GOOGLE_TOKEN_SEAL_VERSION,
      keyRef: this.keyRef,
      sealed: sealAesGcm(PROFILE, this.key, this.keyRef, binding(b), new TextEncoder().encode(token)),
    };
  }

  open(b: GoogleTokenBinding, payload: SealedGoogleToken): string {
    if (payload.sealVersion !== GOOGLE_TOKEN_SEAL_VERSION || payload.keyRef !== this.keyRef) throw new GoogleTokenUnopenable();
    const opened = openAesGcm(PROFILE, this.key, this.keyRef, binding(b), payload.sealed);
    if (!opened) throw new GoogleTokenUnopenable();
    return new TextDecoder().decode(opened);
  }
}
