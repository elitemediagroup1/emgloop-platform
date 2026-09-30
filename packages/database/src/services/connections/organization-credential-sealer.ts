// Sealing for ORGANIZATION-OWNED connection credentials (2026-09-30): a credential an organization -- not a
// person -- connected, such as a Microsoft Clarity project token or a Bing Webmaster refresh token. The
// organization sibling of ConnectionSecretSealer (which binds a PERSON's Teams/Telegram secret).
//
// The AES-256-GCM core (services/sealing), this payload's own 4-byte header and version, and
// (organization, provider, credentialKind, purpose) as associated data -- so a credential sealed for one
// organization does NOT open for another, nor for another provider or kind, even when the bytes are copied
// row to row. A key rotation makes old credentials unopenable (reconnect), never silently wrong.
//
// Nothing seals a credential yet: no connector exists. The raw value is never logged, never returned except
// by open() to the caller that needs it, and never given to a model.
import { createHash } from 'crypto';
import { aesGcmSealingKey, openAesGcm, sealAesGcm, type AesGcmSealingProfile } from '../sealing/aes-gcm-sealing';

export const ORGANIZATION_CREDENTIAL_SEAL_VERSION = 'aes-gcm.1';
export const ORGANIZATION_CREDENTIAL_PURPOSE = 'organization.credential';

// 'L','O','C',1 -- distinct from every other sealed payload's header, so bytes are never cross-parsed.
const PROFILE: AesGcmSealingProfile = Object.freeze({
  header: Uint8Array.from([0x4c, 0x4f, 0x43, 0x01]),
  version: ORGANIZATION_CREDENTIAL_SEAL_VERSION,
});

const PROVIDER = /^[a-z][a-z0-9_]{1,47}$/;
const KIND = /^[A-Z][A-Z0-9_]{1,47}$/;

export interface OrganizationCredentialBinding {
  readonly organizationId: string;
  /** The provider-connection provider id, e.g. 'microsoft_clarity'. */
  readonly provider: string;
  /** e.g. 'API_TOKEN', 'OAUTH_REFRESH_TOKEN'. */
  readonly credentialKind: string;
}

export interface SealedOrganizationCredential {
  readonly sealVersion: string;
  readonly keyRef: string;
  readonly sealed: Uint8Array;
}

export class OrganizationCredentialUnopenable extends Error {
  constructor() {
    super('stored organization credential could not be opened');
    this.name = 'OrganizationCredentialUnopenable';
  }
}

/** A stable, non-reversible name for a key: `organization-credential/<16 hex>`. */
export function organizationCredentialKeyRef(key: Uint8Array): string {
  const digest = createHash('sha256').update('loop-organization-credential-key-ref:').update(Buffer.from(key)).digest('hex');
  return `organization-credential/${digest.slice(0, 16)}`;
}

function binding(b: OrganizationCredentialBinding): string[] {
  if (!b.organizationId || !PROVIDER.test(b.provider) || !KIND.test(b.credentialKind)) {
    throw new Error('invalid organization credential binding');
  }
  return [b.organizationId, b.provider, b.credentialKind, ORGANIZATION_CREDENTIAL_PURPOSE];
}

export class OrganizationCredentialSealer {
  readonly keyRef: string;
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    this.keyRef = organizationCredentialKeyRef(key);
    this.key = aesGcmSealingKey(this.keyRef, key);
  }

  seal(b: OrganizationCredentialBinding, secret: string): SealedOrganizationCredential {
    if (typeof secret !== 'string' || secret === '') throw new Error('an organization credential is required');
    return {
      sealVersion: ORGANIZATION_CREDENTIAL_SEAL_VERSION,
      keyRef: this.keyRef,
      sealed: sealAesGcm(PROFILE, this.key, this.keyRef, binding(b), new TextEncoder().encode(secret)),
    };
  }

  open(b: OrganizationCredentialBinding, payload: SealedOrganizationCredential): string {
    if (payload.sealVersion !== ORGANIZATION_CREDENTIAL_SEAL_VERSION || payload.keyRef !== this.keyRef) {
      throw new OrganizationCredentialUnopenable();
    }
    const opened = openAesGcm(PROFILE, this.key, this.keyRef, binding(b), payload.sealed);
    if (!opened) throw new OrganizationCredentialUnopenable();
    return new TextDecoder().decode(opened);
  }
}
