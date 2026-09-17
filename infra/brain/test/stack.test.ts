// What the Brain stack creates -- and, as importantly, what it does not. Slice B6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { buildBrainApp } from '../lib/app';
import { BRAIN_PARAMETER_DEFAULTS } from '../lib/brain-stack';
import { BRAIN_FUNCTIONS } from '../scripts/bundle';

function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-assets-'));
  for (const f of BRAIN_FUNCTIONS) {
    mkdirSync(join(dir, f.name));
    writeFileSync(join(dir, f.name, 'index.js'), 'exports.handler = async () => ({});');
  }
  return dir;
}

// The same app the CLI builds: cdk.json's context (stage and feature flags) and the pinned
// target. Extra context is what an operator would pass with --context.
function synth(context: Record<string, unknown> = {}): Template {
  const { stack } = buildBrainApp({ assetsDir: stubAssets(), context });
  return Template.fromStack(stack);
}

const template = synth();
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);

test('exactly the dark foundation, and nothing speculative', () => {
  const counts: Record<string, number> = {};
  for (const r of Object.values(resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
  assert.equal(counts['AWS::Lambda::Function'], 5);
  assert.equal(counts['AWS::SQS::Queue'], 4);
  assert.equal(counts['AWS::DynamoDB::Table'], 1);
  assert.equal(counts['AWS::KMS::Key'], 2);
  assert.equal(counts['AWS::SecretsManager::Secret'], 6);
  assert.equal(counts['AWS::SSM::Parameter'], Object.keys(BRAIN_PARAMETER_DEFAULTS).length);
  assert.equal(counts['AWS::ApiGatewayV2::Api'], 1);
  assert.equal(counts['AWS::ApiGatewayV2::Route'], 1);
  assert.equal(counts['AWS::ApiGatewayV2::Authorizer'], 1);
  assert.equal(counts['AWS::Scheduler::Schedule'], 1);
  assert.equal(counts['AWS::Lambda::EventSourceMapping'], 2);
  assert.equal(counts['AWS::CloudWatch::Alarm'], 10);
  assert.equal(counts['AWS::Budgets::Budget'], undefined, 'no budget without a notification address');
  for (const forbidden of [/^AWS::EC2::/, /^AWS::StepFunctions::/, /^AWS::RDS::/, /^AWS::ECS::/, /^AWS::IAM::User$/, /^AWS::IAM::AccessKey$/, /^AWS::Lambda::Url$/, /^AWS::ElastiCache::/]) {
    assert.ok(!Object.keys(counts).some((t) => forbidden.test(t)), `no ${forbidden}`);
  }
});

test('functions run a supported Node runtime with bounded concurrency', () => {
  const byName = Object.fromEntries(ofType('AWS::Lambda::Function').map(([, r]) => [r.Properties.FunctionName, r.Properties]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'loop-brain-staging-authorizer',
    'loop-brain-staging-dispatcher',
    'loop-brain-staging-sweeper',
    'loop-brain-staging-worker-durable',
    'loop-brain-staging-worker-interactive',
  ]);
  for (const p of Object.values(byName) as any[]) {
    assert.equal(p.Runtime, 'nodejs24.x');
    assert.deepEqual(p.Architectures, ['x86_64'], 'matches the rhel-openssl-3.0.x engine already in schema.prisma');
    assert.equal(p.Environment.Variables.BRAIN_STAGE, 'staging');
    assert.ok(!JSON.stringify(p.Environment.Variables).match(/anthropic|openai/i), 'no provider name in any environment');
  }
  const reserved = Object.fromEntries(Object.entries(byName).map(([n, p]: [string, any]) => [n.replace('loop-brain-staging-', ''), [p.ReservedConcurrentExecutions, p.Timeout, p.MemorySize]]));
  assert.deepEqual(reserved, {
    authorizer: [5, 5, 256],
    dispatcher: [5, 15, 256],
    'worker-interactive': [5, 120, 1024],
    'worker-durable': [2, 120, 1024],
    sweeper: [1, 60, 256],
  });
});

test('queues retry five times into a dead-letter queue, with visibility six times the worker timeout', () => {
  template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'loop-brain-staging-interactive-queue', VisibilityTimeout: 720, RedrivePolicy: { maxReceiveCount: 5 }, SqsManagedSseEnabled: true });
  template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'loop-brain-staging-durable-queue', VisibilityTimeout: 720, RedrivePolicy: { maxReceiveCount: 5 } });
  template.resourceCountIs('AWS::SQS::QueuePolicy', 4); // enforceSSL on every queue
  const mappings = ofType('AWS::Lambda::EventSourceMapping').map(([, r]) => r.Properties);
  for (const m of mappings) {
    assert.equal(m.BatchSize, 1);
    assert.deepEqual(m.FunctionResponseTypes, ['ReportBatchItemFailures']);
  }
  assert.deepEqual(mappings.map((m) => m.ScalingConfig.MaximumConcurrency).sort(), [2, 5]);
});

test('the doorbell is one POST route behind an uncached, simple-response authorizer, and throttled', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /v1/doorbell', AuthorizationType: 'CUSTOM' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'REQUEST',
    AuthorizerPayloadFormatVersion: '2.0',
    EnableSimpleResponses: true,
    AuthorizerResultTtlInSeconds: 0,
    IdentitySource: ['$request.header.Authorization'],
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 } });
});

test('keys, secrets and log groups are kept once created; a rolled-back first creation leaves nothing behind', () => {
  const policies: Record<string, string[]> = {};
  for (const r of Object.values(resources) as any[]) {
    if (r.DeletionPolicy === undefined && r.UpdateReplacePolicy === undefined) continue;
    (policies[`${r.Type} ${r.DeletionPolicy}/${r.UpdateReplacePolicy}`] ??= []).push(r.Type);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(policies).map(([k, v]) => [k, v.length])), {
    'AWS::KMS::Key RetainExceptOnCreate/Retain': 2,
    'AWS::SecretsManager::Secret RetainExceptOnCreate/Retain': 6,
    'AWS::Logs::LogGroup RetainExceptOnCreate/Retain': 5,
    'AWS::DynamoDB::Table Delete/Delete': 1,
    'AWS::SQS::Queue Delete/Delete': 4,
  });
  assert.ok(!Object.values(resources).some((r: any) => r.DeletionPolicy === 'Retain'), 'plain Retain would strand fixed names after a failed first deployment');
});

test('keys, secrets and parameters: generated or placeholder values only, encrypted', () => {
  template.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' });
  template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true, KeySpec: Match.absent() });
  const secretsByName = Object.fromEntries(ofType('AWS::SecretsManager::Secret').map(([, r]) => [r.Properties.Name, r]));
  assert.deepEqual(Object.keys(secretsByName).sort(), [
    'loop/brain/staging/anthropic',
    'loop/brain/staging/checkpoint-key',
    'loop/brain/staging/neon-dispatcher',
    'loop/brain/staging/neon-sweeper',
    'loop/brain/staging/neon-worker',
    'loop/brain/staging/openai',
  ]);
  for (const r of Object.values(secretsByName) as any[]) {
    assert.equal(r.Properties.SecretString, undefined, 'no secret value is in the template');
    assert.ok(r.Properties.GenerateSecretString);
    assert.ok(r.Properties.KmsKeyId);
  }
  const params = Object.fromEntries(ofType('AWS::SSM::Parameter').map(([, r]) => [r.Properties.Name, r.Properties.Value]));
  assert.equal(params['/loop/brain/staging/worker/enabled'], 'false', 'the worker starts switched off');
  assert.deepEqual(JSON.parse(params['/loop/brain/staging/ai/floor']), { enabled: false, organizations: [], tasks: [], providers: [], killSwitches: [] });
  assert.equal(params['/loop/brain/staging/loop/internal-base-url'], 'UNSET');
  assert.equal(params['/loop/brain/staging/doorbell/public-keys'], '{}', 'no key is trusted until one is pinned');
  for (const [, r] of ofType('AWS::Logs::LogGroup')) {
    assert.equal(r.Properties.RetentionInDays, 30);
    assert.ok(r.Properties.KmsKeyId);
  }
});

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };

function roleStatements(roleLogicalPrefix: string): Statement[] {
  const roleIds = Object.entries(resources)
    .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith(roleLogicalPrefix))
    .map(([id]) => id);
  assert.equal(roleIds.length, 1, roleLogicalPrefix);
  return ofType('AWS::IAM::Policy')
    .filter(([, r]) => (r.Properties.Roles as { Ref: string }[]).some((ref) => ref.Ref === roleIds[0]))
    .flatMap(([, r]) => r.Properties.PolicyDocument.Statement as Statement[]);
}

const actionsOf = (statements: Statement[]) => [...new Set(statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])))].sort();

test('least privilege: no wildcard actions or resources, and each role holds only its own grants', () => {
  for (const [id, r] of ofType('AWS::IAM::Policy')) {
    for (const s of r.Properties.PolicyDocument.Statement as Statement[]) {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      assert.ok(!actions.some((a) => a === '*' || a.endsWith(':*')), `${id}: wildcard action ${actions}`);
      const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      assert.ok(!res.some((x) => x === '*'), `${id}: wildcard resource for ${actions}`);
    }
  }
  assert.equal(ofType('AWS::IAM::Role').filter(([, r]) => r.Properties.ManagedPolicyArns).length, 0, 'no managed policies');

  const logs = ['logs:CreateLogStream', 'logs:PutLogEvents'];
  const readParams = ['ssm:DescribeParameters', 'ssm:GetParameter', 'ssm:GetParameterHistory', 'ssm:GetParameters'];
  const readSecret = ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'];
  const send = ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage'];
  const consume = ['sqs:ChangeMessageVisibility', 'sqs:DeleteMessage', 'sqs:ReceiveMessage'];
  const exactly = (...groups: string[][]) => [...new Set(groups.flat())].sort();
  assert.deepEqual(actionsOf(roleStatements('authorizerrole')), exactly(['dynamodb:PutItem'], logs, readParams));
  assert.deepEqual(actionsOf(roleStatements('dispatcherrole')), exactly(logs, readParams, readSecret, send));
  assert.deepEqual(actionsOf(roleStatements('workerinteractiverole')), exactly(['kms:Sign'], logs, readParams, readSecret, send, consume));
  assert.deepEqual(actionsOf(roleStatements('workerdurablerole')), exactly(['kms:Sign'], logs, readParams, readSecret, send, consume));
  assert.deepEqual(actionsOf(roleStatements('sweeperrole')), exactly(['lambda:InvokeFunction'], logs, readSecret, send));
  const worker = roleStatements('workerinteractiverole');
  const sign = worker.filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('kms:Sign'));
  assert.equal(sign.length, 1);
  assert.equal(JSON.stringify(sign[0]!.Resource).includes('WorkerSigningKey'), true, 'sign with the worker key only');
  for (const prefix of ['authorizerrole', 'dispatcherrole', 'sweeperrole']) {
    assert.ok(!actionsOf(roleStatements(prefix)).includes('kms:Sign'), `${prefix} cannot sign`);
  }
  assert.ok(!actionsOf(roleStatements('authorizerrole')).some((a) => a.startsWith('secretsmanager:') || a.startsWith('sqs:')), 'the authorizer has no data access');
  // Secrets are encrypted with the data key; roles may decrypt only through Secrets Manager.
  const dataKey = ofType('AWS::KMS::Key').find(([, r]) => !r.Properties.KeySpec)![1];
  // The recommended flags merge these into one statement; what matters is who, and how.
  const decrypts = (dataKey.Properties.KeyPolicy.Statement as any[]).filter((st) => JSON.stringify(st.Action).includes('kms:Decrypt') && JSON.stringify(st.Principal).includes('role'));
  const decryptingRoles = decrypts.flatMap((st) => [st.Principal.AWS].flat().map((p: any) => String(p['Fn::GetAtt']?.[0]).replace(/[0-9A-F]{8}$/, ''))).sort();
  assert.deepEqual(decryptingRoles, ['dispatcherrole', 'sweeperrole', 'workerdurablerole', 'workerinteractiverole'], 'the authorizer cannot decrypt');
  for (const st of decrypts) assert.deepEqual(st.Condition, { StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' } }, 'decrypt only via Secrets Manager');
});

test('no role can read a provider secret in B6, and each role reads only its own database secret', () => {
  const policies = JSON.stringify(ofType('AWS::IAM::Policy').map(([, r]) => r.Properties.PolicyDocument));
  assert.doesNotMatch(policies, /AnthropicSecret|OpenAiSecret/);
  const grants = (prefix: string) => JSON.stringify(roleStatements(prefix).filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('secretsmanager:GetSecretValue')));
  assert.match(grants('workerinteractiverole'), /WorkerDatabaseSecret/);
  assert.match(grants('workerinteractiverole'), /CheckpointSecret/);
  assert.doesNotMatch(grants('workerinteractiverole'), /DispatcherDatabaseSecret|SweeperDatabaseSecret/);
  assert.match(grants('dispatcherrole'), /DispatcherDatabaseSecret/);
  assert.doesNotMatch(grants('dispatcherrole'), /WorkerDatabaseSecret|CheckpointSecret/);
  assert.match(grants('sweeperrole'), /SweeperDatabaseSecret/);
  assert.doesNotMatch(grants('sweeperrole'), /WorkerDatabaseSecret|CheckpointSecret/);
});

test('the budget and alarm notifications appear only when an address is given', () => {
  const withEmail = synth({ budgetEmail: 'ops@example.test', alarmEmail: 'ops@example.test', monthlyBudgetUsd: '30' });
  withEmail.hasResourceProperties('AWS::Budgets::Budget', { Budget: { BudgetLimit: { Amount: 30, Unit: 'USD' }, TimeUnit: 'MONTHLY' } });
  withEmail.resourceCountIs('AWS::SNS::Subscription', 1);
  template.resourceCountIs('AWS::SNS::Subscription', 0);
});
