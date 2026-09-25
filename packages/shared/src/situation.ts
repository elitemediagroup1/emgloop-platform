// Situations: connected business situations, held as Cases. Loop Intelligence Phase F, 2026-09-26.
//
// A SITUATION IS A CASE. Cases (operational_priorities, their observation log and evidence) are already
// Loop's authority for "a business situation somebody should look at"; Loop synthesis writes into that
// SAME authority -- no new situation table, no second Headline object. The measured-change `headlines`
// table stays exactly what it is: evidence of measured movement.
//
// VISIBILITY FOLLOWS THE MOST RESTRICTIVE EVIDENCE. A situation connected only from organization
// intelligence is the organization's (sourceSystem SITUATION_SOURCE). A situation that cites ANY
// person's private intelligence (their Mail, Chats, Calendar or own Work) is PRIVATE to that person
// (sourceSystem PRIVATE_SITUATION_SOURCE, its one owner in case_private_scopes) -- never shown to anyone
// else, whatever their role. Every organization-level Case read excludes the private source
// (CASE_ORGANIZATION_WHERE), which works on either side of the migration because `sourceSystem` has
// always existed; a private Case whose scope row is missing is visible to nobody (fail closed).
//
// PURE.

import type { IntelligenceSignal } from './intelligence-contract';

export const SITUATION_SOURCE = 'loop-situation';
export const PRIVATE_SITUATION_SOURCE = 'loop-situation:private';

/** The filter every organization-level Case read carries: never a private situation. */
export const CASE_ORGANIZATION_WHERE = Object.freeze({ NOT: Object.freeze({ sourceSystem: PRIVATE_SITUATION_SOURCE }) });

/** The visibility of a situation that cites evidence of these scopes: the most restrictive wins. */
export function situationVisibility(scopes: readonly ('PRINCIPAL' | 'ORGANIZATION')[]): 'PRINCIPAL' | 'ORGANIZATION' {
  return scopes.includes('PRINCIPAL') ? 'PRINCIPAL' : 'ORGANIZATION';
}

/** Two signals are temporally compatible when they happened within this many days of each other. */
export const SITUATION_TEMPORAL_WINDOW_DAYS = 14;
/** A cluster becomes a situation candidate only across at least this many domains. */
export const SITUATION_MIN_DOMAINS = 2;
export const SITUATION_MAX_SIGNALS = 16;
export const SITUATION_MAX_OPEN_CANDIDATES = 5;

/** Verification states recorded on a situation. UNAVAILABLE is honest: no independent check ran. */
export const SITUATION_VERIFICATION_STATES = ['VERIFIED', 'PARTIAL', 'DISPUTED', 'NOT_VERIFIED', 'UNAVAILABLE'] as const;
export type SituationVerificationState = (typeof SITUATION_VERIFICATION_STATES)[number];

// --- Deterministic clustering -----------------------------------------------------------------------
//
// A CANDIDATE is found without a model: two signals belong together only when they name the SAME
// canonical entity (or two entities an explicit, non-model entity_link joins) and happened within the
// temporal window of each other. A signal that names no entity joins nothing -- co-occurrence in time
// alone is never a connection. A candidate must span at least SITUATION_MIN_DOMAINS domains (a single
// domain's reading already says what its own signals mean).


export interface SituationSignalInput {
  /** The evidence reference the model cites: `digest:<digestId>/<signalKey>`. */
  readonly ref: string;
  readonly domain: string;
  readonly signal: IntelligenceSignal;
  /** When the signal happened (occurredAt, dueAt, asOf, else its digest's generation), epoch ms. */
  readonly at: number;
}

export interface SituationClusterCandidate {
  /** Stable identity of the cluster: its sorted canonical entity roots. Hash it for storage. */
  readonly clusterBasis: string;
  /** Everything that should change the model's answer. Hash it for storage. */
  readonly fingerprintBasis: string;
  readonly items: readonly SituationSignalInput[];
  readonly refs: readonly string[];
  readonly domains: readonly string[];
  readonly windowStart: number;
  readonly windowEnd: number;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });

/** The signal kinds a situation is made of. A plain measurement supports a claim; it does not start one. */
export const SITUATION_SIGNAL_KINDS: readonly string[] = Object.freeze(['CHANGE', 'ATTENTION', 'OPPORTUNITY', 'RISK', 'OBLIGATION', 'DECISION_PENDING', 'UNRESOLVED', 'STALLED', 'QUIET', 'UPCOMING']);

export function clusterSituationSignals(inputs: readonly SituationSignalInput[], links: readonly (readonly [string, string])[]): SituationClusterCandidate[] {
  // Entity roots: explicit links join entities; nothing else does.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const [a, b] of links) join(a, b);

  const items = inputs.filter((i) => SITUATION_SIGNAL_KINDS.includes(i.signal.kind) && (i.signal.entities?.length ?? 0) > 0);
  // Items joined when they share a root entity and are inside the window of each other.
  const window = SITUATION_TEMPORAL_WINDOW_DAYS * 86_400_000;
  const itemParent = items.map((_, i) => i);
  const findItem = (i: number): number => (itemParent[i] === i ? i : (itemParent[i] = findItem(itemParent[i]!)));
  const byRoot = new Map<string, number[]>();
  items.forEach((item, i) => {
    for (const e of new Set(item.signal.entities!.map(find))) byRoot.set(e, [...(byRoot.get(e) ?? []), i]);
  });
  for (const members of byRoot.values()) {
    for (let a = 0; a < members.length; a += 1) {
      for (let b = a + 1; b < members.length; b += 1) {
        const x = members[a]!;
        const y = members[b]!;
        if (Math.abs(items[x]!.at - items[y]!.at) <= window) {
          const rx = findItem(x);
          const ry = findItem(y);
          if (rx !== ry) itemParent[Math.max(rx, ry)] = Math.min(rx, ry);
        }
      }
    }
  }
  const groups = new Map<number, SituationSignalInput[]>();
  items.forEach((item, i) => groups.set(findItem(i), [...(groups.get(findItem(i)) ?? []), item]));

  const out: SituationClusterCandidate[] = [];
  for (const group of groups.values()) {
    const domains = [...new Set(group.map((g) => g.domain))].sort();
    if (domains.length < SITUATION_MIN_DOMAINS) continue;
    const kept = [...group]
      .sort((a, b) => (SEVERITY_RANK[b.signal.severity ?? ''] ?? 0) - (SEVERITY_RANK[a.signal.severity ?? ''] ?? 0) || b.at - a.at || a.ref.localeCompare(b.ref))
      .slice(0, SITUATION_MAX_SIGNALS)
      .sort((a, b) => a.ref.localeCompare(b.ref));
    // Refs that joined this group: shared roots among its members.
    const counts = new Map<string, number>();
    for (const g of kept) for (const e of new Set(g.signal.entities!.map(find))) counts.set(e, (counts.get(e) ?? 0) + 1);
    const roots = [...counts.entries()].filter(([, n]) => n > 1).map(([e]) => e).sort();
    const refs = [...new Set(kept.flatMap((g) => g.signal.entities!))].sort();
    out.push({
      clusterBasis: roots.join('|'),
      fingerprintBasis: JSON.stringify(kept.map((g) => [g.ref, g.signal.kind, g.signal.statement, g.signal.severity ?? null, g.signal.metric?.value ?? null])),
      items: kept,
      refs,
      domains,
      windowStart: Math.min(...kept.map((g) => g.at)),
      windowEnd: Math.max(...kept.map((g) => g.at)),
    });
  }
  const weight = (c: SituationClusterCandidate) => c.domains.length * 10 + Math.max(...c.items.map((i) => SEVERITY_RANK[i.signal.severity ?? ''] ?? 0));
  return out.sort((a, b) => weight(b) - weight(a) || a.clusterBasis.localeCompare(b.clusterBasis)).slice(0, SITUATION_MAX_OPEN_CANDIDATES);
}
