// Record the AI OPERATING BUDGET -- PR 1 (AI runtime), 2026-09-26.
//
// WHAT IT RECORDS. A stored control in `ai_controls` (scope BUDGET, value `operating`, ACTIVE) whose
// `settings` are the operating budget (packages/shared/src/ai/capacity.ts): the daily cost caps per
// organization and per lane, the forward reserve, when BACKGROUND work defers, the invocation caps
// that replace the reviewed policy's while recorded, the circuit breaker, and the emergency ceiling.
// Recorded as actor OPERATIONS with a reference to the run that did it, and the operator's reason.
//
// WHERE THE FIGURES COME FROM. Exactly one of:
//   --preset initial         AI_OPERATING_BUDGET_INITIAL, the approved initial budget ($20/day per
//                            organization, $25 emergency, four lanes);
//   --settings-file <path>   a JSON object in the same shape, for raising (or lowering) limits from
//                            observed usage without a deploy.
// Either way the figures are validated TOTALLY (`aiOperatingBudgetRefusals`) against the reviewed
// policy's budget classes and the code MAXIMUMS ($100/day per organization, $125 emergency): an
// unknown key, an amount above a maximum, lanes that promise more than the organization's day, or a
// class the reviewed policy does not have is refused, every refusal code is printed, and nothing is
// written. Raising a maximum is a reviewed pull request, not an operations run.
//
// ABSENT IS TODAY'S BEHAVIOUR. With no recorded budget the gateway admits exactly as the reviewed
// budget policy says, under the always-on $25 emergency ceiling. Recording the first budget is an
// explicit commissioning act; nothing records one on deploy.
//
// DRY RUN BY DEFAULT. Without --write it prints the current budget, the requested budget in dollars
// and the validation result, and writes nothing. With --write it appends one version -- naming the
// version it read, so a budget somebody else moved in between is refused as STALE rather than
// overwritten -- or records nothing when the figures are already current (UNCHANGED).
//
// UNREADABLE IS RECOVERABLE. A recorded budget whose figures cannot be read back or do not validate
// makes the gateway refuse every AI call. This run is the repair: it prints a RECOVERY warning, reads
// the current version on its own (`operatingBudgetVersion`, which does not need the figures to
// validate), and records the corrected figures as the next version exactly like any other write --
// so a budget somebody else moved in between is still refused as STALE. A database error is not
// UNREADABLE: it throws, and nothing is written.
//
// PRINTS ONLY NON-SECRET STATE: figures, labels, versions, times, the actor kind and the length of the
// reason. Never the reason text, the reference, the database URL or a credential.
//
// Run through .github/workflows/record-ai-budget.yml (workflow_dispatch, a typed confirmation, the
// connections-<stage> environment and the stage's migrate role). NO SCHEDULE, NO PUSH, NO
// PULL_REQUEST, NO WORKFLOW_CALL. A human runs it. Needs migration 20261005000000_ai_runtime_capacity
// (NOT_MIGRATED otherwise).

import { readFile } from 'node:fs/promises';
import { AI_DEFAULT_EMERGENCY_CEILING_MICROS, AI_OPERATING_BUDGET_INITIAL, aiOperatingBudgetOf, aiOperatingBudgetRefusals, type AiControlActor } from '@emgloop/shared';
import type { AiOperatingBudgetRead } from '@emgloop/database';
import { KNOWN_BUDGET_CLASSES, operatingBudgetLines, usd } from './read-ai-provider-policy';

export interface RecordBudgetArgs {
  readonly preset: string;
  readonly settingsFile: string;
  readonly reason: string;
  readonly reference: string;
  readonly write: boolean;
}

export type RecordBudgetOutcome =
  | { readonly ok: true; readonly result: 'APPENDED' | 'UNCHANGED'; readonly version: number }
  | { readonly ok: false; readonly refusal: string };

export interface RecordBudgetDeps {
  current(): Promise<AiOperatingBudgetRead>;
  /** The budget's current version (0 when none), whether or not its figures validate. */
  currentVersion(): Promise<number>;
  record(request: {
    readonly settings: unknown;
    readonly reason: string;
    readonly expectedVersion: number;
    readonly actor: AiControlActor;
  }): Promise<RecordBudgetOutcome>;
  readSettingsFile(path: string): Promise<string>;
  log(line: string): void;
}

export type RecordBudgetResult = 'DRY_RUN' | 'RECORDED' | 'UNCHANGED' | 'INVALID' | 'REFUSED' | 'FAILED_PRECONDITION';

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,199}$/;
export const REASON_MAX_CHARS = 500;
export const BUDGET_PRESETS = ['initial'] as const;

const VALUE_FLAGS = ['--preset', '--settings-file', '--reason', '--reference'] as const;

/**
 * Flags are read left to right, and a flag's value is consumed with it -- so a reason that happens
 * to read "--write" is a reason, never the switch that makes this run write.
 */
export function parseArgs(argv: readonly string[]): RecordBudgetArgs {
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
    preset: (values['--preset'] ?? '').toLowerCase(),
    settingsFile: values['--settings-file'] ?? '',
    reason: values['--reason'] ?? '',
    reference: values['--reference'] ?? '',
    write,
  };
}

/** Everything wrong with the request, before anything is read. Empty means it may run. */
export function requestRefusals(args: RecordBudgetArgs): string[] {
  const out: string[] = [];
  if (args.preset !== '' && args.settingsFile !== '') out.push('SOURCE_AMBIGUOUS');
  else if (args.preset === '' && args.settingsFile === '') out.push('SOURCE_REQUIRED');
  else if (args.preset !== '' && !(BUDGET_PRESETS as readonly string[]).includes(args.preset)) out.push('UNKNOWN_PRESET');
  if (args.reason === '' || args.reason.length > REASON_MAX_CHARS || /[\r\n]/.test(args.reason)) out.push('REASON_REQUIRED');
  if (args.write && !REFERENCE.test(args.reference)) out.push('REFERENCE_REQUIRED');
  return out;
}

/** A JSON value with its object keys sorted, so two budgets compare by content, not key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function requestedSettings(args: RecordBudgetArgs, deps: RecordBudgetDeps): Promise<{ ok: true; settings: unknown } | { ok: false; refusal: string }> {
  // A plain JSON copy either way: what is stored is data, never a frozen code object.
  if (args.preset === 'initial') return { ok: true, settings: JSON.parse(JSON.stringify(AI_OPERATING_BUDGET_INITIAL)) };
  let text: string;
  try {
    text = await deps.readSettingsFile(args.settingsFile);
  } catch {
    return { ok: false, refusal: 'SETTINGS_FILE_UNREADABLE' };
  }
  try {
    return { ok: true, settings: JSON.parse(text) };
  } catch {
    return { ok: false, refusal: 'SETTINGS_NOT_JSON' };
  }
}

export async function runRecordAiBudget(args: RecordBudgetArgs, deps: RecordBudgetDeps): Promise<RecordBudgetResult> {
  const refusals = requestRefusals(args);
  if (refusals.length > 0) {
    deps.log(`event=PRECONDITION_FAILED reasons=${refusals.join('+')}`);
    return 'FAILED_PRECONDITION';
  }
  const requested = await requestedSettings(args, deps);
  if (!requested.ok) {
    deps.log(`event=PRECONDITION_FAILED reasons=${requested.refusal}`);
    return 'FAILED_PRECONDITION';
  }

  const current = await deps.current();
  if (current.state === 'RECORDED') {
    const head = `event=CURRENT state=RECORDED version=${current.version} recordedAt=${new Date(current.recordedAtMs).toISOString()}`;
    for (const line of operatingBudgetLines('CURRENT', head, current.budget, KNOWN_BUDGET_CLASSES)) deps.log(line);
  } else if (current.state === 'NONE') {
    deps.log(`event=CURRENT state=NONE version=0 admission=reviewed-policy emergencyUsd=${usd(AI_DEFAULT_EMERGENCY_CEILING_MICROS)}`);
  } else {
    deps.log(`event=CURRENT state=UNREADABLE version=${await deps.currentVersion()}`);
    deps.log('event=RECOVERY current budget does not validate; the gateway is refusing every AI call until corrected figures are recorded');
  }

  const invalid = aiOperatingBudgetRefusals(requested.settings, KNOWN_BUDGET_CLASSES);
  if (invalid.length > 0) {
    deps.log(`event=VALIDATION result=INVALID refusals=${invalid.join('+')}`);
    deps.log(`event=SUMMARY mode=${args.write ? 'WRITE' : 'DRY_RUN'} wrote=0`);
    return 'INVALID';
  }
  deps.log('event=VALIDATION result=VALID');
  const budget = aiOperatingBudgetOf(requested.settings, KNOWN_BUDGET_CLASSES)!;
  for (const line of operatingBudgetLines('REQUESTED', 'event=REQUESTED', budget, KNOWN_BUDGET_CLASSES)) deps.log(line);

  // Read again rather than reuse the version printed above: the write names what is current NOW, and
  // the store still refuses it as STALE if the budget moves before the append.
  const currentVersion = current.state === 'RECORDED' ? current.version : current.state === 'UNREADABLE' ? await deps.currentVersion() : 0;
  const unchanged = current.state === 'RECORDED' && canonical(current.budget) === canonical(budget);

  if (!args.write) {
    deps.log(`event=${unchanged ? 'WOULD_BE_UNCHANGED' : 'WOULD_RECORD'} label=${budget.label} version=${unchanged ? currentVersion : currentVersion + 1} reasonChars=${args.reason.length}`);
    deps.log('event=SUMMARY mode=DRY_RUN wrote=0');
    return 'DRY_RUN';
  }

  const outcome = await deps.record({
    settings: requested.settings,
    reason: args.reason,
    expectedVersion: currentVersion,
    actor: { kind: 'OPERATIONS', reference: args.reference },
  });
  if (!outcome.ok) {
    deps.log(`event=REFUSED refusal=${outcome.refusal}`);
    deps.log('event=SUMMARY mode=WRITE wrote=0');
    return 'REFUSED';
  }
  deps.log(`event=${outcome.result === 'APPENDED' ? 'RECORDED' : 'UNCHANGED'} label=${budget.label} version=${outcome.version} actor=OPERATIONS reasonChars=${args.reason.length}`);
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
    const result = await runRecordAiBudget(args, {
      current: () => controls.operatingBudget(KNOWN_BUDGET_CLASSES),
      currentVersion: async () => (await controls.operatingBudgetVersion()).version,
      record: async (r) => {
        const out = await controls.recordOperatingBudget({ ...r, knownClasses: KNOWN_BUDGET_CLASSES });
        return out.ok ? { ok: true, result: out.result, version: out.entry.version } : { ok: false, refusal: out.refusal };
      },
      readSettingsFile: (path) => readFile(path, 'utf8'),
      log,
    });
    return result === 'DRY_RUN' || result === 'RECORDED' || result === 'UNCHANGED' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]record-ai-budget\.ts$/;
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
