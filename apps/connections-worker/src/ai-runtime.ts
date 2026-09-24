// The Loop AI runtime, assembled for the connections worker. WORKER-ONLY.
//
// This is the worker's mirror of apps/web's server-only AI environment boundary: it reads THIS
// deployment's own env (credentials and activation), builds the SAME provider adapters, the SAME
// durable usage ledger, the SAME IAM authorizer and the SAME reviewed routing and budget policies, and
// wraps the SAME governed gateway in the SAME TelegramContentTriageService. There is NO second AI
// architecture and NO AI SDK dependency here -- only the reused @emgloop/providers adapter factories
// name a provider, exactly as apps/web does.
//
// OFF IS THE DEFAULT, AND CREDENTIALS ARE NOT A SWITCH. With LOOP_AI_ENABLED anything but exactly
// "true", no provider client is constructed and the activation is OFF, so the gateway refuses every
// invocation as NOT_ACTIVATED before a byte leaves the process. A provider client is constructed only
// when it is listed (LOOP_AI_PROVIDERS -- the credential floor) and its credential produced a usable
// client. A kill switch fails closed.
//
// G2 IS RECORDED, NOT CONFIGURED (2026-09-24). Whether Loop may SEND a provider this task's class of
// data is a stored control (`ai_controls`, scope PROVIDER_POLICY), read by the gateway through
// `aiProviderPolicyReader` (cached in-process for 30 s, never more than 60). Without a current ACTIVE
// policy whose ceiling reaches COMMUNICATION_CONTENT (the triage task's ceiling), every triage call is
// refused as POLICY_DENIED + PROVIDER_POLICY_* and the content sweep HOLDS its frontier (nothing is
// dropped). LOOP_AI_PROVIDER_TERMS_CONFIRMED is no longer read: listing a provider in the environment
// never implies its terms were confirmed.
//
// NO CREDENTIAL VALUE IS RETURNED, LOGGED OR ECHOED. It goes straight into the provider factory and
// nowhere else. The message body the triage judges never reaches this module -- it is assembled into a
// context package inside the service and dropped after the one governed call.

import { randomUUID } from 'crypto';

import {
  AiRuntimeGateway,
  DurableAiUsageLedger,
  TelegramContentTriageService,
  aiProviderPolicyReader,
  iamAiAuthorizer,
  type TelegramContentTriageRuntime,
} from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, AI_ROUTING_POLICY, aiCatalogCapabilities } from '@emgloop/providers';
import {
  createAnthropicProvider,
  createOpenAiProvider,
  type AiProviderClient,
  type AiProviderClientOptions,
} from '@emgloop/providers/src/ai/adapters/sdk-clients';
import { AI_ACTIVATION_OFF, AI_KILL_SWITCH_SCOPES, type AiActivation, type AiKillSwitch } from '@emgloop/shared';
import type { PrismaClient } from '@prisma/client';

const LIST_ITEM = /^[A-Za-z0-9_.:@-]{1,200}$/;

/** A comma-separated allowlist. Anything that is not a plain token is dropped, not guessed at. */
function parseList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((i) => i.trim()).filter((i) => LIST_ITEM.test(i)))];
}

/** `GLOBAL`, or `SCOPE:value`. An entry that cannot be read is a GLOBAL stop -- fail closed. */
function parseKillSwitches(raw: string | undefined): AiKillSwitch[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: AiKillSwitch[] = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    if (entry.toUpperCase() === 'GLOBAL') {
      out.push({ scope: 'GLOBAL' });
      continue;
    }
    const at = entry.indexOf(':');
    const scope = at > 0 ? entry.slice(0, at).toUpperCase() : '';
    const value = at > 0 ? entry.slice(at + 1).trim() : '';
    if (scope !== 'GLOBAL' && (AI_KILL_SWITCH_SCOPES as readonly string[]).includes(scope) && LIST_ITEM.test(value)) {
      out.push({ scope: scope as AiKillSwitch['scope'], value });
    } else {
      out.push({ scope: 'GLOBAL' });
    }
  }
  return out;
}

/**
 * The providers this deployment may construct a client for: LOOP_AI_PROVIDERS, and nothing else.
 * The credential floor only -- whether a provider may be SENT anything is its recorded policy (G2).
 */
export function workerListedProviders(env: Record<string, string | undefined>): string[] {
  return parseList(env.LOOP_AI_PROVIDERS);
}

function present(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

export interface WorkerAiRuntime {
  /** The governed triage service. When AI is off it still exists, and every call is refused. */
  readonly service: TelegramContentTriageService;
  /** True only when at least one provider on the triage route has a usable client AND is activated. */
  readonly enabled: boolean;
}

/**
 * Assemble the triage runtime from the worker's own environment and the shared, reviewed pieces.
 * `env` is process.env in production; tests pass a record and their own provider so no network is made.
 */
export function createWorkerAiRuntime(
  prisma: PrismaClient,
  options: {
    readonly env?: Record<string, string | undefined>;
    /** Tests only: a runtime to use instead of the assembled gateway (a RecordedModelProvider-backed one). */
    readonly runtime?: TelegramContentTriageRuntime;
    readonly now?: () => Date;
    readonly newInvocationId?: () => string;
  } = {},
): WorkerAiRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  if (options.runtime) {
    return { service: new TelegramContentTriageService({ runtime: options.runtime }), enabled: true };
  }

  const listed = workerListedProviders(env);
  const killSwitches = parseKillSwitches(env.LOOP_AI_KILL_SWITCHES);

  // Exactly "true". A switch that spends money is turned on deliberately or not at all.
  if (env.LOOP_AI_ENABLED !== 'true') {
    return assemble(prisma, AI_ACTIVATION_OFF, killSwitches, [], now, options.newInvocationId);
  }

  const build = (providerId: string, factory: (o: AiProviderClientOptions) => AiProviderClient, apiKey: string | undefined): AiProviderClient => {
    try {
      return factory({ apiKey, capabilities: (modelId: string) => aiCatalogCapabilities(providerId, modelId) });
    } catch {
      // The factory's error text is exactly where a credential could leak, so none of it is kept.
      return { providerId, state: 'PROVIDER_NOT_CONFIGURED' };
    }
  };

  const clients: AiProviderClient[] = [];
  if (listed.includes('anthropic')) {
    clients.push(build('anthropic', createAnthropicProvider, present(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : undefined));
  }
  if (listed.includes('openai')) {
    clients.push(build('openai', createOpenAiProvider, present(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : undefined));
  }
  const usable = clients.filter((c) => c.state === 'CONFIGURED').map((c) => c.providerId);
  const activation: AiActivation = Object.freeze({
    enabled: true,
    organizations: Object.freeze(parseList(env.LOOP_AI_ORGANIZATIONS)),
    tasks: Object.freeze(parseList(env.LOOP_AI_TASKS)),
    providers: Object.freeze(usable),
  });
  const providers = clients.flatMap((c) => (c.state === 'CONFIGURED' ? [c.provider] : []));
  return assemble(prisma, activation, killSwitches, providers, now, options.newInvocationId);
}

function assemble(
  prisma: PrismaClient,
  activation: AiActivation,
  killSwitches: readonly AiKillSwitch[],
  providers: readonly { readonly providerId: string; invoke: (r: any, s: AbortSignal) => Promise<any> }[],
  now: () => Date,
  newInvocationId: (() => string) | undefined,
): WorkerAiRuntime {
  const authorize = iamAiAuthorizer(prisma);
  const gateway = new AiRuntimeGateway(
    {
      activation,
      policy: AI_ROUTING_POLICY,
      budget: AI_BUDGET_POLICY,
      killSwitches,
      maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET,
    },
    {
      providers,
      ledger: new DurableAiUsageLedger(prisma),
      authorize,
      now,
      newInvocationId: newInvocationId ?? (() => randomUUID()),
      // G2: the recorded provider policies, from this worker's own database. Never the environment.
      providerPolicies: aiProviderPolicyReader(prisma),
    },
  );
  const enabled = activation.enabled && providers.length > 0 && Boolean(AI_ROUTING_POLICY.tasks['telegram.content.triage']);
  return { service: new TelegramContentTriageService({ runtime: gateway }), enabled };
}
