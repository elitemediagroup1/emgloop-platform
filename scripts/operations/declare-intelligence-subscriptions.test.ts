// Declare intelligence subscriptions: dry run by default, one organization, idempotent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import { INTELLIGENCE_SUBSCRIPTIONS, declareIntelligenceSubscriptions, resolveSubscriber } from '@emgloop/database';
import { parseArgs, runDeclareIntelligenceSubscriptions } from './declare-intelligence-subscriptions';

const ORG = { id: 'org_live', slug: 'servicesinmycity-demo' };

function world() {
  const fake: any = makeCognitivePrisma();
  const prisma = fake as PrismaClient;
  const lines: string[] = [];
  return {
    fake,
    lines,
    deps: {
      organizations: { findBySlug: async (slug: string) => (slug === ORG.slug ? ORG : null) },
      declare: (id: string, o: { apply: boolean }) => declareIntelligenceSubscriptions(prisma, id, o),
      log: (l: string) => void lines.push(l),
    },
  };
}

test('dry run by default: prints what it would create and writes nothing', async () => {
  const w = world();
  assert.deepEqual(parseArgs(['--organization', ' servicesinmycity-demo ']), { organization: 'servicesinmycity-demo', apply: false });
  assert.equal(await runDeclareIntelligenceSubscriptions({ organizationSlug: ORG.slug, apply: false }, w.deps), 'DRY_RUN');
  assert.equal(w.fake.stateChangeSubscription.__rows.length, 0);
  assert.equal(w.lines.filter((l) => l.includes('result=WOULD_CREATE')).length, INTELLIGENCE_SUBSCRIPTIONS.length);
});

test('apply creates the missing rows once, leaves an existing row alone -- even one switched off', async () => {
  const w = world();
  await runDeclareIntelligenceSubscriptions({ organizationSlug: ORG.slug, apply: true }, w.deps);
  assert.equal(w.fake.stateChangeSubscription.__rows.length, INTELLIGENCE_SUBSCRIPTIONS.length);
  w.fake.stateChangeSubscription.__rows[0].status = 'INACTIVE';
  await runDeclareIntelligenceSubscriptions({ organizationSlug: ORG.slug, apply: true }, w.deps);
  assert.equal(w.fake.stateChangeSubscription.__rows.length, INTELLIGENCE_SUBSCRIPTIONS.length, 'nothing twice');
  assert.equal(w.fake.stateChangeSubscription.__rows[0].status, 'INACTIVE', 'a person’s decision to switch one off stands');
  assert.ok(w.fake.stateChangeSubscription.__rows.every((r: any) => r.organizationId === ORG.id));
});

test('every declared subscription names a handler that exists, and an unknown organization writes nothing', async () => {
  for (const def of INTELLIGENCE_SUBSCRIPTIONS) assert.ok(resolveSubscriber(def.endpointOrHandler), def.endpointOrHandler);
  const w = world();
  assert.equal(await runDeclareIntelligenceSubscriptions({ organizationSlug: 'nobody', apply: true }, w.deps), 'FAILED_PRECONDITION');
  assert.equal(await runDeclareIntelligenceSubscriptions({ organizationSlug: 'Bad Slug', apply: true }, w.deps), 'FAILED_PRECONDITION');
  assert.equal(w.fake.stateChangeSubscription.__rows.length, 0);
});

test('the workflow is manual, dry-run by default, and passes only the validated slug on', () => {
  const yml = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'declare-intelligence-subscriptions.yml'), 'utf8');
  for (const trigger of ['schedule:', 'push:', 'pull_request:', 'workflow_call:']) assert.equal(yml.includes(trigger), false, trigger);
  assert.match(yml, /apply:[\s\S]*?default: false/);
  assert.match(yml, /ORG_SLUG: \$\{\{ steps\.input\.outputs\.slug \}\}/);
});
