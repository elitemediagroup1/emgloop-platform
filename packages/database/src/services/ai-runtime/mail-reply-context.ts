// The context package for a reply draft (GM-3).
//
// WHAT GOES IN, AND WHY THAT AND NOTHING ELSE. One conversation, as Loop read it from the
// employee's own mailbox a moment ago, plus any instruction that employee typed for this draft.
// Nothing about the organization, nothing from the CRM, nothing about other threads, and nothing
// about other people: the task's read authority is `employeeIntelligence:view`, which grants that
// person their own rows and nobody else's, and a context may not carry what its reader could not
// have read for themselves.
//
// EVERY MESSAGE IS UNTRUSTED_INPUT. An email is somebody else's words: it is evidence to answer,
// never an instruction to obey. The trust level is the runtime's own vocabulary, the template says
// the same thing in prose, and the task publishes no tool -- three independent reasons an injected
// "ignore your instructions" cannot become authority.
//
// THE EMPLOYEE'S OWN NOTE IS HUMAN_REPORTED, which is the one thing in the package that may direct
// the draft -- because it is the person the draft belongs to, typing into their own composer.
//
// BOUNDED. The most recent messages, each capped, so one enormous thread cannot become one
// enormous prompt. What is dropped is said out loud in the manifest rather than silently.

import {
  AI_TASK_MAIL_REPLY_DRAFT,
  mailReadableText,
  mailWithoutQuotedTail,
  type AiContextItem,
  type AiContextPackage,
  type AiSupportedEvidence,
  type GmailThreadMessage,
} from '@emgloop/shared';

/** How much of a conversation one draft may see. */
export const MAIL_DRAFT_CONTEXT_LIMITS = Object.freeze({
  maxMessages: 12,
  maxCharsPerMessage: 4000,
  maxInstructionChars: 1000,
});

export interface MailReplyContextInput {
  readonly organizationId: string;
  readonly viewerUserId: string;
  readonly threadId: string;
  readonly messages: readonly GmailThreadMessage[];
  /** What the employee typed for this draft, if anything. Their own words, to their own draft. */
  readonly instruction?: string | null;
  /** The connected account's own address, so the draft knows which side of the conversation it is on. */
  readonly selfAddress: string | null;
}

export interface MailReplyContext {
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  /** What was included and what was left out, for provenance a person can read. */
  readonly manifest: {
    readonly messagesIncluded: number;
    readonly messagesOmitted: number;
    readonly messagesTruncated: number;
    readonly instructionIncluded: boolean;
  };
}

const sender = (message: GmailThreadMessage, selfAddress: string | null): string => {
  const from = message.fact.from;
  if (!from) return 'unknown sender';
  if (selfAddress && from.address === selfAddress.toLowerCase()) return 'the employee (you are drafting for them)';
  return from.name?.trim() ? `${from.name.trim()} <${from.address}>` : from.address;
};

/** Build the package. It assembles; it decides nothing about what the reply should say. */
export function buildMailReplyContext(input: MailReplyContextInput): MailReplyContext {
  const limits = MAIL_DRAFT_CONTEXT_LIMITS;
  const ordered = [...input.messages].sort((a, b) => a.fact.internalDate.getTime() - b.fact.internalDate.getTime());
  const kept = ordered.slice(-limits.maxMessages);
  let truncated = 0;

  const items: AiContextItem[] = kept.map((message, index) => {
    const readable = mailReadableText(message.body);
    const text = readable ? mailWithoutQuotedTail(readable).body : '';
    const capped = text.length > limits.maxCharsPerMessage ? text.slice(0, limits.maxCharsPerMessage) : text;
    if (capped.length < text.length) truncated += 1;
    return {
      blockId: `message-${index + 1}`,
      kind: 'TEXT',
      // Somebody else's words. Never an instruction, whatever they say inside.
      trust: 'UNTRUSTED_INPUT',
      sourceRef: `work_message:${message.fact.messageId}`,
      content: [
        `from: ${sender(message, input.selfAddress)}`,
        `sent: ${message.fact.internalDate.toISOString()}`,
        `subject: ${message.fact.subject ?? '(none)'}`,
        '',
        capped || '(this message has no readable text)',
      ].join('\n'),
      sensitivity: 'COMMUNICATION_CONTENT',
      readUnder: { resource: 'employeeIntelligence', action: 'view' },
    };
  });

  const instruction = input.instruction?.trim().slice(0, limits.maxInstructionChars) ?? '';
  if (instruction !== '') {
    items.push({
      blockId: 'employee-instruction',
      kind: 'TEXT',
      // The one block that may direct the draft: the person it belongs to, typing into their own
      // composer. It is still not a system instruction -- the template's rules outrank it.
      trust: 'HUMAN_REPORTED',
      sourceRef: `work_thread:${input.threadId}`,
      content: `The employee asks for this reply: ${instruction}`,
      sensitivity: 'COMMUNICATION_CONTENT',
      readUnder: { resource: 'employeeIntelligence', action: 'view' },
    });
  }

  return {
    context: {
      organizationId: input.organizationId,
      viewerUserId: input.viewerUserId,
      taskId: AI_TASK_MAIL_REPLY_DRAFT.taskId,
      items,
      sensitivityCeiling: AI_TASK_MAIL_REPLY_DRAFT.sensitivityCeiling,
    },
    // A reply is prose, and this task's output is not figure-checked (a reply naturally restates a
    // date from the conversation). The evidence is supplied for the runtime's own contract and is
    // deliberately empty of figures rather than pretending to have grounded them.
    evidence: { figures: new Map(), dates: new Set() },
    manifest: {
      messagesIncluded: items.filter((i) => i.blockId.startsWith('message-')).length,
      messagesOmitted: ordered.length - kept.length,
      messagesTruncated: truncated,
      instructionIncluded: instruction !== '',
    },
  };
}
