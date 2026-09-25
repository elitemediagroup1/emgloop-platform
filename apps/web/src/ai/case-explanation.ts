// Case Explanation, assembled for a web request. Slice AI-5. SERVER ONLY.
//
// This is where the pieces meet: the deployment environment (credentials and
// activation, read by ai-environment.ts and nowhere else), the reviewed routing and
// budget policies, the durable usage ledger, the IAM authorizer and the Case
// Explanation service. Nothing here decides anything those pieces do not already
// decide, and nothing here names a provider or a model.
//
// THE PRINCIPAL COMES FROM THE SIGNED SESSION, supplied by the guarded caller. No
// organization, user or model is ever taken from a request.
//
// WITH THE DEFAULT ENVIRONMENT THIS MAKES NO PROVIDER CALL. The runtime is off until
// LOOP_AI_ENABLED is exactly "true" and the organization, task and provider are all
// listed; until then an explanation request is refused before any reservation, and
// availability says NOT_ENABLED without calling anything. Even then, a provider receives
// nothing until a RECORDED provider policy admits the task's data class (G2): without one the
// request is refused as POLICY_DENIED. Availability does not check G2; the gateway does.

import 'server-only';

import { randomUUID } from 'crypto';
import {
  AiRuntimeGateway,
  aiRuntimeControlsReader,
  CaseExplanationService,
  DurableAiUsageLedger,
  iamAiAuthorizer,
  prisma,
  type CaseExplanationResult,
} from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, AI_ROUTING_POLICY, aiCatalogCapabilities } from '@emgloop/providers';
import { AI_TASK_CASE_EXPLANATION, aiTaskAvailability, type AiTaskAvailability } from '@emgloop/shared';

import { aiEnvironment } from './ai-environment';

export interface AiSessionPrincipal {
  readonly organizationId: string;
  readonly userId: string;
}

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
  return { env, authorize, service: new CaseExplanationService(prisma, { runtime: gateway, authorize }) };
}

/** What the Case page may offer this person. Calls nothing but the permission check. */
export async function caseExplanationAvailability(principal: AiSessionPrincipal): Promise<AiTaskAvailability> {
  const { env, service } = assemble();
  const authorized = await service.mayInvoke(principal);
  return aiTaskAvailability({
    authorized,
    activation: env.activation,
    killSwitches: env.killSwitches,
    policy: AI_ROUTING_POLICY,
    organizationId: principal.organizationId,
    taskId: AI_TASK_CASE_EXPLANATION.taskId,
  });
}

/** Explain one Case as this person. Every gate is re-decided here, whatever the page showed. */
export async function explainCase(principal: AiSessionPrincipal, caseId: string, actorName: string | null): Promise<CaseExplanationResult> {
  const { service } = assemble();
  return service.explain(principal, caseId, { actorName });
}
