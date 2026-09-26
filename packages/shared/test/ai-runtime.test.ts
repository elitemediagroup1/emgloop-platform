// The Loop AI runtime contracts. Slice AI S0.
//
// WHAT THESE PROVE
//
// AI REASONS; IT DOES NOT ESTABLISH. Nothing in these contracts can write a fact,
// establish identity, create a Relationship or propose a Decision. The output shape
// has no field for it, the tool shape refuses a tool that writes, and the governance
// gate refuses a request carrying one.
//
// LOOP OWNS ROUTING. A reviewed, versioned policy maps each task version to an exact
// primary and fallback model. No behaviour branches on a vendor's name, and a fence
// over the source proves it -- because "Claude does X, OpenAI does Y" is the sentence
// that ends provider neutrality, and it always arrives as a convenience.
//
// AN ANSWER IS REJECTED WHOLE. An uncited claim, a citation nobody supplied, a
// figure the facts do not contain, a self-scored confidence, or a recommendation
// from a read-only task: any one of them rejects the answer. There is no partial
// display, because a reader cannot tell which half was invented.
//
// IT IS OFF UNTIL SOMEBODY TURNS IT ON, FOUR TIMES. The global switch, the
// organization, the task and the provider are each an allowlist, and a credential is
// none of them. Any of five kill-switch scopes stops what it names.
//
// A BUDGET INCLUDES THE CALL BEING ASKED FOR. "Is there room for one more of this
// size" -- not "is anything left" -- or the call that crosses the line is admitted.

import {
  test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_CONTRACT_VERSION,
  AI_PROVIDER_IDS,
  AI_TASKS,
  AI_TASK_CASE_EXPLANATION,
  AI_TASK_MAIL_REPLY_DRAFT,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  AI_CHATS_LIMITS,
  AI_CHATS_SIGNAL_KINDS,
  AI_TRIAGE_OWED_BY,
  aiOutputContract,
  parseTriageV5Output,
  validateTriageV5Output,
  aiTermsInText,
  aiVerbatimRuns,
  AI_ACTIVATION_OFF,
  AI_NO_SPEND,
  admitAiInvocation,
  aiBudgetRefusals,
  aiCostMicros,
  estimateAiInputTokens,
  parseAiTaskOutput,
  aiNumbersInText,
  aiDatesInText,
  aiTaskAvailability,
  aiContextSourceRefs,
  aiProvenanceOf,
  aiSensitivityRank,
  aiTask,
  aiTaskContractViolations,
  aiToolsAdmissible,
  providerFailurePolicy,
  validateAiContextPackage,
  validateAiTaskOutput,
  type AiAdmissionRequest,
  type AiBudgetPolicy,
  type AiContextPackage,
  type AiRoutingPolicy,
  type AiSupportedEvidence,
  type AiTaskOutput,
} from '../src/index';

const ORG = 'org_a';

function contextPackage(patch: Partial<AiContextPackage> = {}): AiContextPackage {
  return {
    organizationId: ORG,
    viewerUserId: 'user_1',
    taskId: 'case.explanation',
    sensitivityCeiling: 'OPERATIONAL',
    items: [
      {
        blockId: `${ORG}::block_1`,
        kind: 'STRUCTURED',
        trust: 'GOVERNED_FACT',
        sourceRef: 'operational-observation:obs_1',
        content: 'situation detected; revenue down 4200 cents',
        sensitivity: 'OPERATIONAL',
        readUnder: { resource: 'commercialIntelligence', action: 'view' },
      },
    ],
    ...patch,
  };
}

const TARGET_A = { providerId: 'anthropic', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 30_000, maxOutputTokens: 2000, pricing: null } as const;
const TARGET_B = { providerId: 'openai', modelId: 'model-b', reasoningEffort: 'medium', timeoutMs: 30_000, maxOutputTokens: 2000, pricing: null } as const;

function policy(patch: Partial<AiRoutingPolicy['tasks'][string]> = {}): AiRoutingPolicy {
  return {
    version: 'routing.test.1',
    tasks: {
      'case.explanation': {
        taskId: 'case.explanation',
        taskVersion: '1.0.0',
        primary: TARGET_A,
        fallback: TARGET_B,
        fallbackPermitted: true,
        budgetClass: 'standard',
        ...patch,
      },
    },
  };
}

const BUDGET: AiBudgetPolicy = {
  version: 'budget.test.1',
  classes: {
    standard: {
      maxInputTokensPerCall: 20_000,
      maxOutputTokensPerCall: 4000,
      taskDaily: { maxInvocations: 50, maxInputTokens: 500_000, maxOutputTokens: 50_000 },
    },
  },
  organizationDaily: { maxInvocations: 100, maxInputTokens: 1_000_000, maxOutputTokens: 100_000 },
  globalDaily: { maxInvocations: 1000, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000 },
};

const ON = { enabled: true, organizations: [ORG], tasks: ['case.explanation'], providers: ['anthropic', 'openai'] } as const;

function admission(patch: Partial<AiAdmissionRequest> = {}): AiAdmissionRequest {
  return {
    taskId: 'case.explanation',
    taskVersion: '1.0.0',
    organizationId: ORG,
    authorized: true,
    activation: ON,
    policy: policy(),
    killSwitches: [],
    budget: BUDGET,
    spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND },
    estimatedInputTokens: 5000,
    registeredProviders: ['anthropic', 'openai'],
    contextRefusals: [],
    tools: [],
    // G2: both providers hold a recorded ACTIVE policy that reaches the task's ceiling. The
    // missing / KILLED / lower / unreadable cases are in ai-provider-policy.test.ts.
    providerPolicies: [
      { providerId: 'anthropic', state: 'ACTIVE', ceiling: 'OPERATIONAL', version: 1, recordedAtMs: 0 },
      { providerId: 'openai', state: 'ACTIVE', ceiling: 'OPERATIONAL', version: 1, recordedAtMs: 0 },
    ],
    sensitivityCeiling: 'OPERATIONAL',
    ...patch,
  };
}

function refusalsOf(result: ReturnType<typeof admitAiInvocation>): readonly string[] {
  return result.ok ? [] : result.refusals;
}

function output(patch: Partial<AiTaskOutput> = {}): AiTaskOutput {
  return {
    schemaId: 'case-explanation.v2',
    summary: 'Revenue fell on this campaign in the observed period.',
    claims: [{ kind: 'OBSERVATION', statement: 'Revenue fell by 4200 cents.', citations: ['operational-observation:obs_1'], figures: [{ label: 'revenueCents', value: 4200 }] }],
    limitations: ['No data after the observed period was supplied.'],
    ...patch,
  };
}

// --- 1. The task ------------------------------------------------------------------

test('the first task is read-only, operational, structured, and tool-free', () => {
  assert.equal(AI_CONTRACT_VERSION, 'loop-ai.v1');
  // The first three are the pre-intelligence tasks; Loop Intelligence tasks follow them (defined, not activated).
  assert.deepEqual(AI_TASKS.slice(0, 3).map((t) => t.taskId), ['case.explanation', 'mail.reply.draft', 'telegram.content.triage']);
  const task = aiTask('case.explanation')!;
  assert.equal(task, AI_TASK_CASE_EXPLANATION);
  assert.equal(task.consequence, 'READ_ONLY');
  assert.equal(task.sensitivityCeiling, 'OPERATIONAL');
  assert.deepEqual([...task.tools], [], 'no tools at launch');
  assert.equal(task.outputSchemaId, 'case-explanation.v2', 'structured output only');
  assert.equal(task.version, '2.0.0');
  assert.deepEqual([...task.requires], [{ resource: 'commercialIntelligence', action: 'view' }]);
  // Reading the evidence and paying to have it explained are different acts.
  assert.deepEqual([...task.invokerRoles], ['OWNER', 'ADMIN']);
  for (const t of AI_TASKS) assert.ok(!t.invokerRoles.includes('AI_EMPLOYEE'), `${t.taskId} is never invoked by a machine`);
  assert.equal(aiTask('anything.else'), null);
  // No task may write, and none proposes either. A DRAFT is NON_AUTHORITATIVE by the ownership
  // table -- it is text, not an item in somebody's approval queue -- so the drafting task is
  // READ_ONLY too, and an employee pressing Send is sending their own mail rather than approving
  // a proposal of Loop's.
  for (const t of AI_TASKS) assert.equal(t.consequence, 'READ_ONLY', t.taskId);
  // And no tool: a task that publishes no tool has nothing to act WITH, whatever it proposes.
  for (const t of AI_TASKS) assert.deepEqual([...t.tools], [], `${t.taskId} publishes no tool`);
});

test('the drafting task proposes text for a person, and can reach nothing itself', () => {
  const task = aiTask('mail.reply.draft')!;
  assert.equal(task, AI_TASK_MAIL_REPLY_DRAFT);
  assert.equal(task.resultType, 'DRAFT');
  assert.equal(task.capabilityRoute, 'COMMUNICATION');
  assert.equal(task.consequence, 'READ_ONLY', 'text, not an approval item');
  // The evidence IS the correspondence, so the ceiling is content -- and the read authority is
  // the employee's own work state, which grants their own rows and nobody else's.
  assert.equal(task.sensitivityCeiling, 'COMMUNICATION_CONTENT');
  assert.deepEqual([...task.requires], [{ resource: 'employeeIntelligence', action: 'view' }]);
  // Every human role may answer their own mail; a machine is never an invoker.
  assert.equal(task.invokerRoles.includes('AI_EMPLOYEE'), false);
  assert.deepEqual([...task.invokerRoles], ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']);
  // The draft is held by the employee whose mail it is, on their own thread -- never by a shared
  // authority, and never against a CRM conversation.
  assert.deepEqual({ ...task.resultOwner }, { authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_MAIL_THREAD' });
  assert.deepEqual([...task.tools], []);
});

test('the telegram content-triage task is a conservative, employee-private, tool-free classification', () => {
  const task = aiTask('telegram.content.triage')!;
  assert.equal(task, AI_TASK_TELEGRAM_CONTENT_TRIAGE);
  assert.equal(task.resultType, 'TRIAGE');
  assert.equal(task.capabilityRoute, 'GENERAL_REASONING', 'a classification, not communication or technical analysis');
  assert.equal(task.consequence, 'READ_ONLY', 'a verdict, not an approval item');
  // The evidence IS the message, so the ceiling is content; the read authority is the employee's own
  // source connection, which grants their own rows and nobody else's.
  assert.equal(task.sensitivityCeiling, 'COMMUNICATION_CONTENT');
  assert.deepEqual([...task.requires], [{ resource: 'sourceConnections', action: 'view' }]);
  // Every human role may triage their own conversation; a machine is never an invoker.
  assert.equal(task.invokerRoles.includes('AI_EMPLOYEE'), false);
  assert.deepEqual([...task.invokerRoles], ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']);
  // The verdict is held privately by the employee whose conversation it is -- never a shared authority.
  assert.deepEqual({ ...task.resultOwner }, { authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_CONVERSATION' });
  assert.deepEqual([...task.tools], []);
  assert.equal(aiTaskContractViolations(task).length, 0, 'the task contract is coherent');
});

// --- 2. Context -------------------------------------------------------------------

test('a context package is refused whole when anything about it is wrong', () => {
  assert.deepEqual(validateAiContextPackage(contextPackage()), []);
  assert.deepEqual(validateAiContextPackage(contextPackage({ items: [] })), ['EMPTY_CONTEXT']);

  const overCeiling = contextPackage({
    items: [{ ...contextPackage().items[0]!, sensitivity: 'COMMUNICATION_CONTENT' }],
  });
  assert.deepEqual(validateAiContextPackage(overCeiling), ['ABOVE_SENSITIVITY_CEILING'],
    'a block above the ceiling refuses the package rather than being quietly dropped');

  const noSource = contextPackage({ items: [{ ...contextPackage().items[0]!, sourceRef: '' }] });
  assert.ok(validateAiContextPackage(noSource).includes('MISSING_SOURCE_REF'));

  const noAuthority = contextPackage({
    items: [{ ...contextPackage().items[0]!, readUnder: { resource: '', action: 'view' } }],
  });
  assert.ok(validateAiContextPackage(noAuthority).includes('MISSING_READ_AUTHORITY'));

  const otherOrg = contextPackage({ items: [{ ...contextPackage().items[0]!, blockId: 'org_b::block_9' }] });
  assert.ok(validateAiContextPackage(otherOrg).includes('CROSS_ORGANIZATION_BLOCK'));

  // An id that simply omits the organization used to skip the check entirely.
  const unprefixed = contextPackage({ items: [{ ...contextPackage().items[0]!, blockId: 'block_9' }] });
  assert.ok(validateAiContextPackage(unprefixed).includes('CROSS_ORGANIZATION_BLOCK'));
  const prefixTrick = contextPackage({ items: [{ ...contextPackage().items[0]!, blockId: `${ORG}x::block_9` }] });
  assert.ok(validateAiContextPackage(prefixTrick).includes('CROSS_ORGANIZATION_BLOCK'), 'org_ax is not org_a');
  const noOrg = contextPackage({ organizationId: '' });
  assert.ok(validateAiContextPackage(noOrg).includes('CROSS_ORGANIZATION_BLOCK'));
});

test('an answer that is not the shape asked for is not read as one', () => {
  const good = output();
  assert.deepEqual(parseAiTaskOutput(JSON.parse(JSON.stringify(good))), good);
  for (const bad of [
    null,
    [],
    'text',
    { ...good, claims: 'none' },
    { ...good, summary: 7 },
    { ...good, limitations: [3] },
    { ...good, claims: [{ statement: 'x', figures: [] }] },
    { ...good, claims: [{ statement: 'x', citations: [], figures: [] }] },
    { ...good, claims: [{ statement: 'x', citations: [7], figures: [] }] },
    { ...good, claims: [{ statement: 'x', citations: [], figures: [{ label: 'n', value: '4200' }] }] },
    { ...good, claims: [{ statement: 'x', citations: [], figures: [{ label: 'n', value: Number.NaN }] }] },
    { ...good, claims: [null] },
  ]) {
    assert.equal(parseAiTaskOutput(bad), null, JSON.stringify(bad));
  }
});

test('an unclassified sensitivity is treated as the most sensitive thing there is', () => {
  assert.equal(aiSensitivityRank('OPERATIONAL'), 0);
  assert.ok(aiSensitivityRank('WORKFORCE_PII') > aiSensitivityRank('CONTACT_IDENTIFIER'));
  assert.ok(aiSensitivityRank('SOMETHING_NEW') > aiSensitivityRank('WORKFORCE_PII'), 'fails closed');
  const unknown = contextPackage({ items: [{ ...contextPackage().items[0]!, sensitivity: 'SOMETHING_NEW' as never }] });
  assert.ok(validateAiContextPackage(unknown).includes('ABOVE_SENSITIVITY_CEILING'));
});

// --- 3. Admission -----------------------------------------------------------------

test('nothing runs until somebody activates it -- globally, for the organization, the task and the provider', () => {
  assert.equal(admitAiInvocation(admission()).ok, true);
  assert.ok(refusalsOf(admitAiInvocation(admission({ activation: AI_ACTIVATION_OFF }))).includes('NOT_ACTIVATED'));
  assert.ok(refusalsOf(admitAiInvocation(admission({ activation: { ...ON, enabled: false } }))).includes('NOT_ACTIVATED'));
  assert.ok(refusalsOf(admitAiInvocation(admission({ activation: { ...ON, organizations: ['org_other'] } }))).includes('ORGANIZATION_NOT_ENABLED'));
  assert.ok(refusalsOf(admitAiInvocation(admission({ activation: { ...ON, tasks: [] } }))).includes('TASK_NOT_ENABLED'));
  assert.ok(refusalsOf(admitAiInvocation(admission({ activation: { ...ON, providers: [] } }))).includes('PROVIDER_NOT_ENABLED'));

  // "Enabled" means exactly true. A truthy string from an environment variable is not a yes.
  assert.equal(admitAiInvocation(admission({ activation: { ...ON, enabled: 'true' as unknown as boolean } })).ok, false);
  // The off constant is frozen, lists included, so nobody can switch the default on by mutation.
  assert.ok(Object.isFrozen(AI_ACTIVATION_OFF));
  assert.ok(Object.isFrozen(AI_ACTIVATION_OFF.organizations) && Object.isFrozen(AI_ACTIVATION_OFF.providers));
});

test('an unauthorized caller learns only that they are not authorized', () => {
  const denied = admitAiInvocation(admission({ authorized: false, activation: AI_ACTIVATION_OFF, killSwitches: [{ scope: 'GLOBAL' }] }));
  assert.deepEqual(refusalsOf(denied), ['NOT_AUTHORIZED'], 'not whether the runtime is on, nor what is killed');
});

test('each kill-switch scope stops exactly what it names', () => {
  const stopped = (switches: AiAdmissionRequest['killSwitches']) => admitAiInvocation(admission({ killSwitches: switches }));
  assert.equal(stopped([{ scope: 'GLOBAL' }]).ok, false);
  assert.equal(stopped([{ scope: 'TASK', value: 'case.explanation' }]).ok, false);
  assert.equal(stopped([{ scope: 'ORGANIZATION', value: ORG }]).ok, false);
  assert.equal(stopped([{ scope: 'TASK', value: 'some.other.task' }]).ok, true, 'and nothing it does not name');
  assert.equal(stopped([{ scope: 'ORGANIZATION', value: 'org_b' }]).ok, true);

  // Stopping one provider leaves the permitted fallback -- and says so, so the
  // provider never changes silently.
  const oneProvider = stopped([{ scope: 'PROVIDER', value: 'anthropic' }]);
  assert.equal(oneProvider.ok, true);
  if (oneProvider.ok) {
    assert.equal(oneProvider.route.providerId, 'openai');
    assert.deepEqual(oneProvider.skipped, [{ target: { providerId: 'anthropic', modelId: 'model-a' }, reason: 'KILL_SWITCH' }]);
  }
  const oneModel = stopped([{ scope: 'MODEL', value: 'model-a' }]);
  if (oneModel.ok) assert.equal(oneModel.route.modelId, 'model-b');
  // Stopping both leaves no route at all.
  const both = stopped([{ scope: 'PROVIDER', value: 'anthropic' }, { scope: 'PROVIDER', value: 'openai' }]);
  assert.ok(refusalsOf(both).includes('KILL_SWITCH'));
});

test('fallback is used only where the policy permits it', () => {
  const noFallback = admitAiInvocation(admission({ policy: policy({ fallbackPermitted: false }), killSwitches: [{ scope: 'PROVIDER', value: 'anthropic' }] }));
  assert.equal(noFallback.ok, false, 'a killed primary with no permitted fallback is a refusal, not a silent switch');
  const ok = admitAiInvocation(admission({ policy: policy({ fallbackPermitted: false }) }));
  if (ok.ok) assert.deepEqual(ok.fallbacks, []);
  const withFallback = admitAiInvocation(admission());
  if (withFallback.ok) assert.deepEqual(withFallback.fallbacks.map((t) => t.modelId), ['model-b']);
});

test('budgets include the call being asked for, and every window is checked', () => {
  const spend = (patch: Partial<AiAdmissionRequest['spend']>) =>
    refusalsOf(admitAiInvocation(admission({ spend: { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND, ...patch } })));
  // 99 of 100 spent: exactly one more fits.
  assert.deepEqual(spend({ organization: { invocations: 99, inputTokens: 0, outputTokens: 0 } }), []);
  assert.ok(spend({ organization: { invocations: 100, inputTokens: 0, outputTokens: 0 } }).includes('BUDGET_ORGANIZATION_EXHAUSTED'));
  // Room in the count, but not for THIS call's tokens.
  assert.ok(spend({ organization: { invocations: 0, inputTokens: 996_000, outputTokens: 0 } }).includes('BUDGET_ORGANIZATION_EXHAUSTED'));
  assert.ok(spend({ task: { invocations: 50, inputTokens: 0, outputTokens: 0 } }).includes('BUDGET_TASK_EXHAUSTED'));
  assert.ok(spend({ global: { invocations: 0, inputTokens: 0, outputTokens: 999_000 } }).includes('BUDGET_GLOBAL_EXHAUSTED'));

  assert.ok(refusalsOf(admitAiInvocation(admission({ estimatedInputTokens: 20_001 }))).includes('INPUT_LIMIT_ABOVE_POLICY'));
  const bigOutput = policy({ primary: { ...TARGET_A, maxOutputTokens: 4001 }, fallback: null });
  assert.ok(refusalsOf(admitAiInvocation(admission({ policy: bigOutput }))).includes('OUTPUT_LIMIT_ABOVE_POLICY'));

  // Absent means disabled, and so does a zero or nonsense cap.
  assert.ok(refusalsOf(admitAiInvocation(admission({ budget: null }))).includes('BUDGET_NOT_CONFIGURED'));
  assert.ok(refusalsOf(admitAiInvocation(admission({ policy: policy({ budgetClass: 'unheard-of' }) }))).includes('BUDGET_CLASS_UNKNOWN'));
  const zero = { ...BUDGET, organizationDaily: { maxInvocations: 0, maxInputTokens: 1, maxOutputTokens: 1 } };
  assert.ok(aiBudgetRefusals(zero, 'standard', { inputTokens: 0, outputTokens: 0 }, { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND }).includes('BUDGET_ORGANIZATION_EXHAUSTED'));
  const nan = { ...BUDGET, globalDaily: { maxInvocations: Number.NaN, maxInputTokens: 1e9, maxOutputTokens: 1e9 } };
  assert.ok(aiBudgetRefusals(nan, 'standard', { inputTokens: 0, outputTokens: 0 }, { organization: AI_NO_SPEND, task: AI_NO_SPEND, global: AI_NO_SPEND }).includes('BUDGET_GLOBAL_EXHAUSTED'));
});

test('estimates err high, and cost is priced from a versioned list or not at all', () => {
  const text = 'x'.repeat(4000);
  // Real tokenizers manage roughly 3-4 characters per token on English. Two is pessimistic by design.
  assert.ok(estimateAiInputTokens([text]) >= 2000 + 1024);
  assert.equal(estimateAiInputTokens([]), 1024);
  const pricing = { listVersion: 'list.test', inputMicrosPerToken: 5, outputMicrosPerToken: 25 };
  assert.equal(aiCostMicros(pricing, { inputTokens: 1000, outputTokens: 100 }), 7500);
  assert.equal(aiCostMicros(null, { inputTokens: 1000, outputTokens: 100 }), null, 'unpriced is unknown, not free');
  assert.equal(aiCostMicros(pricing, { inputTokens: null, outputTokens: 100 }), null, 'unreported is unknown, not free');
});

test('a writing tool, a refused context and an unregistered provider each refuse the invocation', () => {
  const writing = admitAiInvocation(admission({ tools: [{ writes: true }] }));
  assert.ok(refusalsOf(writing).includes('WRITING_TOOL_REQUESTED'));
  // A tool that forgot to say is not assumed harmless.
  assert.equal(aiToolsAdmissible([{}]), false);
  assert.equal(aiToolsAdmissible([{ writes: false }]), true);

  const badContext = admitAiInvocation(admission({ contextRefusals: ['ABOVE_SENSITIVITY_CEILING'] }));
  assert.ok(refusalsOf(badContext).includes('CONTEXT_REFUSED'), 'a package the context contract refused is never sent');

  const none = admitAiInvocation(admission({ registeredProviders: [] }));
  assert.ok(refusalsOf(none).includes('PROVIDER_NOT_REGISTERED'));

  const noRoute = admitAiInvocation(admission({ policy: { version: 'empty', tasks: {} } }));
  assert.ok(refusalsOf(noRoute).includes('NO_ROUTE_FOR_TASK'));

  // A task version the routing policy was not reviewed against is not guessed at.
  const newer = admitAiInvocation(admission({ taskVersion: '2.0.0' }));
  assert.ok(refusalsOf(newer).includes('ROUTE_TASK_VERSION_MISMATCH'));
});

test('routing is policy: the same task reaches a different provider by configuration alone', () => {
  const anthropicFirst = admitAiInvocation(admission());
  const openaiFirst = admitAiInvocation(admission({ policy: policy({ primary: TARGET_B, fallback: TARGET_A }) }));
  assert.ok(anthropicFirst.ok && openaiFirst.ok);
  if (anthropicFirst.ok && openaiFirst.ok) {
    assert.equal(anthropicFirst.route.providerId, 'anthropic');
    assert.equal(openaiFirst.route.providerId, 'openai');
    assert.deepEqual(anthropicFirst.fallbacks.map((t) => t.providerId), ['openai']);
    assert.deepEqual(openaiFirst.fallbacks.map((t) => t.providerId), ['anthropic']);
    assert.equal(anthropicFirst.routingPolicyVersion, 'routing.test.1', 'which table chose it is recorded');
  }
  // Both vendors are data in one list, neither is special.
  assert.deepEqual([...AI_PROVIDER_IDS], ['anthropic', 'openai']);
});

// --- 4. Failure handling ------------------------------------------------------------

test('the runtime owns every retry decision, and an unknown failure is not retried', () => {
  assert.deepEqual(providerFailurePolicy('RATE_LIMITED'), { retry: true, fallback: true, repair: false, alert: false });
  assert.deepEqual(providerFailurePolicy('AUTH'), { retry: false, fallback: false, repair: false, alert: true });
  // A refusal is an outcome. Asking another provider until one agrees is shopping.
  assert.deepEqual(providerFailurePolicy('REFUSED'), { retry: false, fallback: false, repair: false, alert: false });
  assert.deepEqual(providerFailurePolicy('CONTENT_FILTERED').fallback, false);
  assert.equal(providerFailurePolicy('OUTPUT_INVALID').repair, true);
  assert.equal(providerFailurePolicy('OUTPUT_INVALID').fallback, false);
  assert.deepEqual(providerFailurePolicy('SOMETHING_NEW'), { retry: false, fallback: false, repair: false, alert: true });
  assert.deepEqual(providerFailurePolicy('UNCLASSIFIED'), { retry: false, fallback: false, repair: false, alert: true });
});

// --- 5. The answer -------------------------------------------------------------------

const OBS = 'operational-observation:obs_1';
const OTHER_REF = 'decision-evidence:ev_2';

function evidence(extra: Record<string, number[]> = {}, dates: string[] = []) {
  const figures = new Map<string, Set<number>>([[OBS, new Set([4200, 42])]]);
  for (const [ref, nums] of Object.entries(extra)) figures.set(ref, new Set(nums));
  return { figures, dates: new Set(dates) };
}

function claim(patch: Record<string, unknown> = {}) {
  return { kind: 'OBSERVATION' as const, statement: 'Revenue fell by 4200 cents.', citations: [OBS], figures: [{ label: 'revenueCents', value: 4200 }], ...patch };
}

test('an answer is accepted only when every claim stands on supplied evidence', () => {
  const refs = aiContextSourceRefs(contextPackage());
  assert.deepEqual(validateAiTaskOutput(output(), AI_TASK_CASE_EXPLANATION, refs, evidence()), []);

  const uncited = output({ claims: [claim({ statement: 'Things got worse.', citations: [], figures: [] })] });
  assert.deepEqual(validateAiTaskOutput(uncited, AI_TASK_CASE_EXPLANATION, refs, evidence()), ['UNCITED_CLAIM']);

  const invented = output({ claims: [claim({ statement: 'See the report.', citations: ['report:made-up'], figures: [] })] });
  assert.deepEqual(validateAiTaskOutput(invented, AI_TASK_CASE_EXPLANATION, refs, evidence()), ['CITATION_NOT_SUPPLIED']);

  const wrongNumber = output({ claims: [claim({ statement: 'Revenue fell by 9900 cents.', figures: [{ label: 'revenueCents', value: 9900 }] })] });
  assert.deepEqual(
    [...validateAiTaskOutput(wrongNumber, AI_TASK_CASE_EXPLANATION, refs, evidence())].sort(),
    ['FIGURE_NOT_SUPPORTED', 'UNSUPPORTED_NUMBER_IN_TEXT'],
  );

  assert.deepEqual(validateAiTaskOutput(output({ schemaId: 'something.else' }), AI_TASK_CASE_EXPLANATION, refs, evidence()), ['WRONG_SCHEMA']);
  assert.ok(validateAiTaskOutput(output({ summary: '  ', claims: [] }), AI_TASK_CASE_EXPLANATION, refs, evidence()).includes('EMPTY_ANSWER'));
  assert.deepEqual(
    validateAiTaskOutput(output({ claims: [claim({ kind: 'RECOMMENDATION' as never })] }), AI_TASK_CASE_EXPLANATION, refs, evidence()),
    ['UNKNOWN_CLAIM_KIND'],
  );
});

test('a figure must come from a source ITS OWN claim cites, including numbers written in prose', () => {
  const pkg = contextPackage({ items: [...contextPackage().items, { ...contextPackage().items[0]!, blockId: `${ORG}::b2`, sourceRef: OTHER_REF }] });
  const refs = aiContextSourceRefs(pkg);
  const ev = evidence({ [OTHER_REF]: [17] });

  // 17 is in the evidence -- but not in the source this claim cites.
  const borrowed = output({ claims: [claim({ statement: 'Calls fell to 17.', figures: [{ label: 'calls', value: 17 }] })] });
  assert.deepEqual(
    [...validateAiTaskOutput(borrowed, AI_TASK_CASE_EXPLANATION, refs, ev)].sort(),
    ['FIGURE_NOT_IN_CITED_SOURCE', 'UNSUPPORTED_NUMBER_IN_TEXT'],
  );
  // Cite both, and it stands.
  const citedBoth = output({ claims: [claim({ statement: 'Revenue fell by 4200 cents while calls fell to 17.', citations: [OBS, OTHER_REF], figures: [{ label: 'calls', value: 17 }] })] });
  assert.deepEqual(validateAiTaskOutput(citedBoth, AI_TASK_CASE_EXPLANATION, refs, ev), []);

  // A number in prose with no figure entry is still checked.
  const prose = output({ claims: [claim({ statement: 'Revenue fell by 4200 cents, about 31 percent.', figures: [] })] });
  assert.deepEqual(validateAiTaskOutput(prose, AI_TASK_CASE_EXPLANATION, refs, ev), ['UNSUPPORTED_NUMBER_IN_TEXT']);
  // Cents written as dollars is supported when the builder supplied the conversion.
  const dollars = output({ claims: [claim({ statement: 'Revenue fell by $42.', figures: [{ label: 'dollars', value: 42 }] })] });
  assert.deepEqual(validateAiTaskOutput(dollars, AI_TASK_CASE_EXPLANATION, refs, ev), []);
  // A sign is not a new number.
  const negative = output({ claims: [claim({ statement: 'Revenue moved by -4200 cents.', figures: [{ label: 'change', value: -4200 }] })] });
  assert.deepEqual(validateAiTaskOutput(negative, AI_TASK_CASE_EXPLANATION, refs, ev), []);

  // The summary and the limitations may use any supplied number, and nothing else.
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'Calls fell to 17.' }), AI_TASK_CASE_EXPLANATION, refs, ev), []);
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'Calls fell to 18.' }), AI_TASK_CASE_EXPLANATION, refs, ev), ['UNSUPPORTED_NUMBER_IN_TEXT']);
  assert.deepEqual(validateAiTaskOutput(output({ limitations: ['Only 3 days were covered.'] }), AI_TASK_CASE_EXPLANATION, refs, ev), ['UNSUPPORTED_NUMBER_IN_TEXT']);
  // Identifiers are not numbers.
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'See obs_1 and ev_2.' }), AI_TASK_CASE_EXPLANATION, refs, ev), []);
});

test('a date must be one the evidence names', () => {
  const refs = aiContextSourceRefs(contextPackage());
  const ev = evidence({}, ['2026-09-01']);
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'Since 2026-09-01 revenue fell.' }), AI_TASK_CASE_EXPLANATION, refs, ev), []);
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'Since 2026-09-02 revenue fell.' }), AI_TASK_CASE_EXPLANATION, refs, ev), ['UNSUPPORTED_DATE_IN_TEXT']);
  // A date is checked as a date, and its parts are not mistaken for numbers.
  assert.deepEqual(validateAiTaskOutput(output({ summary: 'At 2026-09-01T04:00:00Z revenue fell.' }), AI_TASK_CASE_EXPLANATION, refs, ev), []);
});

test('an answer too long to read is refused, not trimmed', () => {
  const refs = aiContextSourceRefs(contextPackage());
  const many = output({ claims: Array.from({ length: 13 }, () => claim()) });
  assert.deepEqual(validateAiTaskOutput(many, AI_TASK_CASE_EXPLANATION, refs, evidence()), ['ANSWER_TOO_LONG']);
  const wordy = output({ summary: 'Revenue fell. '.repeat(80) });
  assert.deepEqual(validateAiTaskOutput(wordy, AI_TASK_CASE_EXPLANATION, refs, evidence()), ['ANSWER_TOO_LONG']);
});

test('a model may not score its own certainty, and a read-only task may not tell anyone what to do', () => {
  const refs = aiContextSourceRefs(contextPackage());
  for (const summary of ['I am 85% confident revenue fell.', 'Revenue fell. Confidence: 0.9', 'This is 70 % certain.']) {
    assert.ok(validateAiTaskOutput(output({ summary }), AI_TASK_CASE_EXPLANATION, refs, evidence()).includes('NUMERIC_CONFIDENCE_PRESENT'), summary);
  }
  for (const summary of [
    'You should pause the campaign.',
    'We recommend pausing the campaign.',
    'The next step is to call the buyer.',
    'Please contact the buyer today.',
    'Approve the decision now.',
    'Make sure to escalate this.',
  ]) {
    assert.ok(validateAiTaskOutput(output({ summary }), AI_TASK_CASE_EXPLANATION, refs, evidence()).includes('RECOMMENDS_AN_ACTION'), summary);
  }
  // A consideration grounded in evidence, phrased as a possibility, is the task.
  const consideration = output({
    claims: [claim(), claim({ kind: 'CONSIDERATION', statement: 'It may be worth checking whether the drop coincides with a routing change.', figures: [] })],
  });
  assert.deepEqual(validateAiTaskOutput(consideration, AI_TASK_CASE_EXPLANATION, refs, evidence()), []);
  assert.deepEqual(validateAiTaskOutput(output(), AI_TASK_CASE_EXPLANATION, refs, evidence()), []);
});

test('number and date extraction', () => {
  assert.deepEqual(aiNumbersInText('Revenue fell by 4,200 cents (-12.5%) on 2026-09-01.'), [4200, 12.5]);
  assert.deepEqual(aiNumbersInText('range 10-20, 24h, 3rd, ev_12, obs12, v1.2'), [10, 20, 24, 3]);
  assert.deepEqual(aiDatesInText('from 2026-09-01 to 2026-09-07T04:00:00Z'), ['2026-09-01', '2026-09-07']);
});

test('what a screen may offer, decided without calling anything', () => {
  const base = { authorized: true, activation: ON, killSwitches: [], policy: policy(), organizationId: ORG, taskId: 'case.explanation' };
  assert.equal(aiTaskAvailability(base), 'AVAILABLE');
  assert.equal(aiTaskAvailability({ ...base, authorized: false, activation: AI_ACTIVATION_OFF }), 'NOT_AUTHORIZED');
  assert.equal(aiTaskAvailability({ ...base, activation: AI_ACTIVATION_OFF }), 'NOT_ENABLED');
  assert.equal(aiTaskAvailability({ ...base, activation: { ...ON, organizations: [] } }), 'NOT_ENABLED');
  assert.equal(aiTaskAvailability({ ...base, killSwitches: [{ scope: 'GLOBAL' }] }), 'PAUSED');
  assert.equal(aiTaskAvailability({ ...base, killSwitches: [{ scope: 'PROVIDER', value: 'anthropic' }, { scope: 'PROVIDER', value: 'openai' }] }), 'PAUSED');
  assert.equal(aiTaskAvailability({ ...base, activation: { ...ON, providers: [] } }), 'NOT_CONFIGURED');
  assert.equal(aiTaskAvailability({ ...base, killSwitches: [{ scope: 'PROVIDER', value: 'anthropic' }] }), 'AVAILABLE', 'the permitted fallback can serve');
});

test('provenance records who asked, what was sent and what answered -- including when it failed', () => {
  const pkg = contextPackage();
  const record = aiProvenanceOf(pkg, {
    invocationId: 'inv_1',
    taskVersion: '1.0.0',
    templateId: 'case-explanation',
    templateVersion: '1',
    routingPolicyVersion: 'routing.test.1',
    requestedModel: { providerId: 'anthropic', modelId: 'model-a' },
    servedModel: 'model-a-20260101',
    providerRequestId: 'req_9',
    usage: { inputTokens: 900, outputTokens: 240 },
    calls: 1,
    latencyMs: 1200,
    outcome: 'ANSWERED',
    recordedAt: '2026-09-16T10:00:00.000Z',
  });
  assert.equal(record.organizationId, ORG);
  assert.equal(record.viewerUserId, 'user_1', 'whose authority assembled the context');
  assert.deepEqual(record.contextSourceRefs, ['operational-observation:obs_1']);
  assert.equal(record.servedModel, 'model-a-20260101', 'what actually answered, not what was asked for');

  const refused = aiProvenanceOf(pkg, { ...record, outcome: 'REFUSED_BY_MODEL' });
  assert.equal(refused.outcome, 'REFUSED_BY_MODEL', 'a refusal is recorded as much as an answer');
  const failed = aiProvenanceOf(pkg, { ...record, usage: null, outcome: 'FAILED' });
  assert.equal(failed.usage, null, 'a failure nobody reported usage for is unknown, not free');
});

// --- 6. Fences -------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..');
const SDK_NAMES = /@anthropic-ai|openai|anthropic|claude-|gpt-4|gpt-5|o3-mini/i;

function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist', '.turbo', 'coverage'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  for (const root of roots) walk(join(REPO, root));
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('fence: no provider SDK or model name appears outside the provider adapters', () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of sourceFiles(['packages/shared/src', 'packages/database/src', 'packages/brain/src', 'apps/web/src'])) {
    const src = stripComments(readFileSync(file, 'utf8'));
    scanned += 1;
    // The one legitimate mention: the provider id vocabulary, which is data.
    const withoutVocabulary = src.replace(/AI_PROVIDER_IDS = \[[^\]]*\]/g, '');
    if (/from ['"](@anthropic-ai|openai)/.test(withoutVocabulary)) offenders.push(file.slice(REPO.length));
    if (/'(claude|gpt)-[\w.-]+'/i.test(withoutVocabulary)) offenders.push(file.slice(REPO.length));
  }
  assert.deepEqual(offenders, [], 'a model SDK or a hard-coded model id escaped the provider boundary');
  assert.ok(scanned > 200, `the fence actually scanned the repository (${scanned} files)`);
});

test('fence: no AI contract can write a fact, identity, Relationship or Decision', () => {
  const dir = join(__dirname, '..', 'src', 'ai');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 4, 'the fence found the contracts');
  for (const file of files) {
    const src = stripComments(readFileSync(join(dir, file), 'utf8'));
    assert.doesNotMatch(src, /prisma|\.create\(|\.update\(|\.upsert\(|\.delete\(/, `${file} must not write`);
    assert.doesNotMatch(src, /establish|supersede|CognitiveIdentity|PartyService/i, `${file} must not touch identity`);
    assert.doesNotMatch(src, /CrmRelationship|crmParticipant/i, `${file} must not touch Relationships`);
    assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(/, `${file} must be pure`);
    // No credential may be read here, or anywhere near here.
    assert.doesNotMatch(src, /API_KEY|apiKey|Authorization|Bearer/i, `${file} must not know a credential`);
  }
});

test('fence: the provider boundary imports no SDK yet, and nothing outside it may', () => {
  const boundary = join(REPO, 'packages/providers/src/ai/model-provider.ts');
  const src = stripComments(readFileSync(boundary, 'utf8'));
  assert.doesNotMatch(src, /from ['"](@anthropic-ai|openai)/, 'S0 installs no SDK');
  assert.doesNotMatch(src, /API_KEY|process\.env/, 'S0 reads no credential');
  assert.doesNotMatch(src, /fetch\(|https?:\/\//, 'S0 calls nothing');
  // And the interface exists to be implemented by exactly one kind of thing.
  assert.match(src, /interface ModelProvider/);
  // The fixture provider replays what somebody recorded; it never improvises.
  assert.match(src, /class RecordedModelProvider/);
  assert.doesNotMatch(src, /Math\.random/, 'a fixture that invents answers is a fake AI');
});

test('fence: provider conversation state is not Loop memory', () => {
  for (const file of readdirSync(join(__dirname, '..', 'src', 'ai'))) {
    const src = stripComments(readFileSync(join(__dirname, '..', 'src', 'ai', file), 'utf8'));
    // No thread, conversation or assistant id is carried between invocations: what
    // Loop knows is in Loop's authorities, and a provider's memory is not one.
    assert.doesNotMatch(src, /threadId|conversationId|assistantId|previousResponseId/i, file);
  }
});

// --- Chats v5: telegram-content-triage.v5 parse + validate (its own registered contract) ---------------

test('telegram content triage is version 4.0.0 with the portable v5 output schema, and the limits are the reviewed ones', () => {
  assert.equal(AI_TASK_TELEGRAM_CONTENT_TRIAGE.version, '4.0.0');
  assert.equal(AI_TASK_TELEGRAM_CONTENT_TRIAGE.outputSchemaId, 'telegram-content-triage.v5');
  assert.ok(aiOutputContract('telegram-content-triage.v5'), 'v5 has its own registered contract');
  assert.equal(aiOutputContract('telegram-content-triage.v4'), null, 'the retired schema has none');
  assert.equal(AI_TRIAGE_LIMITS.maxObligations, 8);
  assert.equal(AI_TRIAGE_LIMITS.maxWindowMessages, 40);
  assert.equal(AI_TRIAGE_LIMITS.maxContextInputTokens, 8000);
  assert.equal(AI_TRIAGE_LIMITS.maxMeaningChars, 140);
  assert.equal(AI_TRIAGE_LIMITS.maxTopicChars, 60);
  assert.equal(AI_TRIAGE_LIMITS.maxNextStepChars, 120);
  assert.equal(AI_TRIAGE_LIMITS.maxDeadlineChars, 40);
  assert.equal(AI_TRIAGE_LIMITS.maxCounterpartyLabelChars, 60);
  assert.equal(AI_TRIAGE_LIMITS.maxSummaryChars, 200);
  assert.equal(AI_TRIAGE_LIMITS.maxConversationTopics, 5);
  assert.equal(AI_TRIAGE_LIMITS.maxConversationTopicChars, 40);
  assert.equal(AI_TRIAGE_LIMITS.maxStatementChars, 140);
  assert.equal(AI_TRIAGE_LIMITS.maxAttentionReasonChars, 120);
  assert.equal(AI_TRIAGE_LIMITS.verbatimRunTokens, 10);
  assert.deepEqual({ ...AI_CHATS_LIMITS }, { maxSignals: 10, maxWhoChars: 60, maxStateChangeChars: 160 });
  assert.deepEqual([...AI_TRIAGE_OWED_BY], ['VIEWER', 'OTHER', 'UNKNOWN']);
  assert.deepEqual([...AI_CHATS_SIGNAL_KINDS], ['CHANGE', 'DECIDED', 'DECISION_PENDING', 'OBLIGATION', 'UNRESOLVED', 'STALLED', 'OPPORTUNITY', 'RISK', 'OPERATIONAL', 'UPCOMING']);
});

test('aiTermsInText: one tokenizer for both sides of a grounding check', () => {
  assert.deepEqual(aiTermsInText('Send it back by Thursday? Oct 3, 2026-10-03.'), ['send', 'it', 'back', 'by', 'thursday', 'oct', '3', '2026', '10', '03']);
  assert.deepEqual(aiTermsInText('Dana Reyes — Nürnberg'), ['dana', 'reyes', 'nürnberg'], 'letters in any script, lower-cased');
  assert.deepEqual(aiTermsInText('   '), []);
});

{
  const TASK = AI_TASK_TELEGRAM_CONTENT_TRIAGE;
  // Three MESSAGE items plus conversation-level items (label header, state line): anchors are in [1..3].
  const REFS = new Set(['telegram_conversation:ck', 'telegram_message:ck:1', 'telegram_message:ck:2', 'telegram_message:ck:3']);
  const SOURCE_TEXT = 'Dana Reyes: Can you send the signed roofing contract back by Thursday? Also the cap is 35 for 2026-10-03.';
  const TERMS = new Set(aiTermsInText(SOURCE_TEXT));
  const RUNS = new Set(aiVerbatimRuns(SOURCE_TEXT));
  // The labels the context showed: the conversation label and an in-group sender label.
  const LABELS = new Set(['acme roofing crew', 'charlie']);
  const EV: AiSupportedEvidence = { figures: new Map(), dates: new Set(), terms: TERMS, verbatimRuns: RUNS, labels: LABELS };
  const signal = (over: Record<string, unknown> = {}) => ({ kind: 'CHANGE', anchorOrdinal: 2, statement: 'Dana asked for the signed contract to come back', severity: 'MEDIUM', owedBy: null, who: null, ...over });
  const reading = (over: Record<string, unknown> = {}) => ({
    relevance: 'BUSINESS',
    summary: 'Dana is waiting on the countersigned roofing contract; pricing is not settled.',
    topics: ['Roofing contract', 'Cap'],
    stateChange: 'The pricing discussion stopped before anyone agreed.',
    signals: [
      signal(),
      signal({ kind: 'OBLIGATION', anchorOrdinal: 3, statement: 'Charlie said he would send the revised allocation', owedBy: 'OTHER', who: 'Charlie' }),
      signal({ kind: 'DECISION_PENDING', statement: 'The cap for the job is still open', severity: 'HIGH' }),
      signal({ kind: 'STALLED', anchorOrdinal: 3, statement: 'Nobody answered the question about the start date' }),
    ],
    attention: { needed: true, reason: 'Dana set a deadline for the contract' },
    confidence: 'MEDIUM',
    ...over,
  });
  const item = (over: Record<string, unknown> = {}) => ({
    anchorOrdinal: 2,
    category: 'REQUEST',
    oneLineMeaning: 'Dana Reyes asks for the signed roofing contract back',
    topic: 'Roofing contract',
    nextStep: 'Send the countersigned contract',
    deadline: 'by Thursday',
    owedBy: 'VIEWER',
    who: null,
    ...over,
  });
  const answer = (items: unknown = [item()], conversation: unknown = reading(), limitations: string[] = []) => ({ schemaId: 'telegram-content-triage.v5', items, conversation, limitations });
  const validate = (value: unknown, evidence: AiSupportedEvidence = EV) => {
    const parsed = parseTriageV5Output(value);
    assert.ok(parsed, 'the v5 shape parses');
    return validateTriageV5Output(parsed!, TASK, REFS, evidence);
  };

  test('v5: a well-formed answer validates; an EMPTY list and a null reading are valid; the parse carries exactly the contract', () => {
    assert.deepEqual(validate(answer()), []);
    assert.deepEqual(validate(answer([])), [], 'nothing owed is a valid answer');
    assert.deepEqual(validate(answer([item({ owedBy: 'UNKNOWN' })], null)), [], 'could not read the conversation: honest');
    const parsed = parseTriageV5Output(answer())!;
    assert.equal(parsed.chatsTriage!.items[0]!.owedBy, 'VIEWER');
    assert.equal(parsed.chatsTriage!.conversation!.signals[1]!.who, 'Charlie');
    assert.equal(parsed.claims.length, 0);
  });

  test('v5: WHO OWES IT -- VIEWER, OTHER (named only by a label the conversation showed) or UNKNOWN', () => {
    assert.deepEqual(validate(answer([item({ owedBy: 'OTHER', who: 'Charlie' })])), [], 'a grounded sender label');
    assert.deepEqual(validate(answer([item({ owedBy: 'OTHER', who: 'ACME Roofing Crew' })])), [], 'the conversation label, case-insensitive');
    assert.deepEqual(validate(answer([item({ owedBy: 'OTHER', who: null })])), [], 'someone else, not named: allowed');
    assert.ok(validate(answer([item({ owedBy: 'OTHER', who: 'Lexi' })])).includes('UNGROUNDED_PARTY'), 'a name the context never showed');
    assert.ok(validate(answer([item({ owedBy: 'OTHER', who: 'Charlie' })]), { ...EV, labels: undefined }).includes('UNGROUNDED_PARTY'), 'fail closed with no labels');
    assert.ok(validate(answer([item({ owedBy: 'VIEWER', who: 'Charlie' })])).includes('WRONG_SCHEMA'), 'the person has no label');
    assert.ok(validate(answer([item({ owedBy: 'TEAM' })])).includes('WRONG_SCHEMA'), 'no team assignment exists');
  });

  test('v5: typed signals -- closed kinds, owedBy only on an OBLIGATION, grounded parties, bounded', () => {
    assert.ok(validate(answer([], reading({ signals: [signal({ kind: 'GOSSIP' })] }))).includes('WRONG_SCHEMA'));
    assert.ok(validate(answer([], reading({ signals: [signal({ owedBy: 'VIEWER' })] }))).includes('WRONG_SCHEMA'), 'owedBy on a CHANGE');
    assert.ok(validate(answer([], reading({ signals: [signal({ kind: 'OBLIGATION', owedBy: null })] }))).includes('WRONG_SCHEMA'), 'an OBLIGATION says who owes it');
    assert.ok(validate(answer([], reading({ signals: [signal({ kind: 'OBLIGATION', owedBy: 'OTHER', who: 'Lexi' })] }))).includes('UNGROUNDED_PARTY'));
    assert.ok(validate(answer([], reading({ signals: [signal({ severity: 'CRITICAL' })] }))).includes('WRONG_SCHEMA'));
    assert.ok(validate(answer([], reading({ signals: [signal({ anchorOrdinal: 4 })] }))).includes('WRONG_SCHEMA'), 'a conversation-level ref does not widen the range');
    assert.ok(validate(answer([], reading({ signals: Array.from({ length: AI_CHATS_LIMITS.maxSignals + 1 }, () => signal()) }))).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([], reading({ signals: [signal({ statement: 'x'.repeat(AI_TRIAGE_LIMITS.maxStatementChars + 1) })] }))).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([], reading({ stateChange: 'x'.repeat(AI_CHATS_LIMITS.maxStateChangeChars + 1) }))).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([], reading({ stateChange: '  ' }))).includes('EMPTY_ANSWER'));
  });

  test('v5: the v2.1 card rules still hold -- bounded fields, a real next step, a grounded deadline, no NONE, anchors in the window', () => {
    assert.ok(validate(answer([item({ oneLineMeaning: 'x'.repeat(141) })])).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([item({ topic: 'x'.repeat(61) })])).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([item({ nextStep: ' ' })])).includes('EMPTY_ANSWER'));
    assert.ok(validate(answer([item({ deadline: 'by Friday' })])).includes('UNGROUNDED_DEADLINE'), 'a deadline the conversation never wrote');
    assert.ok(validate(answer([item({ deadline: 'by Thursday' })]), { ...EV, terms: undefined }).includes('UNGROUNDED_DEADLINE'), 'fail closed with no terms');
    assert.ok(validate(answer([item({ category: 'NONE' })])).includes('WRONG_SCHEMA'));
    assert.ok(validate(answer([item({ anchorOrdinal: 0 })])).includes('WRONG_SCHEMA'));
    assert.ok(validate(answer(Array.from({ length: 9 }, () => item()))).includes('ANSWER_TOO_LONG'));
    assert.ok(validate(answer([item()], reading(), Array.from({ length: 7 }, () => 'x'))).includes('ANSWER_TOO_LONG'));
  });

  test('v5: NO QUOTE, NO COPIED SENTENCE in the reading; attention needs exactly one reason', () => {
    assert.ok(validate(answer([], reading({ summary: 'Dana said "send it back".' }))).includes('VERBATIM_CONTENT'));
    assert.ok(validate(answer([], reading({ signals: [signal({ statement: 'Can you send the signed roofing contract back by Thursday Also' })] }))).includes('VERBATIM_CONTENT'));
    assert.ok(validate(answer([], reading()), { ...EV, verbatimRuns: undefined }).includes('VERBATIM_CONTENT'), 'fail closed with nothing to check against');
    assert.ok(validate(answer([], reading({ attention: { needed: true, reason: null } }))).includes('WRONG_SCHEMA'));
    assert.ok(validate(answer([], reading({ attention: { needed: false, reason: 'why' } }))).includes('WRONG_SCHEMA'));
  });

  test('v5: SHAPE -- an unknown key anywhere, a v4 answer, or a partial item refuses the WHOLE answer', () => {
    assert.equal(parseTriageV5Output({ ...answer(), extra: 1 }), null);
    assert.equal(parseTriageV5Output(answer([{ ...item(), counterparty: 'Dana' }])), null, 'no smuggled identity field');
    assert.equal(parseTriageV5Output(answer([item()], { ...reading(), developments: [] })), null, 'no v4 field');
    const { owedBy: _omit, ...partial } = item();
    assert.equal(parseTriageV5Output(answer([partial])), null);
    assert.equal(parseTriageV5Output({ ...answer(), schemaId: 'telegram-content-triage.v4' }), null, 'the retired schema id');
    // The claim rules never judge a triage: a triage answer routed through them is refused.
    assert.deepEqual(validateAiTaskOutput(parseTriageV5Output(answer())!, TASK, REFS, EV), ['WRONG_SCHEMA']);
  });

  test('aiVerbatimRuns: ten-token runs on the one tokenizer; a short text has none', () => {
    assert.deepEqual(aiVerbatimRuns('one two three'), []);
    const runs = aiVerbatimRuns('A b c d e f g h i j k');
    assert.deepEqual(runs, ['a b c d e f g h i j', 'b c d e f g h i j k']);
    assert.deepEqual(aiVerbatimRuns('Hello, World!', 2), ['hello world'], 'punctuation and case do not matter');
  });
}
