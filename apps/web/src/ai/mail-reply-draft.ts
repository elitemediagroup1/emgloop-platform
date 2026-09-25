// Draft with Loop, assembled for a web request. SERVER ONLY.
//
// Where the pieces meet: the deployment's AI environment (credentials and activation, read by
// ai-environment.ts and nowhere else), the reviewed routing and budget policies, the durable usage
// ledger, the IAM authorizer, the employee's own Gmail thread reader, and their own draft store.
// Nothing here decides anything those pieces do not already decide, and nothing here names a
// provider or a model.
//
// THE PRINCIPAL COMES FROM THE SIGNED SESSION, supplied by the guarded caller.
//
// WITH THE DEFAULT ENVIRONMENT THIS MAKES NO PROVIDER CALL. The runtime is off until
// LOOP_AI_ENABLED is exactly "true" and the organization, task and provider are all listed; until
// then a draft request is refused before any reservation, and availability says NOT_ENABLED
// without calling anything. Even then, a provider receives nothing until a RECORDED provider
// policy admits COMMUNICATION_CONTENT (G2): without one the request is refused as POLICY_DENIED.
// The Inbox and the manual reply do not depend on any of it.

import 'server-only';

import { randomUUID } from 'crypto';
import {
  AiRuntimeGateway,
  aiRuntimeControlsReader,
  DurableAiUsageLedger,
  MailReplyDraftService,
  WorkDraftRepository,
  iamAiAuthorizer,
  prisma,
  type MailReplyDraftResult,
  type WorkPrincipal,
} from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, AI_ROUTING_POLICY, aiCatalogCapabilities } from '@emgloop/providers';
import { AI_TASK_MAIL_REPLY_DRAFT, aiTaskAvailability, type AiTaskAvailability } from '@emgloop/shared';

import { aiEnvironment } from './ai-environment';
import { loadThread } from '../daily-loop/mail';

// One cached reader per server instance (30 s, never more than 60): a provider policy, a KILLED control
// or an operating budget recorded in `ai_controls` reaches every instance within a minute, without a deploy.
const controls = aiRuntimeControlsReader(prisma);

function assemble() {
  const env = aiEnvironment({ capabilities: aiCatalogCapabilities });
  const authorize = iamAiAuthorizer(prisma);
  const providers = env.providers.flatMap((p) => (p.state === 'CONFIGURED' ? [p.provider] : []));
  const gateway = new AiRuntimeGateway(
    {
      activation: env.activation,
      policy: AI_ROUTING_POLICY,
      budget: AI_BUDGET_POLICY,
      killSwitches: env.killSwitches,
      maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET,
    },
    {
      providers,
      ledger: new DurableAiUsageLedger(prisma),
      authorize,
      now: () => new Date(),
      newInvocationId: () => randomUUID(),
      // G2: the recorded provider policies, shared by every request this instance serves.
      providerPolicies: controls.providerPolicies,
      // PR 1: stored KILLED switches and the recorded operating budget.
      storedKillSwitches: controls.storedKillSwitches,
      operatingBudget: controls.operatingBudget,
    },
  );
  const service = new MailReplyDraftService({
    runtime: gateway,
    authorize,
    drafts: new WorkDraftRepository(prisma),
    // The SAME read the thread view performs, scoped by the same principal: a conversation this
    // person could not open is one Loop cannot draft against either.
    threads: {
      read: async (principal, threadId) => {
        const result = await loadThread(principal, threadId);
        return result.ok
          ? { ok: true, messages: result.thread.messages, selfAddress: result.selfAddress }
          : { ok: false, failure: result.failure };
      },
    },
  });
  return { env, authorize, service };
}

/** What the composer may offer this person. Calls nothing but the permission check. */
export async function mailDraftAvailability(principal: WorkPrincipal): Promise<AiTaskAvailability> {
  const { env, authorize } = assemble();
  const authorized = await authorize({ organizationId: principal.organizationId, userId: principal.userId }, AI_TASK_MAIL_REPLY_DRAFT);
  return aiTaskAvailability({
    authorized,
    activation: env.activation,
    killSwitches: env.killSwitches,
    policy: AI_ROUTING_POLICY,
    organizationId: principal.organizationId,
    taskId: AI_TASK_MAIL_REPLY_DRAFT.taskId,
  });
}

/** Draft a reply as this person. Every gate is re-decided here, whatever the page showed. */
export async function draftMailReply(
  principal: WorkPrincipal,
  request: { readonly threadId: string; readonly inReplyToMessageId?: string | null; readonly instruction?: string | null; readonly mode?: 'REPLY' | 'REPLY_ALL' },
): Promise<MailReplyDraftResult> {
  const { service } = assemble();
  return service.draftReply(principal, request);
}
