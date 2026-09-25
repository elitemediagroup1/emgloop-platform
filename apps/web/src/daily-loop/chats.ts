// Chats, loaded for one signed-in person. SERVER ONLY.
//
// The reads behind `chatsIntelligence` (chats-intelligence.ts), and nothing else. Every one is a
// read Loop already makes elsewhere, through the same authority:
//   - the viewer's own Telegram connection: `sourceConnections().status`, exactly as the Connections
//     page reads it, and labelled in that page's own words (`connectionPresentation`);
//   - content-free activity counts: `SourceObservationRepository.activitySince`, for the last day and
//     the last week -- who/when metadata, never content;
//   - the flagged items: handed in by the caller from the `loadNeedsYou` it already made. This module
//     never loads them itself, so a page loads them once and Home and Chats read the same list.
//
// EMPLOYEE-PRIVATE. The organization and the person are the signed session's (`principal`); every
// read is scoped by both, and no role widens it.
//
// A FAILED ACTIVITY READ IS NULL, NEVER ZERO, and never throws. A failed STATUS read throws: the
// caller settles it and says Chats could not be read, rather than drawing a disconnected account.

import 'server-only';

import { SourceObservationRepository, prisma, type WorkPrincipal } from '@emgloop/database';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import type { AuthSession } from '../auth/auth';
import { sourceConnections } from '../connections/source-connection-runtime';
import { connectionPresentation } from '../app/app/_connections/source-connections-panel';
import { readerTimeZone } from './reader-zone';
import { CHATS_PROVIDER, type ChatsActivity, type ChatsConnection, type ChatsIntelligenceInput, type ChatsItem } from './chats-intelligence';
import type { NeedsYouItem } from './needs-you';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  };
}

export async function loadChatsInput(args: {
  session: AuthSession;
  principal: WorkPrincipal;
  now: Date;
  needsYou: readonly NeedsYouItem[];
}): Promise<ChatsIntelligenceInput> {
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
  // Nothing to count for a person who cannot view connections: said as unknown, not as zero.
  const [activity24h, activity7d] = connection ? await Promise.all([activity(DAY_MS), activity(7 * DAY_MS)]) : [null, null];

  return {
    connection,
    items: args.needsYou.filter((i) => i.provider === CHATS_PROVIDER).map(chatsItemOf),
    activity24h,
    activity7d,
  };
}
