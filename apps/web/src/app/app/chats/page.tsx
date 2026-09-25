import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import { requirePermission } from '../../../auth/guard';
import { LOOP_HOME } from '../../../auth/landing';
import { loadChatsInput } from '../../../daily-loop/chats';
import { chatsIntelligence, type ChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import { loadNeedsYou } from '../../../daily-loop/needs-you';
import { readerTimeZone } from '../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../_loop-os/record';
import { settle } from '../_home/settle';
import { ChatsView } from './_chats/chats-view';

// CHATS -- what is happening in the person's own chats. A domain page, not configuration.
//
// WHOSE CHATS. The principal is the signed session's and nothing else: the connection, the flagged
// items and the activity counts are all read for (organization, user), and no role -- OWNER or ADMIN
// included -- widens that. The URL carries nothing.
//
// THE GATE IS THE CONNECTIONS PAGE'S. `googleWorkspace:view` is what the Connections page enforces
// for the Telegram tile today, so exactly the people who can see their Telegram connection can see
// Chats. The connection read below still applies its own `sourceConnections` authority.
//
// READ-ONLY COMPOSITION (chats-intelligence.ts): the viewer's own Telegram connection, the NEEDS_YOU
// items the content-triage sweep raised for them (minimized; never a body), and content-free activity
// counts. No link into Telegram, no composer. Connections is where a person connects or manages the
// account; this page only points there.

export const dynamic = 'force-dynamic';

/**
 * How many flagged items Chats reads. Home shows the newest few; the domain page counts every open one,
 * up to the loader's own ceiling, so "N conversations need you" is not a truncated number.
 */
const CHATS_ITEM_LIMIT = 200;

export default async function ChatsPage() {
  const session = await requirePermission('googleWorkspace', 'view');
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const now = new Date();

  // Loaded once, with the session's principal, and handed to the loader as data.
  const needsYou = await loadNeedsYou(principal, CHATS_ITEM_LIMIT);
  const input = await settle(() => loadChatsInput({ session, principal, now, needsYou }));
  const intel: ChatsIntelligence | 'UNAVAILABLE' = input.ok ? chatsIntelligence(input.value) : 'UNAVAILABLE';
  const time = createTimeView(zone, now);

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Chats">
        <PageHead
          trail={[{ label: 'Home', href: LOOP_HOME }, { label: 'Chats' }]}
          title="Chats"
          subtitle="What needs you in your own chats. Loop observes; you reply in Telegram."
        />
        <ChatsView intel={intel} time={time} />
      </LoopPage>
    </WorkspaceShell>
  );
}
