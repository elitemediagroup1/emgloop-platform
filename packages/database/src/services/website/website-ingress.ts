// Website ingress admission -- which organization a website delivery belongs to, or why it belongs to none.
//
// The ONLY way a website event reaches an organization (2026-09-30): the property it names is registered in
// web_properties, ACTIVE, and -- for the browser tier -- the request came from one of that property's allowed
// domains with that property's public ingest key. Nothing else selects an organization: not the browser's
// `organization` field (ignored), not a domain the request claims, not a default. There is no fallback
// organization; a property no one registered is refused PROPERTY_UNREGISTERED.
//
//   BROWSER tier   the public key pk_emg_<key> names ONE property. Every event in the delivery must be that
//                  property's (an event naming another is PROPERTY_MISMATCH); in production the Origin must be
//                  one of its registered allowed domains (verifyPropertyIngest).
//   SIGNED tier    the HMAC proves the sender holds the shared website secret -- a CLASS of sender, not a
//                  tenant -- so each event's property is resolved on its own, and an event without one is
//                  PROPERTY_MISSING.
//
// Pure over its one port (the property lookup): no write, no clock, no environment.

import { verifyPropertyIngest, type InboundEvent } from '@emgloop/providers';
import {
  webPropertyIngestKey,
  webPropertyKeyFromIngestKey,
  type WebsiteIngestRefusal,
} from '@emgloop/shared';
import type { WebPropertyAdmission, WebPropertyRepository } from '../../repositories/web-property.repository';

export interface WebsiteDeliveryInput {
  readonly tier: 'BROWSER' | 'SIGNED';
  /** The public ingest key the browser tier presented (header or body). */
  readonly ingestKey?: string;
  /** The request's Origin/Referer host, no scheme or port. */
  readonly originHost?: string;
  /** Whether allowed-domain checks are enforced (production). Key and registration are ALWAYS enforced. */
  readonly enforceDomain: boolean;
  /** Parsed by WebsiteProvider: payload.property is the CLAIMED property ('' when absent or malformed). */
  readonly events: readonly InboundEvent[];
}

export interface WebsiteAdmittedBatch {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly propertyKey: string;
  readonly events: InboundEvent[];
}

export interface WebsiteAdmission {
  /** The whole delivery was refused (browser tier: the key, registration or origin failed). */
  readonly refusal: WebsiteIngestRefusal | null;
  /** The property a whole-delivery refusal is attributable to, when one resolved (for its organization's diagnostics). */
  readonly refusedProperty: WebPropertyAdmission | null;
  readonly batches: readonly WebsiteAdmittedBatch[];
  /** Events refused one by one. Codes and positions only -- never the claimed value. */
  readonly rejected: readonly { readonly index: number; readonly code: WebsiteIngestRefusal }[];
}

type Lookup = Pick<WebPropertyRepository, 'resolveForIngest'>;

function claimedProperty(ev: InboundEvent): string {
  const p = ev.payload['property'];
  return typeof p === 'string' ? p : '';
}

/** Bind an event to the property that admitted it: its payload and its id namespace name that property. */
function bound(ev: InboundEvent, key: string): InboundEvent {
  if (claimedProperty(ev) === key) return ev;
  return {
    ...ev,
    externalId: ev.externalId.replace(/^web:unregistered:/, `web:${key}:`),
    payload: { ...ev.payload, property: key },
  };
}

export async function admitWebsiteDelivery(properties: Lookup, input: WebsiteDeliveryInput): Promise<WebsiteAdmission> {
  const refuse = (refusal: WebsiteIngestRefusal, refusedProperty: WebPropertyAdmission | null = null): WebsiteAdmission => ({
    refusal,
    refusedProperty,
    batches: [],
    rejected: [],
  });

  if (input.tier === 'BROWSER') {
    const presented = String(input.ingestKey ?? '').trim();
    if (!presented) return refuse('MISSING_INGEST_KEY');
    const key = webPropertyKeyFromIngestKey(presented);
    const property = key ? await properties.resolveForIngest(key) : null;
    if (!property) return refuse('PROPERTY_UNREGISTERED');
    if (property.status !== 'ACTIVE') return refuse('PROPERTY_DISABLED', property);
    const origin = verifyPropertyIngest(
      { ingestKey: presented, originHost: input.originHost ?? '', enforceDomain: input.enforceDomain },
      [{ key: property.key, ingestKey: webPropertyIngestKey(property.key), allowedDomains: [...property.allowedDomains] }],
    );
    if (!origin.valid) return refuse(origin.reason === 'missing-origin' ? 'MISSING_ORIGIN' : 'DOMAIN_NOT_ALLOWED', property);

    const events: InboundEvent[] = [];
    const rejected: { index: number; code: WebsiteIngestRefusal }[] = [];
    input.events.forEach((ev, index) => {
      const claimed = claimedProperty(ev);
      if (claimed !== '' && claimed !== property.key) rejected.push({ index, code: 'PROPERTY_MISMATCH' });
      else events.push(bound(ev, property.key));
    });
    return {
      refusal: null,
      refusedProperty: null,
      batches: events.length > 0 ? [{ organizationId: property.organizationId, propertyId: property.id, propertyKey: property.key, events }] : [],
      rejected,
    };
  }

  const cache = new Map<string, WebPropertyAdmission | null>();
  const byProperty = new Map<string, WebsiteAdmittedBatch>();
  const rejected: { index: number; code: WebsiteIngestRefusal }[] = [];
  for (let index = 0; index < input.events.length; index++) {
    const ev = input.events[index]!;
    const key = claimedProperty(ev);
    if (!key) {
      rejected.push({ index, code: 'PROPERTY_MISSING' });
      continue;
    }
    if (!cache.has(key)) cache.set(key, await properties.resolveForIngest(key));
    const property = cache.get(key) ?? null;
    if (!property) {
      rejected.push({ index, code: 'PROPERTY_UNREGISTERED' });
      continue;
    }
    if (property.status !== 'ACTIVE') {
      rejected.push({ index, code: 'PROPERTY_DISABLED' });
      continue;
    }
    const batch = byProperty.get(property.id) ?? { organizationId: property.organizationId, propertyId: property.id, propertyKey: property.key, events: [] };
    batch.events.push(ev);
    byProperty.set(property.id, batch);
  }
  return { refusal: null, refusedProperty: null, batches: [...byProperty.values()], rejected };
}
