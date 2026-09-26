// Mail content triage: one mail thread, read through the governed AI runtime (Loop Intelligence Phase D).
//
// The thread's bodies come from the governed Gmail read-through (handed in by the producer, never read
// here), enter ONE context package and ONE call, and are dropped. The answer is judged by the same
// conversation-triage contract as Telegram v5 (registered as mail-content-triage.v1). This service
// concludes; the producer writes the person's MAIL digest through the repository, which re-checks their
// MAIL content authorization inside the write.

import { AI_CHATS_LIMITS, AI_TASK_MAIL_CONTENT_TRIAGE, AI_TRIAGE_LIMITS, type AiInvocationProvenance, type AiOutputRejection } from '@emgloop/shared';

import type { AiPrincipal, AiRunRequest, AiRunResult } from './gateway';
import { buildMailTriageContext, type MailTriageContextInput } from './mail-content-triage-context';
import { MAIL_CONTENT_TRIAGE_SCHEMA, MAIL_CONTENT_TRIAGE_SCHEMA_ID, MAIL_CONTENT_TRIAGE_TEMPLATE_ID, MAIL_CONTENT_TRIAGE_TEMPLATE_VERSION } from './templates/mail-content-triage';
import type { KeyedConversationReading } from '../intelligence-fabric/conversation-digest';

export interface MailContentTriageRuntime {
  run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult>;
}

export type MailContentTriageResult =
  | {
      readonly outcome: 'TRIAGED';
      readonly reading: KeyedConversationReading | null;
      readonly obligations: readonly { readonly anchorRef: string; readonly statement: string; readonly owedBy: 'VIEWER' | 'OTHER' | 'UNKNOWN'; readonly who: string | null }[];
      readonly limitations: readonly string[];
      readonly provenance: AiInvocationProvenance;
    }
  | { readonly outcome: 'NOT_AVAILABLE' | 'REFUSED_BY_MODEL' | 'FAILED' }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[] };

export class MailContentTriageService {
  constructor(private readonly runtime: MailContentTriageRuntime) {}

  async triage(principal: AiPrincipal, input: Omit<MailTriageContextInput, 'organizationId' | 'viewerUserId'>): Promise<MailContentTriageResult> {
    const built = buildMailTriageContext({ ...input, organizationId: principal.organizationId, viewerUserId: principal.userId });
    const result = await this.runtime.run(principal, {
      task: AI_TASK_MAIL_CONTENT_TRIAGE,
      context: built.context,
      instructions: built.instructions,
      templateId: MAIL_CONTENT_TRIAGE_TEMPLATE_ID,
      templateVersion: MAIL_CONTENT_TRIAGE_TEMPLATE_VERSION,
      schema: MAIL_CONTENT_TRIAGE_SCHEMA,
      evidence: built.evidence,
    });
    if (result.outcome === 'REFUSED_BY_LOOP') return { outcome: 'NOT_AVAILABLE' };
    if (result.outcome === 'REJECTED_OUTPUT') return { outcome: 'REJECTED_OUTPUT', rejections: result.rejections };
    if (result.outcome === 'REFUSED_BY_MODEL') return { outcome: 'REFUSED_BY_MODEL' };
    if (result.outcome !== 'ANSWERED') return { outcome: 'FAILED' };
    const t = result.output.chatsTriage;
    if (!t || result.output.schemaId !== MAIL_CONTENT_TRIAGE_SCHEMA_ID) return { outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] };
    const refOf = (n: number) => built.ordinalToMessageRef.get(n) ?? null;
    const reading: KeyedConversationReading | null =
      t.conversation === null
        ? null
        : {
            relevance: t.conversation.relevance,
            summary: t.conversation.summary.trim().slice(0, AI_TRIAGE_LIMITS.maxSummaryChars),
            topics: t.conversation.topics.map((x) => x.trim()).filter(Boolean).slice(0, AI_TRIAGE_LIMITS.maxConversationTopics),
            stateChange: t.conversation.stateChange?.trim().slice(0, AI_CHATS_LIMITS.maxStateChangeChars) || null,
            signals: t.conversation.signals.flatMap((s) => {
              const anchorRef = refOf(s.anchorOrdinal);
              return anchorRef
                ? [{ kind: s.kind, anchorRef, statement: s.statement.trim().slice(0, AI_TRIAGE_LIMITS.maxStatementChars), severity: s.severity, owedBy: s.kind === 'OBLIGATION' ? s.owedBy : null, who: s.kind === 'OBLIGATION' && s.owedBy === 'OTHER' ? s.who : null }]
                : [];
            }),
            attention: t.conversation.attention,
            confidence: t.conversation.confidence,
          };
    const obligations = t.items.flatMap((o) => {
      const anchorRef = refOf(o.anchorOrdinal);
      return anchorRef ? [{ anchorRef, statement: o.oneLineMeaning, owedBy: o.owedBy, who: o.owedBy === 'OTHER' ? o.who : null }] : [];
    });
    return { outcome: 'TRIAGED', reading, obligations, limitations: result.output.limitations, provenance: result.provenance };
  }
}
