// Sealing a Brain checkpoint with a key the caller holds. Slice B5.
//
// Architecture: brain-persistence.md §6 ("Checkpoints are sealed") and §13.
//
// AES-256-GCM, BOUND TO WHERE THE PAYLOAD BELONGS. The organization, job, step, input
// fingerprint and purpose are authenticated as associated data, so a checkpoint copied
// onto another job, step or organization does not open. The key reference is bound too,
// so a payload cannot be relabelled as sealed by another key.
//
// THE KEY IS THE CALLER'S. This class is handed 32 bytes and a key reference; it never
// reads an environment variable or a key service. The in-process runner (tests and
// development) hands it a random key. The execution environment (B6) hands it a data
// key its key service unwrapped, and names that wrapped key in `keyRef` -- the envelope
// pattern, with the same format.
//
// FORMAT `aes-gcm.1`: "LBS" 0x01 | 12-byte IV | ciphertext | 16-byte tag. The binary
// header also keeps the persistence fence (`brainSealedPayloadRefusals`) from ever
// mistaking a sealed payload for text.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import type { BrainPayloadSealer, BrainPayloadSealingContext, BrainSealedPayload } from '../../repositories/brain/brain-records';

export const BRAIN_SEAL_VERSION_AES_GCM = 'aes-gcm.1';

const HEADER = Buffer.from([0x4c, 0x42, 0x53, 0x01]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_REF = /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/;

export class BrainPayloadUnopenable extends Error {
  constructor() {
    // Deliberately uninformative: which check failed is not a hint worth giving.
    super('checkpoint could not be opened');
    this.name = 'BrainPayloadUnopenable';
  }
}

function associatedData(keyRef: string, context: BrainPayloadSealingContext): Buffer {
  const { organizationId, jobId, stepKey, inputFingerprint, purpose } = context;
  return Buffer.from(JSON.stringify([BRAIN_SEAL_VERSION_AES_GCM, keyRef, organizationId, jobId, stepKey, inputFingerprint, purpose]), 'utf8');
}

export class AesGcmBrainPayloadSealer implements BrainPayloadSealer {
  private readonly key: Buffer;

  constructor(
    private readonly keyRef: string,
    key: Uint8Array,
  ) {
    if (!KEY_REF.test(keyRef)) throw new Error('invalid key reference');
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('a 32-byte key is required');
    this.key = Buffer.from(key);
  }

  async seal(context: BrainPayloadSealingContext, plaintext: Uint8Array): Promise<BrainSealedPayload> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(this.keyRef, context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      sealVersion: BRAIN_SEAL_VERSION_AES_GCM,
      keyRef: this.keyRef,
      sealed: new Uint8Array(Buffer.concat([HEADER, iv, body, cipher.getAuthTag()])),
    };
  }

  async open(context: BrainPayloadSealingContext, payload: BrainSealedPayload): Promise<Uint8Array> {
    const bytes = Buffer.from(payload.sealed);
    if (
      payload.sealVersion !== BRAIN_SEAL_VERSION_AES_GCM ||
      payload.keyRef !== this.keyRef ||
      bytes.byteLength < HEADER.byteLength + IV_BYTES + TAG_BYTES ||
      !bytes.subarray(0, HEADER.byteLength).equals(HEADER)
    ) {
      throw new BrainPayloadUnopenable();
    }
    const iv = bytes.subarray(HEADER.byteLength, HEADER.byteLength + IV_BYTES);
    const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
    const body = bytes.subarray(HEADER.byteLength + IV_BYTES, bytes.byteLength - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(this.keyRef, context));
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      throw new BrainPayloadUnopenable();
    }
  }
}
