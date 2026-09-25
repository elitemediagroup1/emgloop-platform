// Domain intelligence digests: the contract of `intelligence_digests`. PR A of Loop Intelligence,
// 2026-09-24.
//
// Architecture (approved, Matt, 2026-09-24): AUTHORITATIVE EVIDENCE -> DOMAIN INTELLIGENCE (this)
// -> domain UI / Briefing / future connective intelligence -> Headlines -> Investigation -> Work.
// INTELLIGENCE IS NOT WORK: a digest is never a WorkItem and never becomes one by being stored.
//
// WHAT A DIGEST IS. The minimized, structured reading of one subject (a conversation, a thread,
// or a whole domain) for ONE person, over a window of their own evidence. It holds no body, no
// quote and no message: only short paraphrased fields, each bounded, so the most a digest can
// ever carry is a few kilobytes of Loop's own words, with provenance back to the evidence.
//
// A REBUILDABLE PROJECTION, NOT TRUTH. There is one current row per subject, overwritten when it
// is regenerated. ENGINEERING_PRINCIPLES Rule 1 (append-only) governs TRUTH; a digest is a
// projection of evidence that stays where it is (Rule 2), and its provenance names that evidence
// (Rule 3), so overwriting it loses nothing that cannot be rebuilt.
//
// TWO SCOPES, NEVER MIXED (PR 2, the fabric, 2026-09-26).
//   PRINCIPAL      one person's, readable by that person only -- not by their OWNER, not by an ADMIN,
//                  not by a Super Admin reading "their org". Mail, Chats and Calendar are PRINCIPAL
//                  forever; Work may be PRINCIPAL (a person's own assigned work).
//   ORGANIZATION   the organization's, derived ONLY from governed Loop records (basis LOOP_RECORDS):
//                  CallGrid, Campaigns, Intake, People, Creators, Work, Website. userId is null. The
//                  database refuses an ORGANIZATION row in a private domain, with a provider, or on any
//                  basis but LOOP_RECORDS, so private communication can never become org intelligence.
// There is no read that returns both: a principal read never returns an ORGANIZATION row, and the
// organization read never returns a PRINCIPAL row.
//
// THE PARTICIPATION CONTRACT (`intelligence-contract.ts`) adds the typed `reading` and `signals` every
// domain shares; the registries (`intelligence-registry.ts`) say which domains and sources exist.
//
// PURE. No clock, no I/O; instants are passed in.

import { isIntelligenceCoverage, type IntelligenceCoverage } from './intelligence-coverage';
import {
  intelligenceReadingRefusals,
  intelligenceSignalsRefusals,
  type IntelligenceReading,
  type IntelligenceSignal,
  type IntelligenceWriteContext,
} from './intelligence-contract';

export const INTELLIGENCE_DIGEST_SCOPES = ['PRINCIPAL', 'ORGANIZATION'] as const;
export type IntelligenceDigestScope = (typeof INTELLIGENCE_DIGEST_SCOPES)[number];
/** Both scopes are writable since PR 2 (ORGANIZATION only over governed Loop records). */
export const INTELLIGENCE_DIGEST_WRITABLE_SCOPES = ['PRINCIPAL', 'ORGANIZATION'] as const;

// PIPELINE and WEBSITE added in PR 2 (the fabric). Every domain has an entry in INTELLIGENCE_DOMAIN_REGISTRY.
export const INTELLIGENCE_DOMAINS = ['CHATS', 'MAIL', 'CALENDAR', 'CALLGRID', 'CREATORS', 'WORK', 'CRM', 'CAMPAIGNS', 'PIPELINE', 'WEBSITE'] as const;
export type IntelligenceDomain = (typeof INTELLIGENCE_DOMAINS)[number];

// ENTITY (one canonical entity: a campaign, a creator, a buyer) and EVENT (one meeting) added in PR 2.
export const INTELLIGENCE_SUBJECT_KINDS = ['CONVERSATION', 'THREAD', 'DOMAIN', 'ENTITY', 'EVENT'] as const;
export type IntelligenceSubjectKind = (typeof INTELLIGENCE_SUBJECT_KINDS)[number];

/** The one subjectRef a DOMAIN rollup carries: there is exactly one per (person, domain). */
export const INTELLIGENCE_DOMAIN_SUBJECT_REF = 'domain';

export const INTELLIGENCE_DIGEST_STATUSES = ['CURRENT', 'STALE', 'WITHDRAWN'] as const;
export type IntelligenceDigestStatus = (typeof INTELLIGENCE_DIGEST_STATUSES)[number];

// --- Content: minimized, bounded, validated before it is stored ---------------------------------

export const DIGEST_RELEVANCE = ['BUSINESS', 'NOT_BUSINESS', 'UNCLEAR'] as const;
export type DigestRelevance = (typeof DIGEST_RELEVANCE)[number];

/** Loop's own ordinal reading of how well the evidence supports the digest. Never a percentage. */
export const DIGEST_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DigestConfidence = (typeof DIGEST_CONFIDENCE)[number];

/** The longest any one string in a digest may be. */
export const DIGEST_STRING_MAX_CHARS = 280;
/** The most entries any one list in a digest may hold. */
export const DIGEST_LIST_MAX_ITEMS = 8;

/**
 * The structured intelligence one digest holds. Every field is optional: a digest says what the
 * evidence supported and nothing else. There is NO body, text, quote or message field, and the
 * validator refuses one under any name it recognises.
 */
export interface DigestContent {
  readonly relevance?: DigestRelevance;
  readonly topics?: readonly string[];
  readonly developments?: readonly string[];
  readonly unresolved?: readonly string[];
  readonly commitments?: readonly string[];
  readonly opportunities?: readonly string[];
  readonly concerns?: readonly string[];
  /**
   * Operational signals that are neither upside nor downside (a schedule move, a supplier change).
   * Added 2026-09-25 (Chats Intelligence) for the triage v4 signal kind OPERATIONAL.
   */
  readonly operational?: readonly string[];
  /**
   * Why this subject needs the person's attention now, in one sentence -- present ONLY when it does.
   * Absent is "the reading found no reason", never "nothing needs you" under partial coverage.
   * Added 2026-09-25 (Chats Intelligence) for the triage v4 `attention` reading.
   */
  readonly attention?: string;
  /** What changed since the previous digest of this subject, in one sentence. */
  readonly stateChange?: string;
  /** The one-sentence reading of the whole subject. */
  readonly synthesis?: string;
  readonly confidence?: DigestConfidence;
  /** What the digest could not see or could not conclude. Never omitted to look complete. */
  readonly limitations?: readonly string[];
  /** The typed one-sentence reading of the subject (participation contract, PR 2). */
  readonly reading?: IntelligenceReading;
  /** Typed, evidence-referenced signals (participation contract, PR 2). */
  readonly signals?: readonly IntelligenceSignal[];
}

const LIST_KEYS = ['topics', 'developments', 'unresolved', 'commitments', 'opportunities', 'concerns', 'operational', 'limitations'] as const;
const STRING_KEYS = ['stateChange', 'synthesis', 'attention'] as const;
const CONTRACT_KEYS = ['reading', 'signals'] as const;
export const DIGEST_CONTENT_KEYS: readonly string[] = Object.freeze(['relevance', 'confidence', ...LIST_KEYS, ...STRING_KEYS, ...CONTRACT_KEYS]);

/**
 * What each content field KNOWS: OBSERVED fields state what the evidence itself says (each statement a
 * producer wrote there rests on one piece of evidence its provenance anchors); INFERRED fields are the
 * producer's reading of the whole. A surface that shows an INFERRED field shows it as a reading.
 * `limitations` is neither: it is what the producer could not see. Added 2026-09-25 (Chats Intelligence).
 */
export const DIGEST_KNOWLEDGE = ['OBSERVED', 'INFERRED'] as const;
export type DigestKnowledge = (typeof DIGEST_KNOWLEDGE)[number];
export const DIGEST_FIELD_KNOWLEDGE: Readonly<Record<Exclude<keyof DigestContent, 'limitations' | 'reading' | 'signals'>, DigestKnowledge>> = Object.freeze({
  developments: 'OBSERVED',
  commitments: 'OBSERVED',
  relevance: 'INFERRED',
  topics: 'INFERRED',
  unresolved: 'INFERRED',
  opportunities: 'INFERRED',
  concerns: 'INFERRED',
  operational: 'INFERRED',
  attention: 'INFERRED',
  stateChange: 'INFERRED',
  synthesis: 'INFERRED',
  confidence: 'INFERRED',
});

/**
 * Keys that would carry the evidence itself rather than a reading of it. Refused by name,
 * whatever their value -- a validator that only refused long strings would accept a short quote.
 */
export const DIGEST_FORBIDDEN_KEYS: readonly string[] = Object.freeze(['body', 'text', 'quote', 'message', 'messages', 'content', 'raw', 'excerpt', 'transcript', 'snippet']);

export const DIGEST_CONTENT_REFUSALS = [
  'NOT_AN_OBJECT',
  'FORBIDDEN_KEY',
  'UNKNOWN_KEY',
  'WRONG_TYPE',
  'STRING_TOO_LONG',
  'EMPTY_STRING',
  'LIST_TOO_LONG',
  'UNKNOWN_RELEVANCE',
  'UNKNOWN_CONFIDENCE',
  'CONTENT_TOO_LARGE',
  'INVALID_READING',
  'INVALID_SIGNALS',
] as const;
export type DigestContentRefusal = (typeof DIGEST_CONTENT_REFUSALS)[number];

function boundedString(value: unknown, out: DigestContentRefusal[]): void {
  if (typeof value !== 'string') {
    out.push('WRONG_TYPE');
    return;
  }
  if (value.trim() === '') out.push('EMPTY_STRING');
  // Code points, not UTF-16 units: an emoji is one character to the person reading it.
  if ([...value].length > DIGEST_STRING_MAX_CHARS) out.push('STRING_TOO_LONG');
}

/**
 * Everything wrong with a digest's content. Empty means it may be stored. The check is on the
 * SHAPE, and it is total: an unknown key is refused rather than ignored, so a producer cannot add
 * a field that quietly carries more than this contract allows.
 */
/**
 * The most a stored digest's content may serialize to. The database CHECK holds the same bound (raised
 * from 16384 to 32768 bytes by 20261006000000_intelligence_fabric, for typed signals).
 */
export const DIGEST_CONTENT_MAX_BYTES = 32768;

export function digestContentRefusals(
  content: unknown,
  context: IntelligenceWriteContext = { scope: 'PRINCIPAL', producerKind: null },
): DigestContentRefusal[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ['NOT_AN_OBJECT'];
  const out: DigestContentRefusal[] = [];
  if (new TextEncoder().encode(JSON.stringify(content)).length > DIGEST_CONTENT_MAX_BYTES) out.push('CONTENT_TOO_LARGE');
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (DIGEST_FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      out.push('FORBIDDEN_KEY');
      continue;
    }
    if (!DIGEST_CONTENT_KEYS.includes(key)) {
      out.push('UNKNOWN_KEY');
      continue;
    }
    if (value === undefined) continue;
    if (key === 'reading') {
      if (intelligenceReadingRefusals(value).length > 0) out.push('INVALID_READING');
    } else if (key === 'signals') {
      if (intelligenceSignalsRefusals(value, context).length > 0) out.push('INVALID_SIGNALS');
    } else if (key === 'relevance') {
      if (!(DIGEST_RELEVANCE as readonly unknown[]).includes(value)) out.push('UNKNOWN_RELEVANCE');
    } else if (key === 'confidence') {
      if (!(DIGEST_CONFIDENCE as readonly unknown[]).includes(value)) out.push('UNKNOWN_CONFIDENCE');
    } else if ((STRING_KEYS as readonly string[]).includes(key)) {
      boundedString(value, out);
    } else {
      if (!Array.isArray(value)) {
        out.push('WRONG_TYPE');
        continue;
      }
      if (value.length > DIGEST_LIST_MAX_ITEMS) out.push('LIST_TOO_LONG');
      for (const item of value) boundedString(item, out);
    }
  }
  return [...new Set(out)];
}

// --- Retention (policy dated 2026-09-24) --------------------------------------------------------

/**
 * How long a digest lives, from the anchor each kind names. Approved 2026-09-24 as initial
 * product policy, recorded in docs/architecture/daily-loop-employee-intelligence.md §21.3 as the
 * INTELLIGENCE_DIGESTS category. Expiry is a DELETE (`IntelligenceDigestRepository.purgeExpired`).
 *
 *   CONVERSATION / THREAD digest  lastEvidenceAt + 30 days: a conversation nobody has touched
 *                                 for a month has no current reading worth keeping.
 *   DOMAIN rollup                 30 days from generation: it is rebuilt from the conversations
 *                                 it rolls up, and never outlives them by much.
 *   Briefing (PR C, decided, NOT BUILT): 90 days. Documented here so the decision has one home;
 *                                 nothing in PR A writes or reads a briefing.
 */
export const INTELLIGENCE_DIGEST_RETENTION_POLICY_VERSION = 'intelligence-digest-retention.2026-09-24.1';
export const INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS = 30;
export const INTELLIGENCE_DIGEST_DOMAIN_RETENTION_DAYS = 30;
/** Decided for PR C (Briefing). Not used by anything in PR A. */
export const INTELLIGENCE_BRIEFING_RETENTION_DAYS_DECIDED = 90;
/** A digest within this long of its expiry reads as STALE: it is about to be deleted. */
export const INTELLIGENCE_DIGEST_STALE_GRACE_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a digest expires. A subject digest is anchored on its newest evidence (falling back to the
 * window's end when the producer saw none); a DOMAIN rollup on its generation.
 */
export function intelligenceDigestExpiresAt(input: {
  readonly subjectKind: IntelligenceSubjectKind;
  readonly lastEvidenceAt: Date | null;
  readonly windowEnd: Date;
  readonly generatedAt: Date;
}): Date {
  if (input.subjectKind === 'DOMAIN') return new Date(input.generatedAt.getTime() + INTELLIGENCE_DIGEST_DOMAIN_RETENTION_DAYS * DAY_MS);
  const anchor = input.lastEvidenceAt ?? input.windowEnd;
  return new Date(anchor.getTime() + INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS * DAY_MS);
}

// --- Freshness: the coverage a stored digest has NOW -------------------------------------------

/** What `digestFreshness` needs of a stored digest. */
export interface DigestFreshnessInput {
  readonly coverage: IntelligenceCoverage | string;
  readonly status: IntelligenceDigestStatus | string;
  readonly windowEnd: Date;
  readonly expiresAt: Date;
}

/**
 * The coverage a stored digest has at `now`, which is not the coverage it was generated with.
 *
 *   DISCONNECTED  the source is not live (or the digest was WITHDRAWN): whatever the digest
 *                 says, Loop is not looking any more.
 *   STALE         the digest was marked stale; or the source holds evidence newer than the
 *                 window the digest read; or it is within INTELLIGENCE_DIGEST_STALE_GRACE_DAYS
 *                 of expiring (or past it, before the sweep has run).
 *   ERROR         the stored coverage is not a value this contract knows.
 *   otherwise     the coverage recorded at generation (SUFFICIENT, INSUFFICIENT or PARTIAL).
 *
 * `sourceLastEvidenceAt` null means the caller does not know of newer evidence; it is never read
 * as "there is none" beyond that.
 */
export function digestFreshness(
  digest: DigestFreshnessInput,
  context: { readonly sourceLastEvidenceAt: Date | null; readonly connectionLive: boolean; readonly now: Date },
): IntelligenceCoverage {
  if (!context.connectionLive || digest.status === 'WITHDRAWN') return 'DISCONNECTED';
  if (!isIntelligenceCoverage(digest.coverage)) return 'ERROR';
  if (digest.status === 'STALE') return 'STALE';
  if (context.now.getTime() > digest.expiresAt.getTime() - INTELLIGENCE_DIGEST_STALE_GRACE_DAYS * DAY_MS) return 'STALE';
  if (context.sourceLastEvidenceAt && context.sourceLastEvidenceAt.getTime() > digest.windowEnd.getTime()) return 'STALE';
  return digest.coverage;
}
