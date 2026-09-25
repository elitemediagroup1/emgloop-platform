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
// `aiRuntimeControlsReader` (cached in-process for 30 s, never more than 60). Without a current ACTIVE
// policy whose ceiling reaches COMMUNICATION_CONTENT (the triage task's ceiling), every triage call is
// refused as POLICY_DENIED + PROVIDER_POLICY_* and the content sweep HOLDS its frontier (nothing is
// dropped). LOOP_AI_PROVIDER_TERMS_CONFIRMED is no longer read: listing a provider in the environment
// never implies its terms were confirmed.
//
// RECORDED CONTROLS (PR 1, 2026-09-26). The gateway also reads the stored KILLED switches and the
// recorded OPERATING BUDGET through `aiRuntimeControlsReader` -- one cached reader for everything this
// worker admits against, the provider policies included. With no budget recorded, admission is the
// reviewed budget policy exactly as before, plus the always-on emergency ceiling.
//
// ENABLED MEANS TRIAGE CAN RUN (PR 1 review fix). `enabled` is true only when telegram.content.triage is
// itself activated (LOOP_AI_TASKS) AND a configured, activated provider is a candidate on that task's own
// route. The forward, historical and hydration sweeps start only then, so no Telegram body is fetched for
// AI triage unless triage can actually be served.
//
// AN UNVERIFIED PROVIDER FOR AN EXEMPT SCHEMA IS REFUSED AT STARTUP (PR 1 review fix). Telegram triage v4's
// schema carries a named portability exemption and has only been verified against Anthropic
// (`AI_SCHEMA_VERIFIED_PROVIDERS`). Listing any other provider while an exempt task is activated would make
// it an eligible fallback that may reject the schema, so the worker refuses to start (NotConfigured, naming
// LOOP_AI_PROVIDERS) instead of serving it. Removed with the exemption in triage v5 (PR 3).
//
// NO CREDENTIAL VALUE IS RETURNED, LOGGED OR ECHOED. It goes straight into the provider factory and
// nowhere else. The message body the triage judges never reaches this module -- it is assembled into a
// context package inside the service and dropped after the one governed call.

import { randomUUID } from 'crypto';

import {
  AiRuntimeGateway,
  DurableAiUsageLedger,
  TelegramContentTriageService,
  aiRuntimeControlsReader,
  iamAiAuthorizer,
  type AiRuntimeControls,
  type TelegramContentTriageRuntime,
} from '@emgloop/database';
import { AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, AI_ROUTING_POLICY, aiCatalogCapabilities, aiSchemaUnverifiedProviders } from '@emgloop/providers';
import {
  createAnthropicProvider,
  createOpenAiProvider,
  type AiProviderClient,
  type AiProviderClientOptions,
} from '@emgloop/providers/src/ai/adapters/sdk-clients';
import {
  AI_ACTIVATION_OFF,
  AI_KILL_SWITCH_SCOPES,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  aiEffectiveBudgetPolicy,
  aiTask,
  type AiActivation,
  type AiBudgetPolicy,
  type AiKillSwitch,
  type AiRoutingPolicy,
  type AiSpendSnapshot,
} from '@emgloop/shared';
import type { PrismaClient } from '@prisma/client';

import { NotConfigured } from './config';

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

/**
 * Whether telegram.content.triage can actually be served: the runtime is on, the task is activated, and a
 * configured, activated provider is a candidate on the task's own route (its primary, or its fallback when
 * the route permits one). Pure, so the gate the three sweeps start on is testable without a process.
 */
export function workerTriageRunnable(activation: AiActivation, routing: AiRoutingPolicy = AI_ROUTING_POLICY): boolean {
  const taskId = AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId;
  if (activation.enabled !== true || !activation.tasks.includes(taskId)) return false;
  const route = routing.tasks[taskId];
  if (!route) return false;
  const candidates = [route.primary, ...(route.fallbackPermitted && route.fallback ? [route.fallback] : [])];
  return candidates.some((target) => activation.providers.includes(target.providerId));
}

/**
 * Refuse a configuration that would let a provider serve a task whose output schema it was never verified
 * against (`AI_SCHEMA_VERIFIED_PROVIDERS`). Throws NotConfigured naming the setting and the provider ids
 * (not secrets); the worker logs it as `worker_fatal` and does not start. Data-driven: since Chats v5
 * (triage schema v5 is portable) no schema is exempt, so nothing is refused here -- the mechanism stays
 * for any future exemption, which must arrive with its verified-provider list.
 */
export function assertWorkerProvidersVerified(listedProviders: readonly string[], activatedTasks: readonly string[]): void {
  for (const taskId of activatedTasks) {
    const task = aiTask(taskId);
    if (!task) continue;
    const unverified = aiSchemaUnverifiedProviders(task.outputSchemaId, listedProviders);
    if (unverified.length > 0) {
      throw new NotConfigured(
        `LOOP_AI_PROVIDERS (${unverified.join(',')} is not verified against ${task.outputSchemaId}, which ${taskId} sends; ` +
          `remove it, or remove ${taskId} from LOOP_AI_TASKS, until that schema is portable)`,
      );
    }
  }
}

function present(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

export interface WorkerAiRuntime {
  /** The governed triage service. When AI is off it still exists, and every call is refused. */
  readonly service: TelegramContentTriageService;
  /** True only when at least one provider on the triage route has a usable client AND is activated. */
  readonly enabled: boolean;
  /**
   * How many more `telegram.content.triage` invocations this organization could make NOW before the
   * most binding daily invocation cap (task, organization or global window), read from the SAME durable
   * ledger and windows the gateway admits against. Advisory: the gateway's own reservation remains
   * authoritative. Used by the Chats Intelligence hydration to leave forward triage its reserve.
   */
  triageHeadroom(organizationId: string, at: Date): Promise<number>;
  /**
   * Loop Intelligence: the SAME governed gateway, for the domain producers the worker hosts, and the
   * task ids this deployment activated. A task not listed is never called (the domain kit checks first).
   */
  readonly runtime: TelegramContentTriageRuntime;
  readonly activatedTasks: readonly string[];
}

/**
 * One task's invocation headroom in a spend snapshot: the smallest of (cap - used) over the task,
 * organization and global windows. The task cap is read from the budget policy via the task's routing
 * budget class -- never a literal. A missing route, class or unusable cap is 0 (fail closed). PR 1: generic
 * over the task; pass the EFFECTIVE policy (`aiEffectiveBudgetPolicy`) when an operating budget is recorded.
 */
export function aiInvocationHeadroom(
  taskId: string,
  spend: AiSpendSnapshot,
  budget: AiBudgetPolicy = AI_BUDGET_POLICY,
  routing: AiRoutingPolicy = AI_ROUTING_POLICY,
): number {
  const route = routing.tasks[taskId];
  const cls = route ? budget.classes[route.budgetClass] : undefined;
  if (!cls) return 0;
  const room = (cap: number, used: number) => (Number.isFinite(cap) && cap > 0 ? cap - used : 0);
  return Math.max(
    0,
    Math.min(
      room(cls.taskDaily.maxInvocations, spend.task.invocations),
      room(budget.organizationDaily.maxInvocations, spend.organization.invocations),
      room(budget.globalDaily.maxInvocations, spend.global.invocations),
    ),
  );
}

/** telegram.content.triage's invocation headroom: `aiInvocationHeadroom` for that task. */
export function triageInvocationHeadroom(
  spend: AiSpendSnapshot,
  budget: AiBudgetPolicy = AI_BUDGET_POLICY,
  routing: AiRoutingPolicy = AI_ROUTING_POLICY,
): number {
  return aiInvocationHeadroom(AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId, spend, budget, routing);
}

/**
 * The triage headroom reader over the durable ledger, for the organizations this activation names. With a
 * recorded operating budget the caps are the EFFECTIVE ones; a budget that cannot be read is 0 headroom
 * (the hydration then holds), never "unlimited".
 */
export function ledgerTriageHeadroom(
  prisma: PrismaClient,
  activeOrganizations: readonly string[],
  controls: Pick<AiRuntimeControls, 'operatingBudget'> = aiRuntimeControlsReader(prisma),
): (organizationId: string, at: Date) => Promise<number> {
  const ledger = new DurableAiUsageLedger(prisma);
  return async (organizationId, at) => {
    let operating = null;
    try {
      const reading = await controls.operatingBudget();
      if (reading.state === 'UNREADABLE') return 0;
      operating = reading.state === 'RECORDED' ? reading.budget : null;
    } catch {
      return 0;
    }
    const spend = await ledger.spend(organizationId, AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId, at, activeOrganizations, operating);
    return triageInvocationHeadroom(spend, aiEffectiveBudgetPolicy(AI_BUDGET_POLICY, operating));
  };
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
    return {
      service: new TelegramContentTriageService({ runtime: options.runtime }),
      enabled: true,
      triageHeadroom: ledgerTriageHeadroom(prisma, parseList(env.LOOP_AI_ORGANIZATIONS)),
      runtime: options.runtime,
      activatedTasks: parseList(env.LOOP_AI_TASKS),
    };
  }

  const listed = workerListedProviders(env);
  const killSwitches = parseKillSwitches(env.LOOP_AI_KILL_SWITCHES);

  // Exactly "true". A switch that spends money is turned on deliberately or not at all.
  if (env.LOOP_AI_ENABLED !== 'true') {
    return assemble(prisma, AI_ACTIVATION_OFF, killSwitches, [], now, options.newInvocationId);
  }

  // Refused before any client is built: an unverified provider must never become eligible for an exempt schema.
  assertWorkerProvidersVerified(listed, parseList(env.LOOP_AI_TASKS));

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
  // One cached reader for every recorded control this worker admits against (<= 60 s).
  const controls = aiRuntimeControlsReader(prisma);
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
      providerPolicies: controls.providerPolicies,
      // PR 1: stored KILLED switches and the recorded operating budget, from the same database.
      storedKillSwitches: controls.storedKillSwitches,
      operatingBudget: controls.operatingBudget,
    },
  );
  // Triage itself must be runnable -- activated, with a configured provider on its own route -- or the
  // sweeps never start and no Telegram body is fetched for AI triage.
  const enabled = providers.length > 0 && workerTriageRunnable(activation);
  return {
    service: new TelegramContentTriageService({ runtime: gateway }),
    runtime: gateway,
    activatedTasks: activation.enabled ? activation.tasks : [],
    enabled,
    triageHeadroom: ledgerTriageHeadroom(prisma, activation.organizations, controls),
  };
}
