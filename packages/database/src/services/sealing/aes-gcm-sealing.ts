// AES-256-GCM sealing, bound to where a secret belongs. The ONE implementation.
//
// Used by the Brain checkpoint sealer (services/brain/brain-payload-sealer.ts) and the
// Google refresh-token sealer (services/google/google-token-sealer.ts). Each names a
// PROFILE -- a four-byte header and a version -- and the BINDING fields its payload
// belongs to. Nothing here reads an environment variable or a key service: the caller
// hands in 32 bytes and the reference that names them.
//
// FORMAT: <4-byte header> | 12-byte IV | ciphertext | 16-byte tag. The header names the
// kind of payload, so bytes sealed for one purpose are never parsed as another's.
//
// ASSOCIATED DATA: JSON [version, keyRef, ...binding]. A payload copied onto another
// row, organization, person or purpose does not open, and a payload cannot be relabelled
// as sealed by another key.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface AesGcmSealingProfile {
  /** Exactly four bytes, unique per payload kind. */
  readonly header: Uint8Array;
  readonly version: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_REF = /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/;

/** Throws unless `keyRef` is a well-formed reference and `key` is exactly 32 bytes. */
export function aesGcmSealingKey(keyRef: string, key: Uint8Array): Buffer {
  if (!KEY_REF.test(keyRef)) throw new Error('invalid key reference');
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('a 32-byte key is required');
  return Buffer.from(key);
}

function associatedData(profile: AesGcmSealingProfile, keyRef: string, binding: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify([profile.version, keyRef, ...binding]), 'utf8');
}

export function sealAesGcm(
  profile: AesGcmSealingProfile,
  key: Buffer,
  keyRef: string,
  binding: readonly string[],
  plaintext: Uint8Array,
): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(profile, keyRef, binding));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from(profile.header), iv, body, cipher.getAuthTag()]));
}

/**
 * The plaintext, or null when the payload does not open: a wrong header, key, binding or
 * version, a truncated payload, or tampered bytes. Which check failed is deliberately not
 * reported -- it is not a hint worth giving.
 */
export function openAesGcm(
  profile: AesGcmSealingProfile,
  key: Buffer,
  keyRef: string,
  binding: readonly string[],
  sealed: Uint8Array,
): Uint8Array | null {
  const bytes = Buffer.from(sealed);
  const header = Buffer.from(profile.header);
  if (bytes.byteLength < header.byteLength + IV_BYTES + TAG_BYTES || !bytes.subarray(0, header.byteLength).equals(header)) {
    return null;
  }
  const iv = bytes.subarray(header.byteLength, header.byteLength + IV_BYTES);
  const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
  const body = bytes.subarray(header.byteLength + IV_BYTES, bytes.byteLength - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(profile, keyRef, binding));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
}
