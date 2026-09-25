// "Needs you" on Home -- a small, source-AGNOSTIC surface for the few items a background source
// (Telegram today) flagged as needing this person. GM-3's Your mail is thread-centric and stays as it
// is; this is a separate element that reads the employee's own WorkItems and shows the MODEL-produced,
// source-tagged NEEDS_YOU ones, with clear provenance and a link back to the source where one exists.
//
// EMPLOYEE-PRIVATE. The principal is the session's, and both ids scope every read -- an OWNER does not
// see it, an ADMIN does not see it. It reads only what the content-triage sweep wrote as this person's
// own work items.
//
// NO BODY, EVER. A work item's title is the AI's MINIMIZED paraphrase of what happened; its evidence holds
// keyed identifiers plus the other minimized fields (who it is with -- the source's own label for the
// conversation -- the topic, the next step and a grounded deadline). There is no message content to read
// here, and none is shown. Private Telegram chats have no stable deep link, so return-to-source degrades
// honestly to a plain label rather than a fabricated URL.
//
// SERVER ONLY, and RESILIENT: a read failure returns an empty list so Home never goes down with it.

import { WorkItemRepository, prisma, type WorkPrincipal } from '@emgloop/database';
import { AI_TRIAGE_LIMITS, isConnectionProvider, connectionProviderProfile, type ConnectionProvider } from '@emgloop/shared';

/** One item a background source flagged, minimized for display. Never a message body. */
export interface NeedsYouItem {
  readonly id: string;
  readonly provider: ConnectionProvider;
  /** The source's honest label, e.g. "Telegram". */
  readonly sourceLabel: string;
  /** The AI's minimized paraphrase of WHAT happened or is being asked (the WorkItem title). Never a verbatim message. */
  readonly title: string;
  /** The triage category, when the evidence carried one. Presentation only. */
  readonly category: string | null;
  /** WHO it is with: the source's own label for the conversation (a contact name, a group title), or null. Never invented. */
  readonly counterparty: string | null;
  /** What it is about, in a few words, or null. */
  readonly topic: string | null;
  /** What the person needs to do, or null for an item raised before this field existed. */
  readonly nextStep: string | null;
  /** A time constraint as the conversation wrote it, or null when there is none. */
  readonly deadline: string | null;
  /** When the source last found it still unresolved. */
  readonly at: Date;
  readonly detectionCount: number;
  /**
   * The KEYED conversation the item came from (an HMAC key, never a raw chat id), or null when the
   * evidence carried none. Never shown: it only links an obligation to Loop's reading of the same
   * conversation on the Chats page.
   */
  readonly conversationKey?: string | null;
  /**
   * Chats v5. Which lane the triage raised it in: NEEDS_YOU (the person owes it) or WAITING_ON_THEM
   * (someone else in the conversation does). Home's "Needs you" reads NEEDS_YOU only.
   */
  readonly lane?: 'NEEDS_YOU' | 'WAITING_ON_THEM';
  /** Chats v5: who appears to owe it (VIEWER, OTHER, UNKNOWN); null on an item raised before v5. */
  readonly owedBy?: 'VIEWER' | 'OTHER' | 'UNKNOWN' | null;
  /** Chats v5: for OTHER, the label the conversation showed for them -- never an identity. */
  readonly who?: string | null;
  /** Chats v5, Loop's own arithmetic: whether the person wrote after the message that raised it. */
  readonly repliedAfter?: boolean | null;
  /** PRIVATE or GROUP, as the source recorded it; null when unknown. */
  readonly conversationKind?: 'PRIVATE' | 'GROUP' | null;
}

function evidenceProvider(evidence: unknown): ConnectionProvider | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const p = (evidence as Record<string, unknown>).provider;
  return isConnectionProvider(p) ? p : null;
}

function evidenceCategory(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const c = (evidence as Record<string, unknown>).category;
  return typeof c === 'string' && c.trim() !== '' ? c : null;
}

/** A short evidence string, trimmed and capped for display, or null. Nothing here is ever a message body. */
function evidenceText(evidence: unknown, key: string, maxChars: number): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const v = (evidence as Record<string, unknown>)[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function evidenceOwedBy(evidence: unknown): 'VIEWER' | 'OTHER' | 'UNKNOWN' | null {
  const v = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).owedBy : null;
  return v === 'VIEWER' || v === 'OTHER' || v === 'UNKNOWN' ? v : null;
}

function evidenceBoolean(evidence: unknown, key: string): boolean | null {
  const v = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>)[key] : null;
  return typeof v === 'boolean' ? v : null;
}

function evidenceKind(evidence: unknown): 'PRIVATE' | 'GROUP' | null {
  const v = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).conversationKind : null;
  return v === 'PRIVATE' || v === 'GROUP' ? v : null;
}

/** The database the loader reads through. Injected only by tests; production is the shared client. */
type NeedsYouDb = ConstructorParameters<typeof WorkItemRepository>[0];

/**
 * The employee's open, MODEL-produced NEEDS_YOU items from a background source, newest first. It reads
 * only their own rows (both ids), filters to what a model raised (producerKind MODEL) and to the
 * provider its evidence names, and shows nothing a rule raised (the mail surface owns those).
 *
 * THE SCOPE IS THE PRINCIPAL'S, WHATEVER THEIR ROLE. An OWNER's Home hands in the OWNER's own
 * (organizationId, userId), and gets the OWNER's own items -- never another employee's. The
 * repository scopes at the data layer; nothing here can name a wider scope.
 */
export async function loadNeedsYou(
  principal: WorkPrincipal,
  limit = 6,
  db: NeedsYouDb = prisma,
  // Chats v5: the Chats page also reads WAITING_ON_THEM (what others owe the person). Home's "Needs you"
  // keeps the default -- the person's own obligations only.
  lanes: readonly ('NEEDS_YOU' | 'WAITING_ON_THEM')[] = ['NEEDS_YOU'],
): Promise<NeedsYouItem[]> {
  try {
    const items = await new WorkItemRepository(db).items(principal, { state: 'OPEN', limit: 200 });
    const out: NeedsYouItem[] = [];
    for (const item of items) {
      if (!(lanes as readonly string[]).includes(item.class) || item.producerKind !== 'MODEL') continue;
      const provider = evidenceProvider(item.evidence);
      if (!provider) continue;
      const title = item.title?.trim();
      if (!title) continue;
      out.push({
        id: item.id,
        provider,
        sourceLabel: connectionProviderProfile(provider).label,
        title,
        category: evidenceCategory(item.evidence),
        counterparty: evidenceText(item.evidence, 'counterpartyLabel', AI_TRIAGE_LIMITS.maxCounterpartyLabelChars),
        topic: evidenceText(item.evidence, 'topic', AI_TRIAGE_LIMITS.maxTopicChars),
        nextStep: evidenceText(item.evidence, 'nextStep', AI_TRIAGE_LIMITS.maxNextStepChars),
        deadline: evidenceText(item.evidence, 'deadline', AI_TRIAGE_LIMITS.maxDeadlineChars),
        at: item.lastDetectedAt,
        detectionCount: item.detectionCount,
        conversationKey: evidenceText(item.evidence, 'conversationKey', 256),
        lane: item.class === 'WAITING_ON_THEM' ? 'WAITING_ON_THEM' : 'NEEDS_YOU',
        owedBy: evidenceOwedBy(item.evidence),
        who: evidenceText(item.evidence, 'who', AI_TRIAGE_LIMITS.maxCounterpartyLabelChars),
        repliedAfter: evidenceBoolean(item.evidence, 'repliedAfter'),
        conversationKind: evidenceKind(item.evidence),
      });
    }
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    return out.slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}
