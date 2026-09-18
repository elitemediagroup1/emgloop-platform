// The Intelligence workspace's filter, read from the URL. Pure, so it can be tested
// without a request. Every key is a way to NARROW what Loop already found -- none
// names an organization, a person or a record, and an unknown value is ignored.

import {
  confidenceOf,
  situationKind,
  type PriorityState,
  type Situation,
  type SituationKind,
} from '@emgloop/shared';

export const INTEL_LANES = ['needs-review', 'watching', 'assigned', 'resolved', 'dismissed', 'all'] as const;
export type IntelLane = (typeof INTEL_LANES)[number];

export const LANE_STATE: Readonly<Record<Exclude<IntelLane, 'all'>, PriorityState>> = Object.freeze({
  'needs-review': 'NEEDS_REVIEW',
  watching: 'WATCHING',
  assigned: 'ASSIGNED',
  resolved: 'RESOLVED',
  dismissed: 'DISMISSED',
});

export const INTEL_ENTITIES = ['buyer', 'vendor', 'source', 'campaign', 'bids', 'market'] as const;
export type IntelEntity = (typeof INTEL_ENTITIES)[number];
export const INTEL_KINDS = ['risk', 'opportunity', 'investigation', 'watch'] as const;
export const INTEL_CONFIDENCE = ['high', 'moderate', 'low', 'insufficient'] as const;

export interface IntelFilter {
  readonly lane: IntelLane;
  readonly entity: IntelEntity | null;
  readonly kind: (typeof INTEL_KINDS)[number] | null;
  readonly confidence: (typeof INTEL_CONFIDENCE)[number] | null;
  /** The lead finding's metric, e.g. "revenue" -- a metric family, as the engine names it. */
  readonly metric: string | null;
}

function one(params: Readonly<Record<string, string | string[] | undefined>> | undefined, key: string): string {
  const v = params?.[key];
  return (typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : '').trim();
}
function pick<T extends string>(list: readonly T[], raw: string): T | null {
  return (list as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function readIntelFilter(params: Readonly<Record<string, string | string[] | undefined>> | undefined): IntelFilter {
  const metric = one(params, 'metric');
  return {
    lane: pick(INTEL_LANES, one(params, 'lane')) ?? 'needs-review',
    entity: pick(INTEL_ENTITIES, one(params, 'entity')),
    kind: pick(INTEL_KINDS, one(params, 'kind')),
    confidence: pick(INTEL_CONFIDENCE, one(params, 'confidence')),
    metric: /^[A-Za-z][A-Za-z0-9_.-]{0,60}$/.test(metric) ? metric : null,
  };
}

const KIND_OF: Readonly<Record<SituationKind, IntelFilter['kind']>> = {
  RISK: 'risk',
  OPPORTUNITY: 'opportunity',
  NEEDS_INVESTIGATION: 'investigation',
  WATCH: 'watch',
};

/** What a Situation is about, by the entity its lead finding names. No entity: the market as a whole. */
export function situationEntity(s: Situation): IntelEntity {
  const t = s.observations[0]?.affectedEntities[0]?.entityType;
  switch (t) {
    case 'buyer': return 'buyer';
    case 'vendor': return 'vendor';
    case 'source': return 'source';
    case 'campaign': return 'campaign';
    case 'bid_source':
    case 'bid_destination': return 'bids';
    default: return 'market';
  }
}

export function matchesIntelFilter(item: { readonly situation: Situation; readonly state: PriorityState }, f: IntelFilter): boolean {
  if (f.lane !== 'all' && item.state !== LANE_STATE[f.lane]) return false;
  const s = item.situation;
  if (f.entity && situationEntity(s) !== f.entity) return false;
  if (f.kind && KIND_OF[situationKind(s)] !== f.kind) return false;
  if (f.confidence && confidenceOf(s).strength.toLowerCase() !== f.confidence) return false;
  if (f.metric && (s.observations[0]?.primaryMetric ?? null) !== f.metric) return false;
  return true;
}

/** The query for a filter, keeping the period. Only keys that narrow are written. */
export function intelQuery(periodQuery: string, f: IntelFilter, over: Partial<IntelFilter> = {}): string {
  const next = { ...f, ...over };
  const params = new URLSearchParams(periodQuery);
  if (next.lane !== 'needs-review') params.set('lane', next.lane);
  if (next.entity) params.set('entity', next.entity);
  if (next.kind) params.set('kind', next.kind);
  if (next.confidence) params.set('confidence', next.confidence);
  if (next.metric) params.set('metric', next.metric);
  return params.toString();
}
