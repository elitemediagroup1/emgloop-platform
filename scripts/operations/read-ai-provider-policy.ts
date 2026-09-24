// Read AI provider policy (G2) -- READ-ONLY. 2026-09-24.
//
// Prints every provider's CURRENT recorded policy (state, ceiling, version, when, by which kind of
// actor) and, for every AI task Loop defines, whether a recorded policy admits the task's own
// sensitivity ceiling -- i.e. whether the gateway would refuse it as POLICY_DENIED before anything
// else is considered. It writes nothing. It prints no reason text, no actor reference, no database
// URL and no credential.
//
// WHAT IT CANNOT ANSWER. Whether the runtime is activated (LOOP_AI_ENABLED and the allowlists),
// whether a credential is present, or whether a budget remains -- those are the deployment's
// environment and the ledger. A task shown as `admittedBy=anthropic` is admitted by G2 only.

import { AI_PROVIDER_IDS, AI_TASKS, aiProviderPolicyRefusal, type AiProviderPolicy } from '@emgloop/shared';

export interface ReadPolicyDeps {
  current(): Promise<readonly AiProviderPolicy[]>;
  log(line: string): void;
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
    await runReadAiProviderPolicy({ current: () => controls.providerPolicies(), log });
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
