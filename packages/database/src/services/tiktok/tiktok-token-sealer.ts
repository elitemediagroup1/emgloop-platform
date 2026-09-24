// Sealing TikTok tokens with a key only the web tier holds.
//
// THE SAME FORMAT AND DISCIPLINE AS THE GOOGLE TOKEN SEALER, through the one shared
// AES-256-GCM core (services/sealing/aes-gcm-sealing.ts), with this payload's own header
// ("LTT" 0x01), so a TikTok token, a Google token and a Brain checkpoint can never be read
// as each other.
//
// TWO PURPOSES UNDER ONE KEY. TikTok issues a refresh token and an access token, and Loop
// stores both sealed. The purpose is part of the binding, so a sealed access token can never
// be opened as the refresh token, or the reverse.
//
// BOUND TO WHOSE TOKEN IT IS. The organization, the Loop user, the TikTok account (open_id)
// and the purpose are the associated data: a sealed token copied onto another person's or
// another organization's row does not open.
//
// THE KEY IS THE CALLER'S. This class is handed 32 bytes (LOOP_TIKTOK_TOKEN_KEY, read by the
// web tier's one environment module). Its reference is derived from the key itself, so
// rotating the key changes the reference and a token sealed under the old key is recognised
// as unopenable -- the creator reconnects -- rather than being tried against the wrong key.
// The key never reaches the database.

import { createHash } from 'crypto';

import { aesGcmSealingKey, openAesGcm, sealAesGcm, type AesGcmSealingProfile } from '../sealing/aes-gcm-sealing';

export const TIKTOK_TOKEN_SEAL_VERSION = 'aes-gcm.1';

export const TIKTOK_TOKEN_PURPOSES = Object.freeze({
  refresh: 'tiktok.refresh_token',
  access: 'tiktok.access_token',
} as const);
export type TikTokTokenPurpose = keyof typeof TIKTOK_TOKEN_PURPOSES;

const PROFILE: AesGcmSealingProfile = Object.freeze({
  header: Uint8Array.from([0x4c, 0x54, 0x54, 0x01]),
  version: TIKTOK_TOKEN_SEAL_VERSION,
});

export interface TikTokTokenBinding {
  readonly organizationId: string;
  readonly userId: string;
  readonly tiktokOpenId: string;
}

export interface SealedTikTokToken {
  readonly sealVersion: string;
  readonly keyRef: string;
  readonly sealed: Uint8Array;
}

export class TikTokTokenUnopenable extends Error {
  constructor() {
    super('stored TikTok credential could not be opened');
    this.name = 'TikTokTokenUnopenable';
  }
}

/** A stable, non-reversible name for a key: `tiktok-token/<16 hex>`. */
export function tiktokTokenKeyRef(key: Uint8Array): string {
  const digest = createHash('sha256').update('loop-tiktok-token-key-ref:').update(Buffer.from(key)).digest('hex');
  return `tiktok-token/${digest.slice(0, 16)}`;
}

function binding(b: TikTokTokenBinding, purpose: TikTokTokenPurpose): string[] {
  return [b.organizationId, b.userId, b.tiktokOpenId, TIKTOK_TOKEN_PURPOSES[purpose]];
}

export class TikTokTokenSealer {
  readonly keyRef: string;
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    this.keyRef = tiktokTokenKeyRef(key);
    this.key = aesGcmSealingKey(this.keyRef, key);
  }

  seal(b: TikTokTokenBinding, purpose: TikTokTokenPurpose, token: string): SealedTikTokToken {
    if (typeof token !== 'string' || token === '') throw new Error('a token is required');
    return {
      sealVersion: TIKTOK_TOKEN_SEAL_VERSION,
      keyRef: this.keyRef,
      sealed: sealAesGcm(PROFILE, this.key, this.keyRef, binding(b, purpose), new TextEncoder().encode(token)),
    };
  }

  open(b: TikTokTokenBinding, purpose: TikTokTokenPurpose, payload: SealedTikTokToken): string {
    if (payload.sealVersion !== TIKTOK_TOKEN_SEAL_VERSION || payload.keyRef !== this.keyRef) throw new TikTokTokenUnopenable();
    const opened = openAesGcm(PROFILE, this.key, this.keyRef, binding(b, purpose), payload.sealed);
    if (!opened) throw new TikTokTokenUnopenable();
    return new TextDecoder().decode(opened);
  }
}
