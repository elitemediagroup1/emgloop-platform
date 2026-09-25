// One mapping from a conversation reading to digest content, for EVERY conversation domain: Telegram chats
// (the connections worker) and mail threads (Loop Intelligence Phase D). Extracted from the worker's
// Chats v5 builder so the two can never write different shapes for the same kind of reading.
//
// The TYPED reading and signals (participation contract) are the record; the PR A lists derive from the
// same signals. Knowledge per signal: CHANGE / DECIDED / OBLIGATION are OBSERVED (a message states them),
// everything else INFERRED. owedBy is contract-relative: VIEWER, COUNTERPARTY (the other side of a
// private conversation) or UNKNOWN (someone in a group) -- never a teammate; the label the conversation
// showed travels as `party`. NO body, NO quote (the gateway refused any).
//
// PURE.

import { createHash } from 'node:crypto';
import {
  DIGEST_LABEL_MAX_CHARS,
  DIGEST_LIST_MAX_ITEMS,
  type DigestContent,
  type IntelligenceOwedBy,
  type IntelligenceReadingStatus,
  type IntelligenceSignal,
  type IntelligenceSignalKind,
} from '@emgloop/shared';

/** A reading as the triage services return it, anchors already keyed. */
export interface KeyedConversationReading {
  readonly relevance: DigestContent['relevance'] & string;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly stateChange: string | null;
  readonly signals: readonly {
    readonly kind: string;
    readonly anchorRef: string;
    readonly statement: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
    readonly owedBy: 'VIEWER' | 'OTHER' | 'UNKNOWN' | null;
    readonly who: string | null;
  }[];
  readonly attention: { readonly needed: boolean; readonly reason: string | null };
  readonly confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

const KIND: Readonly<Record<string, IntelligenceSignalKind>> = Object.freeze({
  CHANGE: 'CHANGE',
  DECIDED: 'CHANGE',
  DECISION_PENDING: 'DECISION_PENDING',
  OBLIGATION: 'OBLIGATION',
  UNRESOLVED: 'UNRESOLVED',
  STALLED: 'STALLED',
  OPPORTUNITY: 'OPPORTUNITY',
  RISK: 'RISK',
  OPERATIONAL: 'OPERATIONAL',
  UPCOMING: 'UPCOMING',
});
const OBSERVED: readonly string[] = Object.freeze(['CHANGE', 'DECIDED', 'OBLIGATION']);

function contractOwedBy(owedBy: 'VIEWER' | 'OTHER' | 'UNKNOWN', kind: 'PRIVATE' | 'GROUP' | null): IntelligenceOwedBy {
  if (owedBy === 'VIEWER') return 'VIEWER';
  if (owedBy === 'OTHER' && kind === 'PRIVATE') return 'COUNTERPARTY';
  return 'UNKNOWN';
}

export interface ConversationDigestOptions {
  /** Evidence ref for an anchor: `telegram_message:<keyed id>`, `mail_message:<thread>:<n>`. */
  readonly evidenceRef: (anchorRef: string) => string;
  /** When each anchor happened, when known. */
  readonly occurredAt: (anchorRef: string) => Date | null;
  /** The source's own label for the conversation, recorded from the provider; null when none. */
  readonly label: string | null;
  /** PRIVATE (two people) or GROUP; decides how OTHER is stored. Null when unknown. */
  readonly kind: 'PRIVATE' | 'GROUP' | null;
  /** Canonical references attached to every signal (the conversation itself). */
  readonly entityRefs: readonly string[];
}

/** The digest content for a reading (null = the model could not read it: limitations only). */
export function conversationDigestContent(
  reading: KeyedConversationReading | null,
  limitations: readonly string[],
  opts: ConversationDigestOptions,
): { readonly content: DigestContent; readonly anchors: readonly string[] } {
  const label = opts.label && opts.label.trim() !== '' ? [...opts.label.trim()].slice(0, DIGEST_LABEL_MAX_CHARS).join('') : null;
  const cleanLimitations = limitations.map((l) => l.trim()).filter((l) => l !== '').slice(0, DIGEST_LIST_MAX_ITEMS);
  if (reading === null) return { content: { ...(label ? { label } : {}), limitations: cleanLimitations }, anchors: [] };
  const anchors: string[] = [];
  const anchor = (ref: string) => {
    if (!anchors.includes(ref)) anchors.push(ref);
    return ref;
  };
  const of = (...kinds: string[]) => reading.signals.filter((s) => kinds.includes(s.kind));
  const texts = (list: readonly { readonly statement: string }[], prefix = '') => list.map((s) => `${prefix}${s.statement}`);
  const signals: IntelligenceSignal[] = reading.signals.map((s, i) => {
    const at = opts.occurredAt(anchor(s.anchorRef));
    const owed = s.kind === 'OBLIGATION' && s.owedBy ? contractOwedBy(s.owedBy, opts.kind) : null;
    return {
      key: `${s.kind.toLowerCase().replace(/_/g, '-')}.${createHash('sha256').update(s.anchorRef).digest('hex').slice(0, 10)}.${i}`,
      kind: KIND[s.kind] ?? 'CHANGE',
      knowledge: OBSERVED.includes(s.kind) ? 'OBSERVED' : 'INFERRED',
      statement: s.kind === 'DECIDED' ? `Decided: ${s.statement}`.slice(0, 280) : s.statement,
      ...(opts.entityRefs.length > 0 ? { entities: [...opts.entityRefs] } : {}),
      evidenceRefs: [opts.evidenceRef(s.anchorRef)],
      ...(at ? { occurredAt: at.toISOString() } : {}),
      severity: s.severity,
      confidence: reading.confidence,
      ...(owed ? { owedBy: owed } : {}),
      ...(owed && s.who ? { party: s.who } : {}),
    };
  });
  const pressing = reading.signals.some((s) => s.severity === 'HIGH' || s.kind === 'DECISION_PENDING' || s.kind === 'STALLED' || s.kind === 'RISK' || (s.kind === 'OBLIGATION' && s.owedBy === 'VIEWER'));
  const status: IntelligenceReadingStatus = reading.attention.needed ? 'ATTENTION' : pressing ? 'WATCH' : 'CALM';
  const content: DigestContent = {
    ...(label ? { label } : {}),
    relevance: reading.relevance,
    synthesis: reading.summary,
    topics: [...reading.topics],
    developments: [...texts(of('CHANGE')), ...texts(of('DECIDED'), 'Decided: ')].slice(0, DIGEST_LIST_MAX_ITEMS),
    commitments: texts(of('OBLIGATION')).slice(0, DIGEST_LIST_MAX_ITEMS),
    opportunities: texts(of('OPPORTUNITY')).slice(0, DIGEST_LIST_MAX_ITEMS),
    concerns: texts(of('RISK')).slice(0, DIGEST_LIST_MAX_ITEMS),
    operational: texts(of('OPERATIONAL')).slice(0, DIGEST_LIST_MAX_ITEMS),
    unresolved: texts(of('UNRESOLVED', 'DECISION_PENDING', 'STALLED')).slice(0, DIGEST_LIST_MAX_ITEMS),
    ...(reading.stateChange ? { stateChange: reading.stateChange } : {}),
    ...(reading.attention.needed && reading.attention.reason ? { attention: reading.attention.reason } : {}),
    confidence: reading.confidence,
    limitations: cleanLimitations,
    reading: { statement: reading.summary, status, confidence: reading.confidence },
    signals,
  };
  return { content, anchors };
}
