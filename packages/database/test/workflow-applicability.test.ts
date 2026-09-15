// A workflow step with nothing to act on does not apply. It does not fail.
//
// Ingested events carry no customer, because ingestion never decides who a
// caller or visitor is. Before that, every inbound call ran the seeded call
// workflows against whichever Customer ingestion had guessed: a tag, a pipeline
// status reset to New, a note. With no customer, the same steps returned
// "No customer in context." and every call produced a FAILED run.
//
// The rule now: a step whose record (customer or conversation) is absent is not
// run, writes nothing, and is recorded as not applicable. An event workflow none
// of whose steps applies starts no run at all. Steps that need no record still
// run. A person running a workflow by hand with a customer chosen still gets
// every customer step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsRepository, stepApplies, type WorkflowRunView } from '../src/repositories/workflows.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG = 'org_live';
type Row = Record<string, any>;

async function setup(workflows: Row[], customers: Row[] = []) {
  const prisma: Row = makeCognitivePrisma({
    also: ['customer', 'conversation', 'workflow', 'workflowRun', 'domainEvent', 'interaction'],
  });
  for (const c of customers) await prisma.customer.create({ data: { organizationId: ORG, ...c } });
  const ids: string[] = [];
  for (const w of workflows) {
    const row = await prisma.workflow.create({
      data: { organizationId: ORG, trigger: 'EVENT', isActive: true, ...w },
    });
    ids.push(row.id);
  }
  return { prisma, ids, repo: new WorkflowsRepository(prisma as never) };
}

const CUSTOMER_STEPS = [
  { type: 'add_tag', config: { tag: 'inbound-call' } },
  { type: 'set_pipeline_status', config: { status: 'New' } },
];

test('each step type knows the record it acts on', () => {
  const none = {};
  assert.equal(stepApplies({ type: 'add_tag' }, none), false);
  assert.equal(stepApplies({ type: 'set_pipeline_status' }, none), false);
  assert.equal(stepApplies({ type: 'assign' }, none), false);
  assert.equal(stepApplies({ type: 'create_note' }, none), false);
  assert.equal(stepApplies({ type: 'set_conversation_status' }, none), false);
  assert.equal(stepApplies({ type: 'emit_event' }, none), true, 'an event needs no record');
  assert.equal(stepApplies({ type: 'add_tag' }, { customerId: 'cust_1' }), true);
  assert.equal(stepApplies({ type: 'set_conversation_status' }, { conversationId: 'conv_1' }), true);
  assert.equal(stepApplies({ type: 'create_note' }, { conversationId: 'conv_1' }), false, 'a note is written to a customer');
});

test('an event with no customer starts no run of a customer-only workflow, and writes nothing', async () => {
  const { prisma, repo } = await setup(
    [{ name: 'First touch', triggerConfig: { eventName: 'integration.call.inbound' }, definition: { steps: CUSTOMER_STEPS } }],
    [{ id: 'cust_1', tags: ['lead'], attributes: { pipelineStatus: 'Booked' } }],
  );

  const outcomes = await repo.runWorkflowsForEvent({
    organizationId: ORG,
    eventName: 'integration.call.inbound',
    context: {},
  });

  assert.deepEqual(outcomes, [], 'no run is started');
  assert.equal(prisma.workflowRun.__rows.length, 0, 'no FAILED run, and no run at all');
  const [c] = prisma.customer.__rows;
  assert.deepEqual(c.tags, ['lead']);
  assert.equal(c.attributes.pipelineStatus, 'Booked');
});

test('a mixed workflow runs its customer-independent steps and records the others as not applicable', async () => {
  const { prisma, repo } = await setup([
    {
      name: 'Call arrived',
      triggerConfig: { eventName: 'integration.call.missed' },
      definition: {
        steps: [
          { type: 'add_tag', config: { tag: 'missed-call' } },
          { type: 'emit_event', config: { eventName: 'ops.callback_needed' } },
          { type: 'create_note', config: { text: 'Call back' } },
        ],
      },
    },
  ]);

  const outcomes = await repo.runWorkflowsForEvent({
    organizationId: ORG,
    eventName: 'integration.call.missed',
    context: {},
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, 'SUCCEEDED', 'the step that applied succeeded, and nothing failed');
  const [run] = prisma.workflowRun.__rows;
  const results = run.output.stepResults;
  assert.deepEqual(
    results.map((r: Row) => [r.type, r.applicable, r.ok]),
    [
      ['add_tag', false, false],
      ['emit_event', true, true],
      ['create_note', false, false],
    ],
  );
  assert.equal(results[0].detail, 'Not applicable: no customer in this run.');
  assert.ok(prisma.domainEvent.__rows.some((d: Row) => d.name === 'ops.callback_needed'), 'the event step ran');
  assert.equal(prisma.interaction.__rows.length, 0, 'no note was written');
  assert.equal(run.error, null);

  const view = (repo as unknown as { toRunView(r: Row): WorkflowRunView }).toRunView(run);
  assert.equal(view.summary, '1 of 1 steps succeeded · 2 not applicable');
});

test('a person running a workflow with a customer chosen still gets every customer step', async () => {
  const { prisma, repo, ids } = await setup(
    [{ name: 'First touch', trigger: 'MANUAL', triggerConfig: {}, definition: { steps: CUSTOMER_STEPS } }],
    [{ id: 'cust_1', tags: ['lead'], attributes: { pipelineStatus: 'Booked' } }],
  );

  const outcome = await repo.runWorkflow({
    organizationId: ORG,
    workflowId: ids[0]!,
    triggeredBy: 'user:u_1',
    context: { customerId: 'cust_1' },
  });

  assert.equal(outcome.status, 'SUCCEEDED');
  assert.ok(outcome.stepResults.every((s) => s.applicable && s.ok));
  const [c] = prisma.customer.__rows;
  assert.deepEqual(c.tags, ['lead', 'inbound-call']);
  assert.equal(c.attributes.pipelineStatus, 'New');
});

test('a manual run where no step applies records that nothing ran, not a failure', async () => {
  const { prisma, repo, ids } = await setup([
    { name: 'First touch', trigger: 'MANUAL', triggerConfig: {}, definition: { steps: CUSTOMER_STEPS } },
  ]);

  const outcome = await repo.runWorkflow({
    organizationId: ORG,
    workflowId: ids[0]!,
    triggeredBy: 'user:u_1',
    context: { customerId: null, conversationId: null },
  });

  assert.equal(outcome.status, 'CANCELED');
  assert.equal(outcome.run.error, 'Nothing ran: no step applies to this run.');
  assert.ok(outcome.stepResults.every((s) => !s.applicable));
  const view = (repo as unknown as { toRunView(r: Row): WorkflowRunView }).toRunView(prisma.workflowRun.__rows[0]);
  assert.equal(view.summary, 'No step applied (2 not applicable)');
});

test('a step that applies and fails still fails the run', async () => {
  const { repo, ids } = await setup([
    {
      name: 'Close it',
      trigger: 'MANUAL',
      triggerConfig: {},
      definition: { steps: [{ type: 'set_conversation_status', config: { status: 'CLOSED' } }] },
    },
  ]);

  const outcome = await repo.runWorkflow({
    organizationId: ORG,
    workflowId: ids[0]!,
    triggeredBy: 'user:u_1',
    context: { conversationId: 'conv_missing' },
  });

  assert.equal(outcome.status, 'FAILED', 'not applicable is not a way to hide a real failure');
  assert.equal(outcome.stepResults[0]!.applicable, true);
  assert.equal(outcome.stepResults[0]!.detail, 'Conversation not found.');
});

test('a run recorded before steps could be not applicable reads exactly as it did', () => {
  const repo = new WorkflowsRepository({} as never);
  const view = (repo as unknown as { toRunView(r: Row): WorkflowRunView }).toRunView({
    id: 'run_old',
    workflowId: 'wf_1',
    status: 'FAILED',
    triggeredBy: 'event:integration.call.inbound',
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    error: null,
    output: {
      stepResults: [
        { index: 0, type: 'add_tag', ok: false, detail: 'No customer in context.' },
        { index: 1, type: 'set_pipeline_status', ok: true, detail: 'Set pipeline status to New.' },
      ],
    },
  });
  assert.equal(view.status, 'FAILED');
  assert.equal(view.summary, '1 of 2 steps succeeded');
  assert.ok(view.stepResults.every((s) => s.applicable));
});
