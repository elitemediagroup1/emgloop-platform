import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import { requirePermission } from '../../../auth/guard';
import { LOOP_HOME } from '../../../auth/landing';
import { loadChatsInput } from '../../../daily-loop/chats';
import { composeChatsIntelligence, type ChatsIntelligence } from '../../../daily-loop/chats-intelligence';
import { readerTimeZone } from '../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../_loop-os/record';
import { settle } from '../_home/settle';
import { ChatsView } from './_chats/chats-view';
import { loadPromoteView } from '../../../work/promote';
import { PromotePanel, promoteRefusalWords } from '../../../work/promote-panel';
import { promoteOriginFrom } from '../../../work/promote-origin';
import { StateBlock } from '../_loop-os/record';

// CHATS -- what Loop understands about the person's own chats. The canonical, read-only Chats
// intelligence surface; a domain page, not configuration.
//
// WHOSE CHATS. The principal is the signed session's and nothing else: the connection, the Chats
// intelligence digests, the flagged items and the activity are all read for (organization, user),
// and no role -- OWNER or ADMIN included -- widens that. The URL carries nothing.
//
// THE GATE IS THE CONNECTIONS PAGE'S. `googleWorkspace:view` is what the Connections page enforces
// for the Telegram tile today, so exactly the people who can see their Telegram connection can see
// Chats. The connection read below still applies its own `sourceConnections` authority.
//
// READ-ONLY COMPOSITION (`composeChatsIntelligence`, the same one Home's Chats tile renders): Loop's
// own reading of each conversation (the viewer's current CHATS digests), then what the viewer owes
// (the NEEDS_YOU obligations the content-triage sweep raised; Work OS, minimized, never a body), then
// coverage and the connection. No message body, no link into Telegram, no composer. Connections is
// where a person connects, turns on AI triage or manages the account; this page only points there.

export const dynamic = 'force-dynamic';

export default async function ChatsPage({ searchParams = {} }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const session = await requirePermission('googleWorkspace', 'view');
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const now = new Date();

  const input = await settle(() => loadChatsInput({ session, principal, now }));
  const intel: ChatsIntelligence | 'UNAVAILABLE' = input.ok ? composeChatsIntelligence(input.value) : 'UNAVAILABLE';
  const time = createTimeView(zone, now);

  // Promote to Work (Phase C): the confirmation renders HERE, for the origin the link named, re-resolved
  // inside this person's own scope. A render never creates work; only the confirmed form does.
  const param = (k: string) => {
    const v = searchParams[k];
    return typeof v === 'string' ? v : null;
  };
  const origin = promoteOriginFrom(param);
  const promoteView = origin ? await settle(() => loadPromoteView(session, origin)) : null;
  const refused = promoteRefusalWords(param('promoteResult'));
  const promote = (
    <>
      {refused ? <StateBlock kind="attention" compact title="Promote to Work" body={refused} /> : null}
      {promoteView?.ok ? <PromotePanel view={promoteView.value} returnTo="/app/chats" /> : null}
      {promoteView && !promoteView.ok ? <StateBlock kind="error" compact title="Promote to Work" body="Loop could not prepare this just now. Nothing was created." /> : null}
    </>
  );

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Chats">
        <PageHead
          trail={[{ label: 'Home', href: LOOP_HOME }, { label: 'Chats' }]}
          title="Chats"
          subtitle="What Loop understands about your own chats, and what you owe in them. Loop observes; you reply in Telegram."
        />
        <ChatsView intel={intel} time={time} promote={promote} />
      </LoopPage>
    </WorkspaceShell>
  );
}
