// Chats, loaded for one signed-in person. SERVER ONLY.
//
// The reads behind `composeChatsIntelligence` (chats-intelligence.ts), and nothing else. Every one is
// a read Loop already makes elsewhere, through the same authority:
//   - the viewer's own Telegram connection: `sourceConnections().status`, exactly as the Connections
//     page reads it, and labelled in that page's own words (`connectionPresentation`);
//   - the viewer's own current CHATS digests: `IntelligenceDigestRepository.forDomain(principal,
//     'CHATS')` (`loadChatsDigests`) -- the principal-scoped read, which has no organization path and
//     no role bypass. Nothing here reads anyone else's digests or any organization aggregate;
//   - content-free activity: `SourceObservationRepository.activitySince` counts for the last day and
//     the last week, and `recent` for when each conversation was last active (keys and instants only)
//     -- who/when metadata, never content. It decides whether a digest is out of date, nothing more;
//   - the conversation items (Chats v5): the viewer's own OPEN triage WorkItems in BOTH lanes -- what
//     they owe (NEEDS_YOU) and what others in their conversations owe them (WAITING_ON_THEM) -- read
//     here, by the same `loadNeedsYou` read with both lanes, so Home's Chats tile and the Chats page
//     compose the SAME items (Home's separate "Needs you" panel keeps its own NEEDS_YOU-only list).
//
// EMPLOYEE-PRIVATE. The organization and the person are the signed session's (`principal`); every
// read is scoped by both, and no role widens it.
//
// A FAILED ACTIVITY OR DIGEST READ IS NULL, NEVER ZERO OR "NONE", and never throws: each settles on
// its own. A failed STATUS read throws: the caller settles it and says Chats could not be read,
// rather than drawing a disconnected account.

import 'server-only';

import { IntelligenceDigestRepository, SourceObservationRepository, absentUntilMigrated, prisma, type WorkPrincipal } from '@emgloop/database';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import type { AuthSession } from '../auth/auth';
import { sourceConnections } from '../connections/source-connection-runtime';
import { connectionPresentation } from '../app/app/_connections/source-connections-panel';
import { readerTimeZone } from './reader-zone';
import { CHATS_PROVIDER, type ChatsActivity, type ChatsConnection, type ChatsDigest, type ChatsIntelligenceInput, type ChatsItem } from './chats-intelligence';
import { loadNeedsYou, type NeedsYouItem } from './needs-you';

/** How many open conversation items Chats reads: every one, up to the loader's own ceiling. */
export const CHATS_ITEM_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many of the newest observations are read to know when each conversation was last active. */
const LATEST_ACTIVITY_WINDOW = 500;

/** A flagged item as Chats reads it: the minimized fields, never a body, never a link. */
export function chatsItemOf(item: NeedsYouItem): ChatsItem {
  return {
    provider: item.provider,
    category: item.category,
    counterparty: item.counterparty,
    topic: item.topic,
    title: item.title,
    nextStep: item.nextStep,
    deadline: item.deadline,
    at: item.at,
    conversationKey: item.conversationKey ?? null,
    id: item.id,
    lane: item.lane ?? 'NEEDS_YOU',
    owedBy: item.owedBy ?? null,
    who: item.who ?? null,
    repliedAfter: item.repliedAfter ?? null,
    conversationKind: item.conversationKind ?? null,
  };
}

/**
 * The viewer's OWN current CHATS digests: the principal-scoped read, and only that. The principal is
 * the one the page built from the signed session; the repository scopes at the data layer, so no
 * caller here can name a wider scope. Before the digests migration reaches a database there are
 * none, which is what this returns (never a failure dressed as an empty list: any other error throws).
 */
export async function loadChatsDigests(principal: WorkPrincipal, now: Date): Promise<ChatsDigest[]> {
  const records = await absentUntilMigrated(new IntelligenceDigestRepository(prisma).forDomain(principal, 'CHATS', { now }));
  return (records ?? []).map((d) => ({
    subjectRef: d.subjectRef,
    content: d.content,
    coverage: d.coverage,
    status: d.status,
    windowEnd: d.windowEnd,
    expiresAt: d.expiresAt,
    generatedAt: d.generatedAt,
    lastEvidenceAt: d.lastEvidenceAt,
    evidenceCount: d.evidenceCount,
  }));
}

export async function loadChatsInput(args: { session: AuthSession; principal: WorkPrincipal; now: Date }): Promise<ChatsIntelligenceInput> {
  const { session, principal, now } = args;
  const organizationId = principal.organizationId;

  const status = await sourceConnections().status({ organizationId, userId: principal.userId, name: session.name });
  let connection: ChatsConnection | null = null;
  if (status.permitted) {
    const view = status.providers.find((p) => p.profile.provider === CHATS_PROVIDER);
    if (view) {
      // Only the state's label is used: the words the Connections page shows for this state.
      const time = createTimeView(resolveDisplayTimeZone({ preference: null, device: readerTimeZone() }), now);
      connection = {
        configured: view.configured,
        state: view.state,
        label: connectionPresentation(view, time).pill.label,
        contentAuthorized: view.contentAuthorized,
      };
    }
  }

  const observations = new SourceObservationRepository(prisma);
  const activity = (sinceMs: number): Promise<ChatsActivity | null> => {
    const since = new Date(now.getTime() - sinceMs);
    return observations
      .activitySince(organizationId, principal.userId, CHATS_PROVIDER, since)
      .then((a) => ({ since, messages: a.messages, conversations: a.conversations }))
      .catch(() => null);
  };
  // When each conversation was last active: keys and instants only, newest first, first seen wins.
  const latestActivity = (): Promise<ReadonlyMap<string, Date> | null> =>
    observations
      .recent(organizationId, principal.userId, CHATS_PROVIDER, LATEST_ACTIVITY_WINDOW)
      .then((rows) => {
        const latest = new Map<string, Date>();
        for (const row of rows) if (!latest.has(row.conversationKey)) latest.set(row.conversationKey, row.occurredAt);
        return latest;
      })
      .catch(() => null);
  // Loop's own reading of the viewer's conversations. Settled on its own: a failed read is null
  // (said as "could not read"), never an empty list.
  const digests = (): Promise<ChatsDigest[] | null> => loadChatsDigests(principal, now).catch(() => null);
  // Both lanes, the viewer's own, one read -- the same list Home's tile and the page compose.
  const items = await loadNeedsYou(principal, CHATS_ITEM_LIMIT, prisma, ['NEEDS_YOU', 'WAITING_ON_THEM']);

  // Nothing to read for a person who cannot view connections: said as unknown, not as zero.
  const [activity24h, activity7d, latest, read] = connection
    ? await Promise.all([activity(DAY_MS), activity(7 * DAY_MS), latestActivity(), digests()])
    : [null, null, null, null];

  return {
    connection,
    digests: read,
    items: items.filter((i) => i.provider === CHATS_PROVIDER).map(chatsItemOf),
    activity24h,
    activity7d,
    latestActivity: latest,
    now,
  };
}
