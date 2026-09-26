// The context package for one mail thread (Mail content triage, Loop Intelligence Phase D).
//
// Bodies arrive from the governed Gmail read-through (the same read the Mail page makes when a person
// opens a thread), enter ONE context package, go to ONE governed call, and are dropped. Keyed refs only:
// a message is `mail_message:<loop thread id>:<ordinal>`; the thread is `work_thread:<loop thread id>`.
// The sender labels are the From display names Gmail showed -- the only names a `who` may be.
//
// PURE.

import { AI_TASK_MAIL_CONTENT_TRIAGE, aiTermsInText, aiVerbatimRuns, type AiContextItem, type AiContextPackage, type AiSupportedEvidence } from '@emgloop/shared';

import { renderMailContentTriageInstructions } from './templates/mail-content-triage';

export const MAIL_TRIAGE_CONTEXT_LIMITS = Object.freeze({ maxMessages: 20, maxMessageChars: 1_500, maxLabelChars: 60, maxSubjectChars: 200 });

export interface MailTriageMessage {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly occurredAt: Date;
  /** The From display name (inbound), capped; null when none. */
  readonly fromLabel: string | null;
  /** Transient: dropped after the call. Quoted history should already be trimmed by the reader. */
  readonly text: string;
}

export interface MailTriageContextInput {
  readonly organizationId: string;
  readonly viewerUserId: string;
  /** Loop's own work_threads id. Never Gmail's id. */
  readonly threadId: string;
  readonly subject: string | null;
  readonly messages: readonly MailTriageMessage[];
  readonly truncated: boolean;
  /** Loop's deterministic lane for the thread (mail-intelligence.ts), when it has one. */
  readonly lane: string | null;
}

export interface MailTriageContext {
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  readonly instructions: string;
  /** ordinal -> keyed message ref. */
  readonly ordinalToMessageRef: ReadonlyMap<number, string>;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function mailThreadRef(threadId: string): string {
  return `work_thread:${threadId}`;
}

export function buildMailTriageContext(input: MailTriageContextInput): MailTriageContext {
  const threadRef = mailThreadRef(input.threadId);
  const items: AiContextItem[] = [];
  const read = { resource: 'employeeIntelligence', action: 'view' } as const;
  const conversationRef = `mail_conversation:${input.threadId}`;
  if (input.subject?.trim()) {
    items.push({ blockId: `${input.organizationId}::${conversationRef}#subject`, kind: 'TEXT', trust: 'UNTRUSTED_INPUT', sourceRef: conversationRef, content: `SUBJECT: ${cap(input.subject.trim(), MAIL_TRIAGE_CONTEXT_LIMITS.maxSubjectChars)}`, sensitivity: 'COMMUNICATION_CONTENT', readUnder: read });
  }
  const ordinals = new Map<number, string>();
  const messages = input.messages.slice(-MAIL_TRIAGE_CONTEXT_LIMITS.maxMessages);
  messages.forEach((m, i) => {
    const ordinal = i + 1;
    const ref = `mail_message:${input.threadId}:${ordinal}`;
    ordinals.set(ordinal, ref);
    const from = m.direction === 'INBOUND' && m.fromLabel?.trim() ? ` [from ${cap(m.fromLabel.trim(), MAIL_TRIAGE_CONTEXT_LIMITS.maxLabelChars)}]` : '';
    items.push({ blockId: `${input.organizationId}::${ref}`, kind: 'TEXT', trust: 'UNTRUSTED_INPUT', sourceRef: ref, content: `${ordinal} ${m.direction} ${m.occurredAt.toISOString()}${from}: ${cap(m.text, MAIL_TRIAGE_CONTEXT_LIMITS.maxMessageChars) || '(no readable text)'}`, sensitivity: 'COMMUNICATION_CONTENT', readUnder: read });
  });
  const lastOutbound = messages.map((m) => m.direction).lastIndexOf('OUTBOUND') + 1;
  const state =
    messages.length === 0
      ? null
      : lastOutbound === messages.length
        ? `STATE: the last message (${messages.length}) is from the person.`
        : lastOutbound === 0
          ? `STATE: all ${messages.length} messages are from others; the person has not written in this thread.`
          : `STATE: the person last wrote at message ${lastOutbound}; everything after is from others, with no reply since.`;
  if (state) items.push({ blockId: `${input.organizationId}::${conversationRef}#state`, kind: 'TEXT', trust: 'GOVERNED_FACT', sourceRef: conversationRef, content: state, sensitivity: 'OPERATIONAL', readUnder: read });
  if (input.lane) items.push({ blockId: `${input.organizationId}::${conversationRef}#lane`, kind: 'TEXT', trust: 'GOVERNED_FACT', sourceRef: conversationRef, content: `LANE: ${input.lane}`, sensitivity: 'OPERATIONAL', readUnder: read });
  const terms = new Set<string>();
  const runs = new Set<string>();
  const labels = new Set<string>();
  for (const m of messages) {
    const text = cap(m.text, MAIL_TRIAGE_CONTEXT_LIMITS.maxMessageChars);
    for (const t of aiTermsInText(text)) terms.add(t);
    for (const r of aiVerbatimRuns(text)) runs.add(r);
    if (m.direction === 'INBOUND' && m.fromLabel?.trim()) labels.add(cap(m.fromLabel.trim(), MAIL_TRIAGE_CONTEXT_LIMITS.maxLabelChars).toLowerCase());
  }
  void threadRef;
  return {
    context: {
      organizationId: input.organizationId,
      viewerUserId: input.viewerUserId,
      taskId: AI_TASK_MAIL_CONTENT_TRIAGE.taskId,
      items,
      sensitivityCeiling: AI_TASK_MAIL_CONTENT_TRIAGE.sensitivityCeiling,
    },
    evidence: { figures: new Map(), dates: new Set(), terms, verbatimRuns: runs, labels },
    instructions: renderMailContentTriageInstructions({ truncated: input.truncated || input.messages.length > messages.length }),
    ordinalToMessageRef: ordinals,
  };
}
