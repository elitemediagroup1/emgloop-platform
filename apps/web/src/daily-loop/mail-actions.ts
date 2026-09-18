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
import { MailSendService, WorkDraftRepository, WorkGraphRepository, prisma, sendEmployeeGmailMessage, employeeGmailIdentity } from '@emgloop/database';

import { requirePermission } from '../auth/guard';
import { readGoogleEnvironment } from '../google/google-environment';
import { googleSigningKeys } from '../google/google-runtime';
import { refreshMailByHand } from './mail-runtime';

const MAIL_PATH = '/app/mail';

function principalOf(session: { organizationId: string; userId: string }) {
  return { organizationId: session.organizationId, userId: session.userId };
}

function gmailConfig() {
  const env = readGoogleEnvironment();
  return { prisma, google: env.state === 'CONFIGURED' ? env : null, signingKeys: googleSigningKeys() };
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
 * It saves first and sends second, so what leaves is what they last saw -- and so the send itself
 * takes only a draft id. `employeeMail:send` is required, and the service claims the draft before
 * Gmail is called, which is what makes a double-click one message rather than two.
 */
export async function sendReplyAction(form: FormData): Promise<void> {
  const session = await requirePermission('employeeMail', 'send');
  const principal = principalOf(session);
  const threadId = String(form.get('threadId') ?? '');
  if (threadId === '') return;

  await saveDraftAction(form);
  const drafts = new WorkDraftRepository(prisma);
  const draft = await drafts.draft(principal, 'GOOGLE', threadId);
  if (!draft || draft.sentAt) return;

  const config = gmailConfig();
  const service = new MailSendService({
    drafts,
    graph: new WorkGraphRepository(prisma),
    mail: {
      identity: (p) => employeeGmailIdentity(config, p),
      send: (p, message) => sendEmployeeGmailMessage(config, p, message),
    },
  });
  await service.sendDraft(principal, draft.id);
  revalidatePath(`${MAIL_PATH}/${threadId}`);
  revalidatePath(MAIL_PATH);
}
