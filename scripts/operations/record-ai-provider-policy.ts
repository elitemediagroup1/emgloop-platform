// Record, re-record or KILL one AI provider's data-class policy -- activation gate G2 (2026-09-24).
//
// WHAT IT RECORDS. A stored control in `ai_controls` (scope PROVIDER_POLICY, value = the provider):
// the HIGHEST sensitivity class Loop may send that provider, with the operator's reason, recorded as
// actor OPERATIONS with a reference to the run that did it. The gateway refuses every call to a
// provider without a current ACTIVE policy whose ceiling reaches the task's own (POLICY_DENIED); a
// KILLED policy refuses it too. There is no environment variable that stands in for this -- the old
// LOOP_AI_PROVIDER_TERMS_CONFIRMED is not read by anything.
//
// DRY RUN BY DEFAULT. Without --write it prints the provider's current policy and what it would
// record, and writes nothing. With --write it appends one version -- naming the version it read, so a
// policy somebody else moved in between is refused as STALE rather than overwritten -- or records
// nothing when the state and ceiling are already current (UNCHANGED).
//
// PRINTS ONLY NON-SECRET STATE: the provider, state, ceiling, versions, times, the actor kind and the
// length of the reason. Never the database URL, never a credential.
//
// Run through .github/workflows/record-ai-provider-policy.yml (workflow_dispatch, a typed
// confirmation, the connections-<stage> environment and the stage's migrate role). NO SCHEDULE, NO
// PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. A human runs it.

import {
  AI_PROVIDER_IDS,
  AI_SENSITIVITY_CLASSES,
  type AiControlActor,
  type AiProviderPolicy,
  type AiSensitivityClass,
} from '@emgloop/shared';

export interface RecordPolicyArgs {
  readonly provider: string;
  readonly ceiling: string;
  readonly state: string;
  readonly reason: string;
  readonly reference: string;
  readonly write: boolean;
}

export type RecordOutcome =
  | { readonly ok: true; readonly result: 'APPENDED' | 'UNCHANGED'; readonly version: number }
  | { readonly ok: false; readonly refusal: string };

export interface RecordPolicyDeps {
  current(): Promise<readonly AiProviderPolicy[]>;
  record(request: {
    readonly providerId: string;
    readonly state: 'ACTIVE' | 'KILLED';
    readonly ceiling: AiSensitivityClass | null;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly actor: AiControlActor;
  }): Promise<RecordOutcome>;
  log(line: string): void;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,199}$/;
export const REASON_MAX_CHARS = 500;

const VALUE_FLAGS = ['--provider', '--ceiling', '--state', '--reason', '--reference'] as const;

/**
 * Flags are read left to right, and a flag's value is consumed with it -- so a reason that happens
 * to read "--write" is a reason, never the switch that makes this run write.
 */
export function parseArgs(argv: readonly string[]): RecordPolicyArgs {
  const values: Record<string, string> = {};
  let write = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      values[flag] = (argv[i + 1] ?? '').trim();
      i += 1;
    } else if (flag === '--write') {
      write = true;
    }
  }
  return {
    provider: values['--provider'] ?? '',
    ceiling: (values['--ceiling'] ?? '').toUpperCase(),
    state: (values['--state'] ?? '').toUpperCase(),
    reason: values['--reason'] ?? '',
    reference: values['--reference'] ?? '',
    write,
  };
}

/** Everything wrong with the request, before anything is read. Empty means it may run. */
export function requestRefusals(args: RecordPolicyArgs): string[] {
  const out: string[] = [];
  if (!(AI_PROVIDER_IDS as readonly string[]).includes(args.provider)) out.push('UNKNOWN_PROVIDER');
  if (args.state !== 'ACTIVE' && args.state !== 'KILLED') out.push('UNKNOWN_STATE');
  // An ACTIVE policy needs a ceiling. A kill may keep one or name none.
  if (args.ceiling !== '' && !(AI_SENSITIVITY_CLASSES as readonly string[]).includes(args.ceiling)) out.push('UNKNOWN_CEILING');
  if (args.state === 'ACTIVE' && args.ceiling === '') out.push('CEILING_REQUIRED');
  if (args.reason === '' || args.reason.length > REASON_MAX_CHARS || /[\r\n]/.test(args.reason)) out.push('REASON_REQUIRED');
  if (args.write && !REFERENCE.test(args.reference)) out.push('REFERENCE_REQUIRED');
  return out;
}

function describe(policy: AiProviderPolicy | undefined): string {
  if (!policy) return 'state=NONE ceiling=- version=0';
  return `state=${policy.state} ceiling=${policy.ceiling ?? '-'} version=${policy.version} recordedAt=${new Date(policy.recordedAtMs).toISOString()}`;
}

export async function runRecordAiProviderPolicy(args: RecordPolicyArgs, deps: RecordPolicyDeps): Promise<'DRY_RUN' | 'RECORDED' | 'UNCHANGED' | 'REFUSED' | 'FAILED_PRECONDITION'> {
  const refusals = requestRefusals(args);
  if (refusals.length > 0) {
    deps.log(`event=PRECONDITION_FAILED reasons=${refusals.join('+')}`);
    return 'FAILED_PRECONDITION';
  }
  const state = args.state as 'ACTIVE' | 'KILLED';
  const ceiling = args.ceiling === '' ? null : (args.ceiling as AiSensitivityClass);
  const current = (await deps.current()).find((p) => p.providerId === args.provider);
  deps.log(`event=CURRENT provider=${args.provider} ${describe(current)}`);

  const unchanged = current !== undefined && current.state === state && (current.ceiling ?? null) === ceiling;
  if (!args.write) {
    deps.log(`event=${unchanged ? 'WOULD_BE_UNCHANGED' : 'WOULD_RECORD'} provider=${args.provider} state=${state} ceiling=${ceiling ?? '-'} version=${unchanged ? current!.version : (current?.version ?? 0) + 1} reasonChars=${args.reason.length}`);
    deps.log('event=SUMMARY mode=DRY_RUN wrote=0');
    return 'DRY_RUN';
  }

  const outcome = await deps.record({
    providerId: args.provider,
    state,
    ceiling,
    reason: args.reason,
    expectedVersion: current?.version ?? 0,
    actor: { kind: 'OPERATIONS', reference: args.reference },
  });
  if (!outcome.ok) {
    deps.log(`event=REFUSED provider=${args.provider} refusal=${outcome.refusal}`);
    return 'REFUSED';
  }
  deps.log(`event=${outcome.result === 'APPENDED' ? 'RECORDED' : 'UNCHANGED'} provider=${args.provider} state=${state} ceiling=${ceiling ?? '-'} version=${outcome.version} actor=OPERATIONS reasonChars=${args.reason.length}`);
  deps.log(`event=SUMMARY mode=WRITE wrote=${outcome.result === 'APPENDED' ? 1 : 0}`);
  return outcome.result === 'APPENDED' ? 'RECORDED' : 'UNCHANGED';
}

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL?.trim()) {
    log('event=PRECONDITION_FAILED reason=missing environment missing=DATABASE_URL');
    return 2;
  }
  const { prisma, AiControlRepository } = await import('@emgloop/database');
  try {
    const controls = new AiControlRepository(prisma);
    const result = await runRecordAiProviderPolicy(args, {
      current: () => controls.providerPolicies(),
      record: async (r) => {
        const out = await controls.recordProviderPolicy(r);
        return out.ok ? { ok: true, result: out.result, version: out.entry.version } : { ok: false, refusal: out.refusal };
      },
      log,
    });
    return result === 'FAILED_PRECONDITION' || result === 'REFUSED' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]record-ai-provider-policy\.ts$/;
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
