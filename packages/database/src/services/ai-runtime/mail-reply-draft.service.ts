// Draft with Loop: a proposed reply, for the employee who asked, in their own composer (GM-3).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11, §6.13.
//
// THE ORDER: authorize, then read, then run, then store as a draft. A person who may not invoke
// the task is refused before their mailbox is read, so the refusal reveals nothing.
//
// WHAT IT PRODUCES IS TEXT IN A BOX. The answer is written into the SAME `work_drafts` row a
// manual reply uses, marked `AI_PROPOSED` with the invocation that produced it. From that moment
// it is an ordinary draft: the employee edits it, or discards it, and sends it themselves under
// `employeeMail:send`.
//
// IT CANNOT SEND, AND NOT BECAUSE IT IS ASKED NOT TO. This service has no send port, no Gmail
// client and no path to one. The send path takes a draft id and a human principal; a machine
// principal cannot hold the authority at all; and the task publishes no tool. Three independent
// reasons, none of which is a prompt asking nicely.
//
// NOTHING IS PERSISTED BUT THE DRAFT. The conversation is read for this request and discarded; the
// ledger receives ids, versions and counts through the gateway, never a prompt or an answer.

import {
  AI_TASK_MAIL_REPLY_DRAFT,
  type AiAdmissionRefusal,
  type AiInvocationProvenance,
  type AiOutputRejection,
  type GmailThreadMessage,
} from '@emgloop/shared';

import type { WorkDraftRepository } from '../../repositories/work-state/work-draft.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import { buildMailReplyContext, type MailReplyContext } from './mail-reply-context';
import type { AiAuthorizer, AiPrincipal, AiRunRequest, AiRunResult } from './gateway';
import {
  MAIL_REPLY_DRAFT_SCHEMA,
  MAIL_REPLY_DRAFT_SCHEMA_ID,
  MAIL_REPLY_DRAFT_TEMPLATE_ID,
  MAIL_REPLY_DRAFT_TEMPLATE_VERSION,
  renderMailReplyDraftInstructions,
} from './templates/mail-reply-draft';

export interface MailReplyDraftRuntime {
  run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult>;
}

/** Reading one conversation, for the employee who asked. The same read the thread view performs. */
export interface MailThreadReader {
  read(principal: WorkPrincipal, threadId: string): Promise<
    | { readonly ok: true; readonly messages: readonly GmailThreadMessage[]; readonly selfAddress: string | null }
    | { readonly ok: false; readonly failure: string }
  >;
}

export interface MailReplyDraftDeps {
  readonly runtime: MailReplyDraftRuntime;
  readonly authorize: AiAuthorizer;
  readonly threads: MailThreadReader;
  readonly drafts: WorkDraftRepository;
  readonly now?: () => Date;
}

export type MailReplyDraftResult =
  | {
      readonly outcome: 'DRAFTED';
      readonly body: string;
      readonly summary: string;
      readonly limitations: readonly string[];
      readonly provenance: AiInvocationProvenance;
      readonly manifest: MailReplyContext['manifest'];
    }
  | { readonly outcome: 'NOT_AVAILABLE'; readonly refusals: readonly AiAdmissionRefusal[] }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[] }
  | { readonly outcome: 'FAILED'; readonly reason: 'THREAD_UNREADABLE' | 'NO_CONVERSATION' | 'PROVIDER' };

export class MailReplyDraftService {
  constructor(private readonly deps: MailReplyDraftDeps) {}

  /**
   * Draft a reply to one of this employee's own conversations.
   *
   * `threadId` is not authority: it is handed to a read scoped by the principal, so a thread
   * belonging to somebody else is unreadable rather than forbidden.
   */
  async draftReply(
    principal: WorkPrincipal,
    request: { readonly threadId: string; readonly inReplyToMessageId?: string | null; readonly instruction?: string | null; readonly mode?: 'REPLY' | 'REPLY_ALL' },
  ): Promise<MailReplyDraftResult> {
    // 1. May this person invoke the task at all? Asked before their mailbox is touched.
    const allowed = await this.deps.authorize(
      { organizationId: principal.organizationId, userId: principal.userId },
      AI_TASK_MAIL_REPLY_DRAFT,
    );
    if (!allowed) return { outcome: 'NOT_AVAILABLE', refusals: ['NOT_AUTHORIZED'] };

    // 2. The conversation, read for this request and kept nowhere.
    const thread = await this.deps.threads.read(principal, request.threadId);
    if (!thread.ok) return { outcome: 'FAILED', reason: 'THREAD_UNREADABLE' };
    if (thread.messages.length === 0) return { outcome: 'FAILED', reason: 'NO_CONVERSATION' };

    const built = buildMailReplyContext({
      organizationId: principal.organizationId,
      viewerUserId: principal.userId,
      threadId: request.threadId,
      messages: thread.messages,
      instruction: request.instruction ?? null,
      selfAddress: thread.selfAddress,
    });

    // 3. One governed call. The gateway owns activation, budget, routing, provenance and the
    // output contract; nothing here names a provider or a model.
    const result = await this.deps.runtime.run(
      { organizationId: principal.organizationId, userId: principal.userId },
      {
        task: AI_TASK_MAIL_REPLY_DRAFT,
        context: built.context,
        instructions: renderMailReplyDraftInstructions(built.context.items.map((i) => i.sourceRef)),
        templateId: MAIL_REPLY_DRAFT_TEMPLATE_ID,
        templateVersion: MAIL_REPLY_DRAFT_TEMPLATE_VERSION,
        schema: MAIL_REPLY_DRAFT_SCHEMA,
        evidence: built.evidence,
      },
    );

    if (result.outcome === 'REFUSED_BY_LOOP') return { outcome: 'NOT_AVAILABLE', refusals: result.refusals };
    if (result.outcome === 'REJECTED_OUTPUT') return { outcome: 'REJECTED_OUTPUT', rejections: result.rejections };
    if (result.outcome !== 'ANSWERED') return { outcome: 'FAILED', reason: 'PROVIDER' };

    const body = result.output.draft?.body?.trim() ?? '';
    if (body === '' || result.output.schemaId !== MAIL_REPLY_DRAFT_SCHEMA_ID) {
      return { outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] };
    }

    // 4. Into the composer -- the same draft a manual reply uses, marked with where it came from.
    const newest = [...thread.messages].sort((a, b) => a.fact.internalDate.getTime() - b.fact.internalDate.getTime()).at(-1)!;
    const existing = await this.deps.drafts.draft(principal, 'GOOGLE', request.threadId);
    await this.deps.drafts.save(principal, {
      provider: 'GOOGLE',
      threadId: request.threadId,
      inReplyToMessageId: request.inReplyToMessageId ?? newest.fact.messageId,
      mode: request.mode ?? existing?.mode === 'REPLY_ALL' ? 'REPLY_ALL' : 'REPLY',
      // The recipients a manual reply would have had: the employee sees and may change them.
      toAddresses: existing?.toAddresses ?? [],
      ccAddresses: existing?.ccAddresses ?? [],
      subject: newest.fact.subject,
      body,
      source: 'AI_PROPOSED',
      aiInvocationId: result.provenance.invocationId,
      aiTaskVersion: AI_TASK_MAIL_REPLY_DRAFT.version,
      aiUnedited: true,
    });

    return {
      outcome: 'DRAFTED',
      body,
      summary: result.output.summary,
      limitations: result.output.limitations,
      provenance: result.provenance,
      manifest: built.manifest,
    };
  }
}
