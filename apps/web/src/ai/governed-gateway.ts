// The governed AI gateway, assembled once for the web server. SERVER ONLY.
//
// Every web path that calls a model goes through THIS assembly: the deployment environment
// (credentials and activation, read by ai-environment.ts and nowhere else), the reviewed routing and
// budget policies, the durable usage ledger, the IAM authorizer, and the recorded controls (provider
// policies, stored KILLED switches, the operating budget). Nothing here names a provider or a model,
// and nothing here decides anything those pieces do not already decide.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING IS CALLED: the runtime is off until LOOP_AI_ENABLED is exactly
// "true" and the organization, task and provider are all listed, and then a provider still receives
// nothing until a RECORDED provider policy admits the task's data class.

import 'server-only';

import { randomUUID } from 'crypto';
import { AiRuntimeGateway, aiRuntimeControlsReader, DurableAiUsageLedger, iamAiAuthorizer, prisma } from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, AI_ROUTING_POLICY, aiCatalogCapabilities } from '@emgloop/providers';

import { aiEnvironment } from './ai-environment';

// One cached reader per server instance (30 s, never more than 60): a provider policy, a KILLED control
// or an operating budget recorded in `ai_controls` reaches every instance within a minute, without a deploy.
const controls = aiRuntimeControlsReader(prisma);

export function governedGateway() {
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
      providerPolicies: controls.providerPolicies,
      storedKillSwitches: controls.storedKillSwitches,
      operatingBudget: controls.operatingBudget,
    },
  );
  return { env, authorize, gateway };
}
