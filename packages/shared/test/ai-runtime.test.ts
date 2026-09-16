// The Loop AI runtime contracts. Slice AI S0.
//
// WHAT THESE PROVE
//
// AI REASONS; IT DOES NOT ESTABLISH. Nothing in these contracts can write a fact,
// establish identity, create a Relationship or propose a Decision. The output shape
// has no field for it, the tool shape refuses a tool that writes, and the governance
// gate refuses a request carrying one.
//
// LOOP OWNS ROUTING. A task names a capability profile; policy maps it to models. No
// behaviour branches on a vendor's name, and a fence over the source proves it --
// because "Claude does X, OpenAI does Y" is the sentence that ends provider
// neutrality, and it always arrives as a convenience.
//
// AN ANSWER IS REJECTED WHOLE. An uncited claim, a citation nobody supplied, a
// figure the facts do not contain, a self-scored confidence, or a recommendation
// from a read-only task: any one of them rejects the answer. There is no partial
// display, because a reader cannot tell which half was invented.
//
// IT IS OFF UNTIL SOMEBODY TURNS IT ON. `activated: false` refuses every
// invocation, and so does any of four kill-switch scopes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_CONTRACT_VERSION,
  AI_PROVIDER_IDS,
  AI_TASKS,
  AI_TASK_CASE_EXPLANATION,
  admitAiInvocation,
  aiContextSourceRefs,
  aiProvenanceOf,
  aiSensitivityRank,
  aiTask,
  aiToolsAdmissible,
  providerFailurePolicy,
  validateAiContextPackage,
  validateAiTaskOutput,
  type AiAdmissionRequest,
  type AiContextPackage,
  type AiTaskOutputV1,
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

function admission(patch: Partial<AiAdmissionRequest> = {}): AiAdmissionRequest {
  return {
    taskId: 'case.explanation',
    profile: 'EXPLANATION',
    organizationId: ORG,
    policy: { routes: { EXPLANATION: [{ providerId: 'anthropic', modelId: 'model-a' }, { providerId: 'openai', modelId: 'model-b' }] } },
    killSwitches: [],
    budget: { maxInvocationsPerDay: 100, maxInputTokensPerDay: 1_000_000, maxOutputTokensPerDay: 100_000, maxOutputTokensPerInvocation: 2000 },
    spentToday: { invocations: 0, inputTokens: 0, outputTokens: 0 },
    registeredProviders: ['anthropic', 'openai'],
    requestedMaxOutputTokens: 1200,
    contextRefusals: [],
    tools: [],
    activated: true,
    ...patch,
  };
}

function output(patch: Partial<AiTaskOutputV1> = {}): AiTaskOutputV1 {
  return {
    schemaId: 'case-explanation.v1',
    summary: 'Revenue fell on this campaign in the observed period.',
    claims: [{ statement: 'Revenue fell by 4200 cents.', citations: ['operational-observation:obs_1'], figures: [{ label: 'revenueCents', value: 4200 }] }],
    limitations: ['No data after the observed period was supplied.'],
    ...patch,
  };
}

// --- 1. The task ------------------------------------------------------------------

test('the first task is read-only, operational, structured, and tool-free', () => {
  assert.equal(AI_CONTRACT_VERSION, 'loop-ai.v1');
  assert.deepEqual(AI_TASKS.map((t) => t.taskId), ['case.explanation']);
  const task = aiTask('case.explanation')!;
  assert.equal(task, AI_TASK_CASE_EXPLANATION);
  assert.equal(task.consequence, 'READ_ONLY');
  assert.equal(task.sensitivityCeiling, 'OPERATIONAL');
  assert.deepEqual([...task.tools], [], 'no tools at launch');
  assert.equal(task.outputSchemaId, 'case-explanation.v1', 'structured output only');
  assert.deepEqual([...task.requires], [{ resource: 'commercialIntelligence', action: 'view' }]);
  assert.equal(aiTask('anything.else'), null);
  // No task may write. The vocabulary allows a proposing task later; none exists.
  for (const t of AI_TASKS) assert.equal(t.consequence, 'READ_ONLY', t.taskId);
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
});

test('an unclassified sensitivity is treated as the most sensitive thing there is', () => {
  assert.equal(aiSensitivityRank('OPERATIONAL'), 0);
  assert.ok(aiSensitivityRank('WORKFORCE_PII') > aiSensitivityRank('CONTACT_IDENTIFIER'));
  assert.ok(aiSensitivityRank('SOMETHING_NEW') > aiSensitivityRank('WORKFORCE_PII'), 'fails closed');
  const unknown = contextPackage({ items: [{ ...contextPackage().items[0]!, sensitivity: 'SOMETHING_NEW' as never }] });
  assert.ok(validateAiContextPackage(unknown).includes('ABOVE_SENSITIVITY_CEILING'));
});

// --- 3. Admission -----------------------------------------------------------------

test('nothing runs until somebody activates it', () => {
  const off = admitAiInvocation(admission({ activated: false }));
  assert.equal(off.ok, false);
  if (!off.ok) assert.ok(off.refusals.includes('NOT_ACTIVATED'));
  assert.equal(admitAiInvocation(admission()).ok, true);
});

test('each kill-switch scope stops exactly what it names', () => {
  const stopped = (switches: AiAdmissionRequest['killSwitches']) => admitAiInvocation(admission({ killSwitches: switches }));
  assert.equal(stopped([{ scope: 'GLOBAL' }]).ok, false);
  assert.equal(stopped([{ scope: 'TASK', value: 'case.explanation' }]).ok, false);
  assert.equal(stopped([{ scope: 'ORGANIZATION', value: ORG }]).ok, false);
  assert.equal(stopped([{ scope: 'TASK', value: 'some.other.task' }]).ok, true, 'and nothing it does not name');
  assert.equal(stopped([{ scope: 'ORGANIZATION', value: 'org_b' }]).ok, true);

  // Stopping one provider falls through to the next, rather than stopping the task.
  const oneProvider = stopped([{ scope: 'PROVIDER', value: 'anthropic' }]);
  assert.equal(oneProvider.ok, true);
  if (oneProvider.ok) assert.deepEqual(oneProvider.route, { providerId: 'openai', modelId: 'model-b' });
  const oneModel = stopped([{ scope: 'MODEL', value: 'model-a' }]);
  if (oneModel.ok) assert.equal(oneModel.route.modelId, 'model-b');
  // Stopping both leaves no route at all.
  assert.equal(stopped([{ scope: 'PROVIDER', value: 'anthropic' }, { scope: 'PROVIDER', value: 'openai' }]).ok, false);
});

test('budgets refuse before anything is sent, and one request cannot spend the day', () => {
  const spent = (patch: Partial<AiAdmissionRequest['spentToday']>) =>
    admitAiInvocation(admission({ spentToday: { invocations: 0, inputTokens: 0, outputTokens: 0, ...patch } }));
  const invocations = spent({ invocations: 100 });
  assert.equal(invocations.ok, false);
  if (!invocations.ok) assert.ok(invocations.refusals.includes('BUDGET_INVOCATIONS_EXHAUSTED'));
  const tokens = spent({ outputTokens: 100_000 });
  if (!tokens.ok) assert.ok(tokens.refusals.includes('BUDGET_TOKENS_EXHAUSTED'));

  const tooBig = admitAiInvocation(admission({ requestedMaxOutputTokens: 5000 }));
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.ok(tooBig.refusals.includes('OUTPUT_LIMIT_ABOVE_POLICY'));
});

test('a writing tool, a refused context and an unregistered provider each refuse the invocation', () => {
  const writing = admitAiInvocation(admission({ tools: [{ writes: true }] }));
  assert.equal(writing.ok, false);
  if (!writing.ok) assert.ok(writing.refusals.includes('WRITING_TOOL_REQUESTED'));
  // A tool that forgot to say is not assumed harmless.
  assert.equal(aiToolsAdmissible([{}]), false);
  assert.equal(aiToolsAdmissible([{ writes: false }]), true);

  const badContext = admitAiInvocation(admission({ contextRefusals: ['ABOVE_SENSITIVITY_CEILING'] }));
  assert.equal(badContext.ok, false, 'a package the context contract refused is never sent');
  if (!badContext.ok) assert.ok(badContext.refusals.includes('CONTEXT_REFUSED'));

  const none = admitAiInvocation(admission({ registeredProviders: [] }));
  assert.equal(none.ok, false);
  if (!none.ok) assert.ok(none.refusals.includes('PROVIDER_NOT_REGISTERED'));

  const noProfile = admitAiInvocation(admission({ policy: { routes: {} } }));
  if (!noProfile.ok) assert.deepEqual(noProfile.refusals, ['NO_ROUTE_FOR_PROFILE']);
});

test('routing is policy: the same task reaches a different provider by configuration alone', () => {
  const anthropicFirst = admitAiInvocation(admission());
  const openaiFirst = admitAiInvocation(
    admission({ policy: { routes: { EXPLANATION: [{ providerId: 'openai', modelId: 'model-b' }, { providerId: 'anthropic', modelId: 'model-a' }] } } }),
  );
  assert.ok(anthropicFirst.ok && openaiFirst.ok);
  if (anthropicFirst.ok && openaiFirst.ok) {
    assert.equal(anthropicFirst.route.providerId, 'anthropic');
    assert.equal(openaiFirst.route.providerId, 'openai');
    assert.deepEqual(anthropicFirst.fallbacks, [{ providerId: 'openai', modelId: 'model-b' }]);
    assert.deepEqual(openaiFirst.fallbacks, [{ providerId: 'anthropic', modelId: 'model-a' }]);
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
});

// --- 5. The answer -------------------------------------------------------------------

test('an answer is accepted only when every claim stands on supplied evidence', () => {
  const refs = aiContextSourceRefs(contextPackage());
  const figures = new Set([4200]);
  assert.deepEqual(validateAiTaskOutput(output(), AI_TASK_CASE_EXPLANATION, refs, figures), []);

  const uncited = output({ claims: [{ statement: 'Things got worse.', citations: [], figures: [] }] });
  assert.deepEqual(validateAiTaskOutput(uncited, AI_TASK_CASE_EXPLANATION, refs, figures), ['UNCITED_CLAIM']);

  const invented = output({ claims: [{ statement: 'See the report.', citations: ['report:made-up'], figures: [] }] });
  assert.deepEqual(validateAiTaskOutput(invented, AI_TASK_CASE_EXPLANATION, refs, figures), ['CITATION_NOT_SUPPLIED']);

  const wrongNumber = output({
    claims: [{ statement: 'Revenue fell by 9900 cents.', citations: ['operational-observation:obs_1'], figures: [{ label: 'revenueCents', value: 9900 }] }],
  });
  assert.deepEqual(validateAiTaskOutput(wrongNumber, AI_TASK_CASE_EXPLANATION, refs, figures), ['FIGURE_NOT_SUPPORTED']);

  assert.deepEqual(validateAiTaskOutput(output({ schemaId: 'something.else' }), AI_TASK_CASE_EXPLANATION, refs, figures), ['WRONG_SCHEMA']);
  assert.ok(validateAiTaskOutput(output({ summary: '  ', claims: [] }), AI_TASK_CASE_EXPLANATION, refs, figures).includes('EMPTY_ANSWER'));
});

test('a model may not score its own certainty, and a read-only task may not tell anyone what to do', () => {
  const refs = aiContextSourceRefs(contextPackage());
  const figures = new Set([4200]);
  for (const summary of [
    'I am 85% confident revenue fell.',
    'Revenue fell. Confidence: 0.9',
    'This is 70 % certain.',
  ]) {
    assert.ok(
      validateAiTaskOutput(output({ summary }), AI_TASK_CASE_EXPLANATION, refs, figures).includes('NUMERIC_CONFIDENCE_PRESENT'),
      summary,
    );
  }
  for (const summary of [
    'You should pause the campaign.',
    'We recommend pausing the campaign.',
    'The next step is to call the buyer.',
  ]) {
    assert.ok(
      validateAiTaskOutput(output({ summary }), AI_TASK_CASE_EXPLANATION, refs, figures).includes('RECOMMENDS_AN_ACTION'),
      summary,
    );
  }
  // Explaining what the evidence shows, without prescribing, is exactly the task.
  assert.deepEqual(validateAiTaskOutput(output(), AI_TASK_CASE_EXPLANATION, refs, figures), []);
});

test('provenance records who asked, what was sent and what answered -- including when it failed', () => {
  const pkg = contextPackage();
  const record = aiProvenanceOf(pkg, {
    invocationId: 'inv_1',
    taskVersion: '1.0.0',
    templateId: 'case-explanation',
    templateVersion: '1',
    requestedModel: { providerId: 'anthropic', modelId: 'model-a' },
    servedModel: 'model-a-20260101',
    providerRequestId: 'req_9',
    usage: { inputTokens: 900, outputTokens: 240 },
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
