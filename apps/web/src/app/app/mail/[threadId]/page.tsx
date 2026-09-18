import Link from 'next/link';
import { redirect } from 'next/navigation';

import { createTimeView, gmailReplyRecipients, resolveDisplayTimeZone, type GmailReplyTarget } from '@emgloop/shared';
import { WorkDraftRepository, prisma, repositories } from '@emgloop/database';

import { getSession } from '../../../../auth/auth';
import { loginPathFor } from '../../../../auth/landing';
import { requirePermission } from '../../../../auth/guard';
import { loadThread } from '../../../../daily-loop/mail';
import { mailSendService } from '../../../../daily-loop/mail-send-runtime';
import { readerTimeZone } from '../../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead, Panel, StateBlock } from '../../_loop-os/record';
import { Composer } from '../_mail/composer';
import { Conversation } from '../_mail/conversation';

// ONE CONVERSATION, AND THE REPLY TO IT (GM-2).
//
// WHOSE CONVERSATION. The principal comes from the signed session. The thread id in the URL is
// not authority: it is handed to a read that is scoped by organization AND user, so another
// employee's thread id returns the same thing a nonexistent one does -- not found.
//
// THE CONVERSATION IS READ THROUGH AND KEPT NOWHERE. Bodies come from Gmail for this request and
// are rendered as text; nothing on this page is written to the database except the employee's own
// draft, which is their own words.

export const dynamic = 'force-dynamic';

export default async function MailThreadPage({ params }: { params: { threadId: string } }) {
  const session = await getSession();
  if (!session) redirect(loginPathFor('/app/mail'));
  await requirePermission('employeeIntelligence', 'view');

  const principal = { organizationId: session.organizationId, userId: session.userId };
  const threadId = params.threadId;
  // AN ATTEMPT IN DOUBT IS SETTLED WHEN ITS OWNER LOOKS AT IT. This is the crash path: a process
  // that stopped after Gmail accepted a message ran no failure handler, and this view is what
  // notices. It reconciles against the employee's own Sent mail -- read-only toward Gmail, and
  // bounded by the service's own floor -- and it never sends.
  const drafts = new WorkDraftRepository(prisma);
  const pending = await drafts.draft(principal, 'GOOGLE', threadId);
  if (pending && (pending.sendState === 'SENDING' || pending.sendState === 'SEND_UNKNOWN')) {
    try {
      await mailSendService().reconcile(principal, pending.id);
    } catch {
      // A check that could not run changes nothing: the reply stays frozen and in doubt, and the
      // conversation still renders with "Check Gmail again" offered.
    }
  }

  const [result, draftRow, canSend] = await Promise.all([
    loadThread(principal, threadId),
    drafts.draft(principal, 'GOOGLE', threadId),
    repositories.iam.can({ organizationId: principal.organizationId, userId: principal.userId, resource: 'employeeMail', action: 'send' }),
  ]);

  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const time = createTimeView(zone, new Date());

  if (!result.ok) {
    const reconnect = result.failure === 'AUTHORIZATION_EXPIRED' || result.failure === 'CAPABILITY_NOT_GRANTED' || result.failure === 'NOT_CONNECTED';
    return (
      <WorkspaceShell session={session}>
        <LoopPage label="Mail">
          <PageHead trail={[{ label: 'Your Loop' }, { label: 'Mail', href: '/app/mail' }]} title="Conversation" />
          <Panel title="Conversation">
            <StateBlock
              kind={reconnect ? 'attention' : 'error'}
              title={reconnect ? 'Loop cannot read your mail right now' : 'Loop could not open this conversation'}
              body={
                reconnect
                  ? 'Your Google connection needs attention before Loop can show this conversation.'
                  : 'Gmail did not answer. Nothing has changed in your mailbox, and your draft is still here.'
              }
              action={reconnect ? { label: 'Connections', href: '/app/connections' } : { label: 'Back to mail', href: '/app/mail' }}
              compact
            />
          </Panel>
        </LoopPage>
      </WorkspaceShell>
    );
  }

  const messages = result.thread.messages;
  const newest = messages[messages.length - 1];
  const subject = messages[0]?.fact.subject ?? null;
  const self = result.selfAddress ?? '';

  // What a reply would be addressed to, from the message being answered. The employee sees it,
  // and can change it, before anything is sent.
  const target: GmailReplyTarget | null = newest
    ? {
        messageId: newest.fact.messageId,
        threadId,
        headerMessageId: newest.fact.headerMessageId,
        references: newest.fact.references,
        subject: newest.fact.subject,
        from: newest.fact.from,
        to: newest.fact.to,
        cc: newest.fact.cc,
      }
    : null;
  const reply = target && self ? gmailReplyRecipients(target, 'REPLY', self) : { to: [], cc: [] };
  const replyAll = target && self ? gmailReplyRecipients(target, 'REPLY_ALL', self) : { to: [], cc: [] };

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Mail">
        <PageHead
          trail={[{ label: 'Your Loop' }, { label: 'Mail', href: '/app/mail' }]}
          title={subject?.trim() || 'No subject'}
          subtitle={`${messages.length} ${messages.length === 1 ? 'message' : 'messages'} · read from Gmail just now, and not stored`}
          actions={
            <Link href="/app/mail" className="loop-link">
              ← All mail
            </Link>
          }
        />
        <Panel title="Conversation">
          <Conversation messages={messages} selfAddress={result.selfAddress} time={time} />
        </Panel>
        {target ? (
          <Panel title="Your reply">
            <Composer
              threadId={threadId}
              inReplyToMessageId={target.messageId}
              draft={
                draftRow
                  ? {
                      body: draftRow.body,
                      mode: draftRow.mode as 'REPLY' | 'REPLY_ALL',
                      to: draftRow.toAddresses,
                      cc: draftRow.ccAddresses,
                      source: draftRow.source as 'MANUAL' | 'AI_PROPOSED',
                      aiUnedited: draftRow.aiUnedited,
                      sendFailureClass: draftRow.sendFailureClass,
                      sentAt: draftRow.sentAt,
                      sendState: draftRow.sendState as 'DRAFT' | 'SENDING' | 'SEND_UNKNOWN' | 'SENT',
                      sendAttemptStartedAt: draftRow.sendAttemptStartedAt,
                      sendResolution: draftRow.sendResolution,
                    }
                  : null
              }
              replyTo={reply.to}
              replyAllCc={replyAll.cc}
              canSend={canSend}
              now={new Date()}
            />
          </Panel>
        ) : null}
      </LoopPage>
    </WorkspaceShell>
  );
}
