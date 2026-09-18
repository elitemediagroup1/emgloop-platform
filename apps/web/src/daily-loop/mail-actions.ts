'use server';

// Mail actions. Each one acts on the person asking, for their own mailbox only.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11 (GM-2).
//
// WHOSE MAIL IS NOT AN ARGUMENT. Every action resolves the session first and builds the principal
// from it. No form field, query parameter or header names an organization or a user, so there is
// no shape of request that acts on somebody else's mailbox, whatever role the caller holds.
//
// SENDING IS ITS OWN AUTHORITY. `sendReplyAction` requires `employeeMail:send` -- a resource with
// exactly one action, which AI_EMPLOYEE can never hold. Saving a draft requires only
// `employeeIntelligence:update`, because writing something down is not sending it.
//
// AND WHAT IS SENT IS WHAT WAS STORED. The send action takes a draft id and nothing else: the
// body, the recipients and the subject come from the row the employee last saved. A request
// cannot carry a body straight to Gmail, which is what keeps generation and transmission apart.

import { revalidatePath } from 'next/cache';

import {
  GMAIL_MAX_BODY_CHARS,
  WORK_REPLY_MODES,
  normalizeGmailAddress,
  parseGmailAddressList,
  type GmailAddress,
  type WorkReplyMode,
} from '@emgloop/shared';
import { WorkDraftRepository, WorkGraphRepository, prisma } from '@emgloop/database';

import { requirePermission } from '../auth/guard';
import { refreshMailByHand } from './mail-runtime';
import { mailSendService } from './mail-send-runtime';

const MAIL_PATH = '/app/mail';

function principalOf(session: { organizationId: string; userId: string }) {
  return { organizationId: session.organizationId, userId: session.userId };
}


/** Read this employee's mailbox again, if the floor allows it. Their own, always. */
export async function refreshMailAction(): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  await refreshMailByHand(principalOf(session));
  revalidatePath(MAIL_PATH);
}

/** Addresses as a person typed them. An entry Loop cannot read is dropped, never guessed at. */
function addressesFrom(value: FormDataEntryValue | null): GmailAddress[] {
  return parseGmailAddressList(typeof value === 'string' ? value : '');
}

/**
 * Save what the employee has written. One draft per conversation, so navigating away and coming
 * back finds the same words.
 */
export async function saveDraftAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  const principal = principalOf(session);
  const threadId = String(form.get('threadId') ?? '');
  const inReplyToMessageId = String(form.get('inReplyToMessageId') ?? '');
  const modeRaw = String(form.get('mode') ?? 'REPLY');
  const mode: WorkReplyMode = (WORK_REPLY_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as WorkReplyMode) : 'REPLY';
  const body = String(form.get('body') ?? '').slice(0, GMAIL_MAX_BODY_CHARS);
  if (threadId === '' || inReplyToMessageId === '') return;

  const drafts = new WorkDraftRepository(prisma);
  const graph = new WorkGraphRepository(prisma);
  // The thread must be one THIS employee holds. A thread id they do not have is not found, which
  // is the same answer as a thread that does not exist.
  const thread = await graph.thread(principal, 'GOOGLE', threadId);
  if (!thread) return;

  const to = addressesFrom(form.get('to'));
  const cc = addressesFrom(form.get('cc'));
  await drafts.save(principal, {
    provider: 'GOOGLE',
    threadId,
    inReplyToMessageId,
    mode,
    toAddresses: to.map((a) => normalizeGmailAddress(a.address)),
    ccAddresses: cc.map((a) => normalizeGmailAddress(a.address)),
    subject: thread.subject,
    body,
    source: 'MANUAL',
  });
  revalidatePath(`${MAIL_PATH}/${threadId}`);
}

export async function discardDraftAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  const threadId = String(form.get('threadId') ?? '');
  if (threadId === '') return;
  await new WorkDraftRepository(prisma).discard(principalOf(session), 'GOOGLE', threadId);
  revalidatePath(`${MAIL_PATH}/${threadId}`);
}

/**
 * Send the reply this employee has open on this conversation.
 *
 * It saves first and sends second, so what leaves is what they last saw -- and the send itself
 * takes only a draft id. `employeeMail:send` is required.
 *
 * AND IT NEVER SENDS AN ATTEMPT THAT IS IN DOUBT. If the draft is already SENDING or
 * SEND_UNKNOWN, the save below changes nothing (the words are frozen as evidence) and the service
 * reconciles against Sent mail instead of transmitting. Pressing Send again on an unconfirmed
 * reply is therefore a request to check, not a second message.
 */
export async function sendReplyAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeMail', 'send');
  const principal = principalOf(session);
  const threadId = String(form.get('threadId') ?? '');
  if (threadId === '') return;

  await saveDraftAction(form);
  const draft = await new WorkDraftRepository(prisma).draft(principal, 'GOOGLE', threadId);
  if (!draft || draft.sendState === 'SENT') return;

  await mailSendService().sendDraft(principal, draft.id);
  revalidatePath(`${MAIL_PATH}/${threadId}`);
  revalidatePath(MAIL_PATH);
}

/**
 * "Check Gmail again" for a reply Loop could not confirm. It looks at the employee's own Sent
 * mail and settles what it can. It never sends.
 */
export async function checkSendAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeMail', 'send');
  const principal = principalOf(session);
  const threadId = String(form.get('threadId') ?? '');
  if (threadId === '') return;
  const draft = await new WorkDraftRepository(prisma).draft(principal, 'GOOGLE', threadId);
  if (!draft) return;
  await mailSendService().reconcile(principal, draft.id, { force: true });
  revalidatePath(`${MAIL_PATH}/${threadId}`);
}

/**
 * "I checked my Sent mail -- it was not sent." The employee's explicit, recorded decision about a
 * reply Loop could not confirm. The service refuses it while the attempt could still be in flight,
 * and looks once more first: if the message is there after all, it is marked sent and nothing is
 * released. It does not send; it only makes Send available again.
 */
export async function releaseSendAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeMail', 'send');
  const principal = principalOf(session);
  const threadId = String(form.get('threadId') ?? '');
  if (threadId === '') return;
  const draft = await new WorkDraftRepository(prisma).draft(principal, 'GOOGLE', threadId);
  if (!draft) return;
  await mailSendService().releaseUnconfirmed(principal, draft.id);
  revalidatePath(`${MAIL_PATH}/${threadId}`);
}
