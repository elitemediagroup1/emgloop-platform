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

import type { BrainPayloadSealer, BrainPayloadSealingContext, BrainSealedPayload } from '../../repositories/brain/brain-records';
import { aesGcmSealingKey, openAesGcm, sealAesGcm, type AesGcmSealingProfile } from '../sealing/aes-gcm-sealing';

export const BRAIN_SEAL_VERSION_AES_GCM = 'aes-gcm.1';

// The shared AES-GCM core (services/sealing/aes-gcm-sealing.ts), with this payload's own
// header. The associated data is [version, keyRef, organizationId, jobId, stepKey,
// inputFingerprint, purpose] -- byte-for-byte what this class wrote before the core was
// shared, so every checkpoint sealed earlier still opens (brain-boundary.test.ts).
const PROFILE: AesGcmSealingProfile = Object.freeze({
  header: Uint8Array.from([0x4c, 0x42, 0x53, 0x01]),
  version: BRAIN_SEAL_VERSION_AES_GCM,
});

export class BrainPayloadUnopenable extends Error {
  constructor() {
    // Deliberately uninformative: which check failed is not a hint worth giving.
    super('checkpoint could not be opened');
    this.name = 'BrainPayloadUnopenable';
  }
}

function binding(context: BrainPayloadSealingContext): string[] {
  const { organizationId, jobId, stepKey, inputFingerprint, purpose } = context;
  return [organizationId, jobId, stepKey, inputFingerprint, purpose];
}

export class AesGcmBrainPayloadSealer implements BrainPayloadSealer {
  private readonly key: Buffer;

  constructor(
    private readonly keyRef: string,
    key: Uint8Array,
  ) {
    this.key = aesGcmSealingKey(keyRef, key);
  }

  async seal(context: BrainPayloadSealingContext, plaintext: Uint8Array): Promise<BrainSealedPayload> {
    return {
      sealVersion: BRAIN_SEAL_VERSION_AES_GCM,
      keyRef: this.keyRef,
      sealed: sealAesGcm(PROFILE, this.key, this.keyRef, binding(context), plaintext),
    };
  }

  async open(context: BrainPayloadSealingContext, payload: BrainSealedPayload): Promise<Uint8Array> {
    if (payload.sealVersion !== BRAIN_SEAL_VERSION_AES_GCM || payload.keyRef !== this.keyRef) throw new BrainPayloadUnopenable();
    const opened = openAesGcm(PROFILE, this.key, this.keyRef, binding(context), payload.sealed);
    if (!opened) throw new BrainPayloadUnopenable();
    return opened;
  }
}
