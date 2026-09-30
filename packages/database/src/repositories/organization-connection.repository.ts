// OrganizationConnectionRepository -- credentials and health of connections an ORGANIZATION owns (2026-09-30).
//
// The organization sibling of SourceConnectionRepository (which holds one PERSON's Teams/Telegram
// connection). Rows live in provider_connections, keyed (organizationId, category, provider): every read and
// write names the organization first and resolves the row within it, so another organization's connection
// is not-found, never a row this method can touch.
//
// SEALED BYTES ONLY. The repository stores what OrganizationCredentialSealer produced and returns it to the
// caller that opens it with the same binding; a payload read for organization A and opened as organization B
// throws. It never sees a raw credential.
//
// Nothing writes a credential yet -- no connector exists (the website evidence foundation declares GA4, Search
// Console, Bing Webmaster and Clarity but connects none). The attempt/success/failure/backoff columns are the
// shape a connector will report through `recordAttempt`.

import type { PrismaClient, ProviderCategory, ProviderConnection } from '@prisma/client';
import {
  organizationConnectionState,
  type OrganizationConnectionState,
} from '@emgloop/shared';
import type { SealedOrganizationCredential } from '../services/connections/organization-credential-sealer';

export interface OrganizationConnectionKey {
  readonly provider: string;
  readonly category: ProviderCategory;
}

export interface StoredOrganizationCredential extends SealedOrganizationCredential {
  readonly credentialKind: string;
}

export type OrganizationConnectionAttempt =
  | { readonly succeeded: true; readonly at: Date }
  | { readonly succeeded: false; readonly at: Date; readonly failureClass: string; readonly backoffUntil: Date | null };

const FAILURE_CLASS = /^[A-Z][A-Z0-9_]{1,63}$/;

export class OrganizationConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private find(organizationId: string, key: OrganizationConnectionKey): Promise<ProviderConnection | null> {
    return this.prisma.providerConnection.findFirst({
      where: { organizationId, category: key.category, provider: key.provider },
    });
  }

  /** Store a sealed credential on this organization's connection, creating the connection if needed. */
  async storeCredential(
    organizationId: string,
    key: OrganizationConnectionKey,
    credential: StoredOrganizationCredential,
    connectedByUserId: string | null,
  ): Promise<{ id: string }> {
    const data = {
      credentialKind: credential.credentialKind,
      secretSealed: Buffer.from(credential.sealed),
      sealVersion: credential.sealVersion,
      keyRef: credential.keyRef,
      connectedByUserId,
      revokedAt: null,
      lastFailureClass: null,
      backoffUntil: null,
    };
    const row = await this.prisma.providerConnection.upsert({
      where: { organizationId_category_provider: { organizationId, category: key.category, provider: key.provider } },
      create: { organizationId, category: key.category, provider: key.provider, status: 'PENDING', ...data },
      update: data,
      select: { id: true },
    });
    return row;
  }

  /** This organization's sealed credential, or null when there is none, or it was revoked. */
  async sealedCredential(organizationId: string, key: OrganizationConnectionKey): Promise<StoredOrganizationCredential | null> {
    const row = await this.find(organizationId, key);
    if (!row || row.revokedAt || !row.secretSealed || !row.sealVersion || !row.keyRef || !row.credentialKind) return null;
    return { credentialKind: row.credentialKind, sealVersion: row.sealVersion, keyRef: row.keyRef, sealed: new Uint8Array(row.secretSealed) };
  }

  /** Record one read attempt. A success marks the connection CONNECTED; a failure keeps its last success. */
  async recordAttempt(organizationId: string, key: OrganizationConnectionKey, attempt: OrganizationConnectionAttempt): Promise<boolean> {
    const row = await this.find(organizationId, key);
    if (!row || row.revokedAt) return false;
    if (!attempt.succeeded && !FAILURE_CLASS.test(attempt.failureClass)) throw new Error('invalid failure class');
    await this.prisma.providerConnection.update({
      where: { id: row.id },
      data: attempt.succeeded
        ? { lastAttemptAt: attempt.at, lastSucceededAt: attempt.at, lastFailureClass: null, backoffUntil: null, status: 'CONNECTED', connectedAt: row.connectedAt ?? attempt.at }
        : { lastAttemptAt: attempt.at, lastFailureClass: attempt.failureClass, backoffUntil: attempt.backoffUntil, status: row.status === 'CONNECTED' ? 'CONNECTED' : 'ERROR' },
    });
    return true;
  }

  /** Revoke: the sealed bytes are removed, not merely flagged. Null when this organization has no such connection. */
  async revoke(organizationId: string, key: OrganizationConnectionKey, at: Date): Promise<boolean> {
    const row = await this.find(organizationId, key);
    if (!row) return false;
    await this.prisma.providerConnection.update({
      where: { id: row.id },
      data: { secretSealed: null, sealVersion: null, keyRef: null, credentialKind: null, revokedAt: at, status: 'DISCONNECTED' },
    });
    return true;
  }

  /** The state of each named connection for this organization -- NOT_CONNECTED where no row exists. */
  async states(
    organizationId: string,
    keys: readonly OrganizationConnectionKey[],
    now: Date,
  ): Promise<Map<string, OrganizationConnectionState>> {
    const rows = keys.length === 0 ? [] : await this.prisma.providerConnection.findMany({
      where: { organizationId, OR: keys.map((k) => ({ category: k.category, provider: k.provider })) },
      select: { category: true, provider: true, status: true, revokedAt: true, lastAttemptAt: true, lastSucceededAt: true, lastFailureClass: true, backoffUntil: true },
    });
    const out = new Map<string, OrganizationConnectionState>();
    for (const k of keys) {
      const row = rows.find((r) => r.category === k.category && r.provider === k.provider) ?? null;
      out.set(k.provider, organizationConnectionState(row, now));
    }
    return out;
  }
}
