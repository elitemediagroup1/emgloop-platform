// "Needs you" on Home -- a small, source-AGNOSTIC surface for the few items a background source
// (Telegram today) flagged as needing this person. GM-3's Your mail is thread-centric and stays as it
// is; this is a separate element that reads the employee's own WorkItems and shows the MODEL-produced,
// source-tagged NEEDS_YOU ones, with clear provenance and a link back to the source where one exists.
//
// EMPLOYEE-PRIVATE. The principal is the session's, and both ids scope every read -- an OWNER does not
// see it, an ADMIN does not see it. It reads only what the content-triage sweep wrote as this person's
// own work items.
//
// NO BODY, EVER. A work item's title is the AI's MINIMIZED paraphrase and its evidence is keyed
// identifiers only; there is no message content to read here, and none is shown. Private Telegram chats
// have no stable deep link, so return-to-source degrades honestly to a plain label rather than a
// fabricated URL.
//
// SERVER ONLY, and RESILIENT: a read failure returns an empty list so Home never goes down with it.

import { WorkItemRepository, prisma, type WorkPrincipal } from '@emgloop/database';
import { isConnectionProvider, connectionProviderProfile, type ConnectionProvider } from '@emgloop/shared';

/** One item a background source flagged, minimized for display. Never a message body. */
export interface NeedsYouItem {
  readonly id: string;
  readonly provider: ConnectionProvider;
  /** The source's honest label, e.g. "Telegram". */
  readonly sourceLabel: string;
  /** The AI's minimized one-line paraphrase (the WorkItem title). Never a verbatim message. */
  readonly title: string;
  /** The triage category, when the evidence carried one. Presentation only. */
  readonly category: string | null;
  readonly at: Date;
  readonly detectionCount: number;
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
export async function loadNeedsYou(principal: WorkPrincipal, limit = 6, db: NeedsYouDb = prisma): Promise<NeedsYouItem[]> {
  try {
    const items = await new WorkItemRepository(db).items(principal, { state: 'OPEN', limit: 200 });
    const out: NeedsYouItem[] = [];
    for (const item of items) {
      if (item.class !== 'NEEDS_YOU' || item.producerKind !== 'MODEL') continue;
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
        at: item.lastDetectedAt,
        detectionCount: item.detectionCount,
      });
    }
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    return out.slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}
