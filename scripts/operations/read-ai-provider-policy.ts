// Read AI provider policy (G2), the operating budget and the stored platform kills -- READ-ONLY.
// 2026-09-24; the budget and kill lines added in PR 1 (AI runtime), 2026-09-26.
//
// Prints, in this order:
//   PROVIDER_POLICY   every provider's CURRENT recorded policy (state, ceiling, version, when);
//   TASK_POLICY       for every AI task Loop defines, whether a recorded policy admits the task's own
//                     sensitivity ceiling -- i.e. whether the gateway would refuse it as POLICY_DENIED
//                     before anything else is considered;
//   OPERATING_BUDGET  the recorded operating budget (capacity.ts, scope BUDGET): NONE, RECORDED with
//                     every figure in DOLLARS (and one line per lane and per budget class), or
//                     UNREADABLE -- and, in every case, the EMERGENCY_CEILING the gateway enforces;
//   STORED_KILL       every CURRENT KILLED platform switch (GLOBAL, PROVIDER, MODEL, or a platform
//                     TASK -- no organization), which the gateway honours within its cache, and a
//                     STORED_KILL_SUMMARY count;
//   SUMMARY           last, unchanged.
// The PROVIDER_POLICY, TASK_POLICY and SUMMARY lines are byte-identical to what they were before PR 1;
// the Record AI Provider Policy workflow's summary explains them.
//
// It writes nothing. It prints no reason text, no actor reference, no database URL and no credential.
//
// WHAT IT CANNOT ANSWER. Whether the runtime is activated (LOOP_AI_ENABLED and the allowlists),
// whether a credential is present, how much budget has been SPENT, or an organization's own kills (an
// organization-scoped TASK or ORGANIZATION control) -- those are the deployment's environment, the
// ledger, and each organization's own record. A task shown as `admittedBy=anthropic` is admitted by
// G2 only.

import { AI_BUDGET_POLICY } from '@emgloop/providers';
import {
  AI_DEFAULT_EMERGENCY_CEILING_MICROS,
  AI_LANES,
  AI_MICROS_PER_DOLLAR,
  AI_PROVIDER_IDS,
  AI_TASKS,
  aiProviderPolicyRefusal,
  type AiControlEntry,
  type AiOperatingBudget,
  type AiProviderPolicy,
} from '@emgloop/shared';
import type { AiOperatingBudgetRead } from '@emgloop/database';

export interface ReadPolicyDeps {
  current(): Promise<readonly AiProviderPolicy[]>;
  /** The recorded operating budget (`AiControlRepository.operatingBudget`). */
  operatingBudget(): Promise<AiOperatingBudgetRead>;
  /** Current switch controls; only platform entries (no organization) are printed. */
  platformControls(): Promise<readonly AiControlEntry[]>;
  log(line: string): void;
}

/** The reviewed policy's budget classes: the only classes a recorded budget may name. */
export const KNOWN_BUDGET_CLASSES: readonly string[] = Object.keys(AI_BUDGET_POLICY.classes);

/**
 * An organization id no organization can have. `AiControlRepository.currentFor` returns platform
 * controls (organizationId null) AND the named organization's own; there is no platform-only reader,
 * and this probe must not name a real organization. With this sentinel the organization half is always
 * empty, and the filter below keeps only organizationId === null regardless.
 */
export const PLATFORM_ONLY_ORGANIZATION = '__platform__';

const PLATFORM_KILL_SCOPES: readonly string[] = ['GLOBAL', 'PROVIDER', 'MODEL', 'TASK'];

/** Integer micro-dollars as dollars, exactly: at least two decimals, no float rounding. */
export function usd(micros: number): string {
  const whole = Math.floor(micros / AI_MICROS_PER_DOLLAR);
  const fraction = String(micros % AI_MICROS_PER_DOLLAR).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * Every figure of an operating budget, one line for the budget and one per lane and per known budget
 * class. `head` begins the first line (e.g. `event=OPERATING_BUDGET state=RECORDED version=1`) and
 * names the rest (`<event>_LANE`, `<event>_CLASS`). A class the budget does not name keeps the reviewed
 * policy's cap, printed as `maxInvocations=reviewed`.
 */
export function operatingBudgetLines(event: string, head: string, budget: AiOperatingBudget, knownClasses: readonly string[]): string[] {
  const breaker = budget.circuitBreaker ? `${budget.circuitBreaker.failures}/${budget.circuitBreaker.windowMinutes}min` : 'off';
  const lines = [
    `${head} label=${budget.label} organizationDailyUsd=${usd(budget.organizationDailyCostMicros)} emergencyUsd=${usd(budget.emergencyCostMicros)} forwardReserveUsd=${usd(budget.forwardReserveCostMicros)} backgroundDeferAtOrganizationSpendUsd=${usd(budget.backgroundMaxOrganizationSpendMicros)} backgroundDeferAtForwardUsed=${budget.backgroundMaxForwardUsedFraction} organizationDailyInvocations=${budget.organizationDailyInvocations} globalDailyInvocations=${budget.globalDailyInvocations} breaker=${breaker}`,
  ];
  for (const lane of AI_LANES) {
    const l = budget.lanes[lane];
    lines.push(`event=${event}_LANE lane=${lane} dailyUsd=${usd(l.dailyCostMicros)} maxInvocations=${typeof l.maxInvocations === 'number' ? l.maxInvocations : '-'}`);
  }
  const classes = [...new Set([...knownClasses, ...Object.keys(budget.classInvocations)])].sort();
  for (const cls of classes) {
    const cap = budget.classInvocations[cls];
    lines.push(`event=${event}_CLASS class=${cls} maxInvocations=${cap === undefined ? 'reviewed' : cap}`);
  }
  return lines;
}

export async function runReadAiProviderPolicy(deps: ReadPolicyDeps): Promise<void> {
  const policies = await deps.current();
  const providers = [...new Set([...AI_PROVIDER_IDS, ...policies.map((p) => p.providerId)])].sort();
  for (const provider of providers) {
    const p = policies.find((x) => x.providerId === provider);
    deps.log(
      p
        ? `event=PROVIDER_POLICY provider=${provider} state=${p.state} ceiling=${p.ceiling ?? '-'} version=${p.version} recordedAt=${new Date(p.recordedAtMs).toISOString()}`
        : `event=PROVIDER_POLICY provider=${provider} state=NONE ceiling=- version=0`,
    );
  }
  for (const task of AI_TASKS) {
    const admittedBy = providers.filter((provider) => aiProviderPolicyRefusal(policies, provider, task.sensitivityCeiling) === null);
    deps.log(`event=TASK_POLICY task=${task.taskId} needs=${task.sensitivityCeiling} admittedBy=${admittedBy.length ? admittedBy.join(',') : 'none'}`);
  }

  // The operating budget. NONE is today's admission (the reviewed policy) plus the always-on default
  // emergency ceiling; UNREADABLE refuses every call at the gateway until it is corrected.
  const budget = await deps.operatingBudget();
  if (budget.state === 'RECORDED') {
    const head = `event=OPERATING_BUDGET state=RECORDED version=${budget.version} recordedAt=${new Date(budget.recordedAtMs).toISOString()}`;
    for (const line of operatingBudgetLines('OPERATING_BUDGET', head, budget.budget, KNOWN_BUDGET_CLASSES)) deps.log(line);
    deps.log(`event=EMERGENCY_CEILING source=RECORDED usd=${usd(budget.budget.emergencyCostMicros)} window=trailing-24h`);
  } else if (budget.state === 'NONE') {
    deps.log('event=OPERATING_BUDGET state=NONE');
    deps.log(`event=EMERGENCY_CEILING source=DEFAULT usd=${usd(AI_DEFAULT_EMERGENCY_CEILING_MICROS)} window=trailing-24h`);
  } else {
    deps.log('event=OPERATING_BUDGET state=UNREADABLE');
    deps.log('event=EMERGENCY_CEILING source=UNREADABLE usd=- window=trailing-24h');
  }

  // Stored platform kills: what the gateway honours without a deploy.
  const kills = (await deps.platformControls())
    .filter((e) => e.target.organizationId === null && e.state === 'KILLED' && PLATFORM_KILL_SCOPES.includes(e.target.scope))
    .sort((a, b) => `${a.target.scope}|${a.target.value ?? ''}`.localeCompare(`${b.target.scope}|${b.target.value ?? ''}`));
  for (const k of kills) {
    deps.log(`event=STORED_KILL scope=${k.target.scope} value=${k.target.value ?? '-'} version=${k.version} recordedAt=${new Date(k.recordedAtMs).toISOString()}`);
  }
  deps.log(`event=STORED_KILL_SUMMARY killed=${kills.length}`);

  deps.log(`event=SUMMARY providers=${providers.length} recorded=${policies.length} wrote=0`);
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  if (!process.env.DATABASE_URL?.trim()) {
    log('event=PRECONDITION_FAILED reason=missing environment missing=DATABASE_URL');
    return 2;
  }
  const { prisma, AiControlRepository } = await import('@emgloop/database');
  try {
    const controls = new AiControlRepository(prisma);
    await runReadAiProviderPolicy({
      current: () => controls.providerPolicies(),
      operatingBudget: () => controls.operatingBudget(KNOWN_BUDGET_CLASSES),
      platformControls: () => controls.currentFor(PLATFORM_ONLY_ORGANIZATION),
      log,
    });
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-ai-provider-policy\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('event=RUN_FAILED reason=UNEXPECTED\n');
      process.exitCode = 1;
    },
  );
}
