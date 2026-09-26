// Domain readings through the governed AI runtime. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
// THE ONE PATH BY WHICH A DOMAIN PRODUCER ASKS A MODEL FOR A READING. It builds the AiRunRequest from
// the domain's task definition, the generic template, the portable `domain-reading.v1` schema and the
// governed context package the producer assembled, and runs it through `AiRuntimeGateway` -- which
// refuses unless the task is ACTIVATED, the provider policy admits it, no kill switch is set, the
// budget and lane allow it, and the principal may invoke the task. The answer is validated by the
// registered output contract before this service sees it.
//
// A PRINCIPAL IS ALWAYS NAMED. The runtime has no service account: a reading of one person's domain
// runs as that person; a reading of an ORGANIZATION domain runs as the organization's configured acting
// principal (an active member holding the domain's read authority), and the context holds only what
// that person may read. Nothing here reads a source; the producer handed the context in.

import type { AiContextPackage, AiDomainReading, AiLane, AiSupportedEvidence, AiTaskDefinition } from '@emgloop/shared';
import { DOMAIN_READING_SCHEMA_ID } from '@emgloop/shared';

import type { AiPrincipal, AiRuntimeGateway } from './gateway';
import { DOMAIN_READING_SCHEMA, DOMAIN_READING_TEMPLATE_ID, DOMAIN_READING_TEMPLATE_VERSION, renderDomainReadingInstructions, type DomainReadingFraming } from './templates/domain-reading';

export interface DomainReadingRequest {
  readonly task: AiTaskDefinition;
  readonly framing: DomainReadingFraming;
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  readonly lane?: AiLane;
  readonly subjectProvider?: string;
}

export type DomainReadingResult =
  | {
      readonly outcome: 'READ';
      readonly reading: AiDomainReading;
      readonly provenance: { readonly invocationId: string; readonly taskId: string; readonly taskVersion: string; readonly templateVersion: string; readonly providerId: string };
    }
  /** Refused before any provider was asked (not activated, policy, kill, budget, authorization). */
  | { readonly outcome: 'REFUSED_BY_LOOP'; readonly codes: readonly string[] }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly codes: readonly string[] }
  | { readonly outcome: 'REFUSED_BY_MODEL' }
  | { readonly outcome: 'FAILED'; readonly failure: string };

export class DomainReadingService {
  constructor(private readonly runtime: Pick<AiRuntimeGateway, 'run'>) {}

  async read(principal: AiPrincipal, request: DomainReadingRequest): Promise<DomainReadingResult> {
    if (request.task.outputSchemaId !== DOMAIN_READING_SCHEMA_ID) return { outcome: 'REFUSED_BY_LOOP', codes: ['WRONG_OUTPUT_CONTRACT'] };
    const result = await this.runtime.run(principal, {
      task: request.task,
      context: request.context,
      instructions: renderDomainReadingInstructions(
        request.framing,
        request.context.items.map((i) => i.sourceRef),
        [...(request.evidence.entityRefs ?? [])],
      ),
      templateId: DOMAIN_READING_TEMPLATE_ID,
      templateVersion: DOMAIN_READING_TEMPLATE_VERSION,
      schema: DOMAIN_READING_SCHEMA as unknown as Record<string, unknown>,
      evidence: request.evidence,
      ...(request.lane ? { lane: request.lane } : {}),
      ...(request.subjectProvider ? { subjectProvider: request.subjectProvider } : {}),
    });
    switch (result.outcome) {
      case 'ANSWERED': {
        const reading = result.output.domainReading;
        if (!reading) return { outcome: 'REJECTED_OUTPUT', codes: ['WRONG_SCHEMA'] };
        return {
          outcome: 'READ',
          reading,
          provenance: {
            invocationId: result.provenance.invocationId,
            taskId: request.task.taskId,
            taskVersion: result.provenance.taskVersion,
            templateVersion: result.provenance.templateVersion,
            // The target of the call that answered (after any fallback): what an OTHER_THAN_SUBJECT check excludes.
            providerId: result.provenance.requestedModel.providerId,
          },
        };
      }
      case 'REFUSED_BY_LOOP':
        return { outcome: 'REFUSED_BY_LOOP', codes: [...result.refusals] };
      case 'REJECTED_OUTPUT':
        return { outcome: 'REJECTED_OUTPUT', codes: [...result.rejections] };
      case 'REFUSED_BY_MODEL':
        return { outcome: 'REFUSED_BY_MODEL' };
      default:
        return { outcome: 'FAILED', failure: result.failure };
    }
  }
}
