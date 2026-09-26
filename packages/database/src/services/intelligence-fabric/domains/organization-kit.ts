// Shared pieces of the ORGANIZATION domain producers. Loop Intelligence Phase E, 2026-09-26.
//
// An organization reading is built from Loop's own records as AGGREGATES and CANONICAL REFERENCES --
// never a person's name, never free text a customer wrote. The model (when its task is activated) is
// handed exactly the rule reading's signals: each one a structured block whose figures are the only
// numbers the answer may use, whose source ref is the only thing it may cite. It can say what the facts
// mean; it cannot add a fact.

import { createHash } from 'node:crypto';
import { entityRefRefusal, type AiContextItem, type AiSupportedEvidence, type AiTaskDefinition, type IntelligenceSignal } from '@emgloop/shared';

import type { IntelligenceRefreshTarget } from '../../../repositories/intelligence/intelligence-refresh-queue.repository';
import type { DomainReadingFraming } from '../../ai-runtime/templates/domain-reading';
import type { ModelStage, RuleReading } from '../domain-kit';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A stable fingerprint of everything that should change a reading. */
export function fingerprintOf(domain: string, parts: unknown): string {
  return `${domain.toLowerCase()}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

/** The organization's DOMAIN target for a domain. */
export function organizationTarget(organizationId: string, domain: IntelligenceRefreshTarget['domain']): IntelligenceRefreshTarget {
  return { scope: 'ORGANIZATION', organizationId, domain, subjectKind: 'DOMAIN', subjectRef: 'domain' };
}

/** A canonical reference, or null when the id cannot be one (never a guessed or mangled reference). */
export function safeRef(ref: string): string | null {
  return entityRefRefusal(ref, 'ORGANIZATION') === null ? ref : null;
}

/**
 * The change between two COMPARABLE windows, as a whole percent, or null when there is nothing honest to
 * say: no prior activity (a start is not a percentage change) or too little of either to mean anything.
 */
export function comparableChange(current: number, prior: number, minimum = 5): number | null {
  if (prior <= 0 || Math.max(current, prior) < minimum) return null;
  return Math.round(((current - prior) / prior) * 100);
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whole currency units from minor units, for a statement (the MEASURED metric keeps the minor units). */
export function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/**
 * The model stage every organization domain shares: the rule's signals, one structured block each.
 * Figures per source ref are the signal's metric value and every number its statement states.
 */
export function organizationModelStage<C>(task: AiTaskDefinition, framing: DomainReadingFraming): ModelStage<C> {
  const resource = task.requires[0]?.resource ?? 'intelligence';
  return {
    task,
    framing,
    context(_ctx: C, rule: RuleReading) {
      const figures = new Map<string, Set<number>>();
      const dates = new Set<string>();
      const entityRefs = new Set<string>(rule.entityRefs);
      const items: AiContextItem[] = [];
      const add = (ref: string, numbers: Iterable<number>) => {
        const set = figures.get(ref) ?? new Set<number>();
        for (const n of numbers) set.add(n);
        figures.set(ref, set);
      };
      rule.signals.forEach((s: IntelligenceSignal, i) => {
        const ref = s.evidenceRefs[0]!;
        const numbers = [...(s.statement.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])].map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
        if (s.metric) numbers.push(s.metric.value);
        add(ref, numbers);
        for (const e of s.entities ?? []) entityRefs.add(e);
        for (const d of [s.occurredAt, s.dueAt, s.asOf]) if (d) dates.add(d.slice(0, 10));
        items.push({
          blockId: `s${i}.${s.key}`.slice(0, 64),
          kind: 'STRUCTURED',
          trust: 'GOVERNED_FACT',
          sourceRef: ref,
          content: JSON.stringify({ kind: s.kind, knowledge: s.knowledge, statement: s.statement, metric: s.metric ?? null, entities: s.entities ?? [], severity: s.severity ?? null }),
          sensitivity: 'OPERATIONAL',
          readUnder: { resource, action: 'view' },
        });
      });
      const evidence: AiSupportedEvidence = { figures, dates, entityRefs };
      return { items, evidence };
    },
  };
}
