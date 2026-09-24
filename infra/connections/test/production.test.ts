// The PRODUCTION stage: the same stack shape as staging, in a dedicated account that does not
// exist yet, with the guards that keep it from landing anywhere else.
//
// Synth-only, with a DUMMY 12-digit account (the real id is not in source) and a dummy address.
// Proves: the target resolves only from valid context and refuses the management and staging
// accounts; the stack, its secrets and its descriptions are named for production; the media bucket
// answers the production web origin; the budget (150 USD) and the worker-down alarm are REQUIRED
// (no alertEmail -> no production stack); every resource is tagged; and, protection aside, the
// production template has exactly staging's resource types -- one architecture, two stages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Template, Match } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp, DEFAULT_MEDIA_ORIGINS, DEFAULT_MONTHLY_BUDGET_USD, protectionFromContext } from '../lib/app';
import { connectionSecretNames } from '../lib/connections-stack';
import { assertTargetCredentials, CONNECTIONS_STAGING_TARGET, MANAGEMENT_ACCOUNT, productionTarget, targetFor, WrongTargetError } from '../lib/target';
import { stubAssets } from './assets';

const ACCOUNT = '123456789012'; // dummy
const EMAIL = 'alerts@example.invalid'; // dummy
const PRODUCTION_CONTEXT = { stage: 'production', productionAccount: ACCOUNT, alertEmail: EMAIL };

function build(context: Record<string, unknown>, credentialAccount?: string) {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  return buildConnectionsApp({ image, assetsDir: stubAssets(), context, ...(credentialAccount === undefined ? {} : { credentialAccount }) });
}

type Resource = { Type: string; Properties?: any };
const resourcesOf = (t: Template) => t.toJSON().Resources as Record<string, Resource>;
const typesOf = (t: Template) => Object.values(resourcesOf(t)).map((r) => r.Type).sort();

const { stack } = build(PRODUCTION_CONTEXT);
const template = Template.fromStack(stack);
const resources = resourcesOf(template);
const stagingTemplate = Template.fromStack(build({}).stack);

/** Whether a resource's Tags (list or map form) carry loop:stage=<stage>. */
function hasStageTag(tags: unknown, stage: string): boolean {
  if (Array.isArray(tags)) return tags.some((t) => t && t.Key === 'loop:stage' && t.Value === stage);
  if (tags && typeof tags === 'object') return (tags as Record<string, unknown>)['loop:stage'] === stage;
  return false;
}

// ---------------------------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------------------------

test('the production target: the given account, us-east-1, LoopConnections-production, the same bootstrap qualifier; staging untouched', () => {
  assert.deepEqual({ ...productionTarget(ACCOUNT) }, {
    accountName: 'Loop Production',
    account: ACCOUNT,
    region: 'us-east-1',
    stackName: 'LoopConnections-production',
    stage: 'production',
    bootstrapQualifier: CONNECTIONS_STAGING_TARGET.bootstrapQualifier,
  });
  assert.equal(targetFor('staging', {}), CONNECTIONS_STAGING_TARGET);
  assert.equal(targetFor('staging', { productionAccount: ACCOUNT }), CONNECTIONS_STAGING_TARGET, 'staging ignores productionAccount');
  assert.deepEqual(targetFor('production', { productionAccount: ACCOUNT }), productionTarget(ACCOUNT));
});

test('the production target is refused without a valid 12-digit account, and for the management and staging accounts', () => {
  for (const bad of [undefined, null, '', ' ', '12345678901', '1234567890123', '12345678901a', 123456789012, ' 123456789012']) {
    assert.throws(() => productionTarget(bad), /production requires CDK context productionAccount/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.throws(() => productionTarget(MANAGEMENT_ACCOUNT), WrongTargetError);
  assert.throws(() => productionTarget(MANAGEMENT_ACCOUNT), /management account/);
  assert.equal(MANAGEMENT_ACCOUNT, '670682108352');
  assert.throws(() => productionTarget(CONNECTIONS_STAGING_TARGET.account), WrongTargetError);
  assert.throws(() => productionTarget('065148797865'), /Loop Brain Staging/);
  assert.throws(() => targetFor('production', {}), /productionAccount/);
  for (const stage of [undefined, '', 'prod', 'Production', 'development']) {
    assert.throws(() => targetFor(stage, { productionAccount: ACCOUNT }), /unknown stage/);
  }
});

test('the credential guard: no credentials synthesize; production credentials build; any other account is refused', () => {
  const target = productionTarget(ACCOUNT);
  assert.doesNotThrow(() => assertTargetCredentials(target, undefined));
  assert.doesNotThrow(() => assertTargetCredentials(target, ''));
  assert.doesNotThrow(() => assertTargetCredentials(target, ACCOUNT));
  assert.throws(() => assertTargetCredentials(target, CONNECTIONS_STAGING_TARGET.account), WrongTargetError);
  assert.throws(() => assertTargetCredentials(target, MANAGEMENT_ACCOUNT), WrongTargetError);
  // Through the app, exactly the same.
  assert.doesNotThrow(() => build(PRODUCTION_CONTEXT, ACCOUNT));
  assert.throws(() => build(PRODUCTION_CONTEXT, CONNECTIONS_STAGING_TARGET.account), WrongTargetError);
  assert.throws(() => build(PRODUCTION_CONTEXT, MANAGEMENT_ACCOUNT), WrongTargetError);
  assert.throws(() => build({ ...PRODUCTION_CONTEXT, productionAccount: MANAGEMENT_ACCOUNT }, MANAGEMENT_ACCOUNT), WrongTargetError, 'matching management credentials do not make it a target');
  // Staging credentials cannot build production even when the context names staging's account.
  assert.throws(() => build({ ...PRODUCTION_CONTEXT, productionAccount: CONNECTIONS_STAGING_TARGET.account }, CONNECTIONS_STAGING_TARGET.account), WrongTargetError);
});

// ---------------------------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------------------------

test('the stack lands in the production account under its own name, protected, described as production', () => {
  assert.equal(stack.stackName, 'LoopConnections-production');
  assert.equal(stack.account, ACCOUNT);
  assert.equal(stack.region, 'us-east-1');
  assert.equal(stack.terminationProtection, true);
  assert.equal(stack.templateOptions.description, 'Loop connections worker (production): Teams/Telegram durable observation worker');
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', { Description: 'Loop connections worker control API (production).' });
  assert.ok(!/\(staging\)/.test(JSON.stringify(template.toJSON())), 'no "(staging)" description survives');
});

test('secrets are named loop/connections/production/*: the two HMAC secrets created, the operator-provided ones referenced; no staging name anywhere', () => {
  const names = connectionSecretNames('production');
  assert.deepEqual({ ...names }, {
    telegram: 'loop/connections/production/telegram',
    connectionKey: 'loop/connections/production/connection-key',
    conversationSecret: 'loop/connections/production/conversation-secret',
    workerControl: 'loop/connections/production/worker-control',
    databaseUrl: 'loop/connections/production/database-url',
    ai: 'loop/connections/production/ai',
  });
  const created = Object.values(resources).filter((r) => r.Type === 'AWS::SecretsManager::Secret').map((r) => r.Properties?.Name);
  assert.deepEqual(created.sort(), [names.conversationSecret, names.workerControl].sort());
  const json = JSON.stringify(template.toJSON());
  for (const referenced of [names.telegram, names.connectionKey, names.databaseUrl]) assert.ok(json.includes(referenced), `${referenced} is referenced`);
  assert.ok(!json.includes(names.ai), 'AI off by default: the ai secret is not referenced');
  assert.ok(!json.includes('loop/connections/staging'), 'no staging secret name in the production template');
  // AI on: the production ai secret, referenced not created.
  const on = Template.fromStack(build({ ...PRODUCTION_CONTEXT, aiOrganizationId: 'org_production_placeholder_test' }).stack);
  const c = (Object.values(resourcesOf(on)).find((r) => r.Type === 'AWS::ECS::TaskDefinition')!.Properties.ContainerDefinitions as any[])[0];
  const anthropic = (c.Secrets as Array<{ Name: string; ValueFrom: string }>).find((s) => s.Name === 'ANTHROPIC_API_KEY');
  assert.ok(anthropic && anthropic.ValueFrom.includes(names.ai) && anthropic.ValueFrom.endsWith(':anthropic_api_key::'));
  assert.equal(Object.values(resourcesOf(on)).filter((r) => r.Type === 'AWS::SecretsManager::Secret').length, 2);
});

test('the media bucket answers CORS for the production web origin by default; mediaOrigins context still overrides', () => {
  assert.deepEqual([...DEFAULT_MEDIA_ORIGINS.production], ['https://app.emgloop.com']);
  template.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://app.emgloop.com'] })] },
  });
  Template.fromStack(build({ ...PRODUCTION_CONTEXT, mediaOrigins: 'https://a.example' }).stack).hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://a.example'] })] },
  });
});

test('protection is REQUIRED: no alertEmail, no production stack; with it, one topic, a $150 budget at 80%/100%, one worker-down alarm', () => {
  assert.throws(() => build({ stage: 'production', productionAccount: ACCOUNT }), /production requires CDK context alertEmail/);
  assert.throws(() => build({ ...PRODUCTION_CONTEXT, alertEmail: '  ' }), /production requires CDK context alertEmail/);
  assert.throws(() => build({ ...PRODUCTION_CONTEXT, alertEmail: 'nobody' }), /not an email address/);
  assert.throws(() => protectionFromContext('production', undefined, undefined), /alertEmail/);
  assert.equal(protectionFromContext('staging', undefined, undefined), undefined, 'staging may omit it');
  assert.deepEqual(protectionFromContext('production', ` ${EMAIL} `, undefined), { alertEmail: EMAIL, monthlyBudgetUsd: 150 });
  assert.deepEqual(protectionFromContext('staging', EMAIL, ''), { alertEmail: EMAIL, monthlyBudgetUsd: 60 });
  assert.deepEqual(DEFAULT_MONTHLY_BUDGET_USD, { staging: 60, production: 150 });

  Annotations.fromStack(stack).hasNoWarning('/LoopConnections-production', Match.stringLikeRegexp('No alertEmail'));
  template.resourceCountIs('AWS::SNS::Topic', 1);
  template.resourceCountIs('AWS::SNS::Subscription', 1);
  template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: EMAIL });
  template.resourceCountIs('AWS::Budgets::Budget', 1);
  template.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: { BudgetName: 'loop-connections-production-monthly', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 150, Unit: 'USD' }, CostFilters: Match.absent() },
    NotificationsWithSubscribers: [80, 100].map((threshold) => ({
      Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: threshold, ThresholdType: 'PERCENTAGE' },
      Subscribers: [{ SubscriptionType: 'EMAIL', Address: EMAIL }],
    })),
  });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  const alarm = Object.values(resources).find((r) => r.Type === 'AWS::CloudWatch::Alarm')!.Properties;
  assert.equal(alarm.AlarmName, 'loop-connections-production-worker-down');
  assert.equal(alarm.Namespace, 'AWS/ApplicationELB');
  assert.equal(alarm.MetricName, 'HealthyHostCount');
  assert.equal(alarm.Statistic, 'Minimum');
  assert.equal(alarm.Period, 60);
  assert.equal(alarm.EvaluationPeriods, 5);
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.ComparisonOperator, 'LessThanThreshold');
  assert.equal(alarm.TreatMissingData, 'breaching');
  // The alarm watches THIS stack's target group and load balancer, and notifies THIS stack's topic.
  const topicId = Object.entries(resources).find(([, r]) => r.Type === 'AWS::SNS::Topic')![0];
  const ref = (x: any) => (x && x.Ref) || (x && x['Fn::GetAtt'] && x['Fn::GetAtt'][0]);
  assert.deepEqual(alarm.AlarmActions.map(ref), [topicId]);
  assert.deepEqual(alarm.OKActions.map(ref), [topicId]);
  const dims = Object.fromEntries((alarm.Dimensions as Array<{ Name: string; Value: any }>).map((d) => [d.Name, d.Value]));
  assert.equal(resources[ref(dims.TargetGroup)]?.Type, 'AWS::ElasticLoadBalancingV2::TargetGroup');
  // The LoadBalancer dimension is the load balancer's full name, which CDK derives from the listener ARN.
  const listenerRefs = [...JSON.stringify(dims.LoadBalancer).matchAll(/"Ref":"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  assert.ok(listenerRefs.length > 0 && listenerRefs.every((id) => resources[id]?.Type === 'AWS::ElasticLoadBalancingV2::Listener'), 'derived from this stack\'s listener');
  // No email or budget number leaks into the worker's environment.
  const c = (Object.values(resources).find((r) => r.Type === 'AWS::ECS::TaskDefinition')!.Properties.ContainerDefinitions as any[])[0];
  assert.ok(!JSON.stringify(c.Environment).includes(EMAIL));
});

test('every resource carries loop:stage=production: per resource where CDK can, and as a stack tag for the rest', () => {
  const tagged = Object.entries(resources).filter(([, r]) => r.Properties?.Tags !== undefined);
  assert.ok(tagged.length >= 12);
  for (const [id, r] of tagged) assert.ok(hasStageTag(r.Properties.Tags, 'production'), `${id} lacks loop:stage=production`);
  // The one role the tag aspect cannot reach is CDK's own custom-resource provider (a raw
  // CfnResource); the stack-level tag below reaches it at deploy time.
  const isCdkProvider = (id: string) => /^CustomVpcRestrictDefaultSG/.test(id);
  for (const type of ['AWS::EC2::VPC', 'AWS::ECS::Cluster', 'AWS::ECS::Service', 'AWS::ECS::TaskDefinition', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::S3::Bucket', 'AWS::SecretsManager::Secret', 'AWS::Logs::LogGroup', 'AWS::IAM::Role', 'AWS::SNS::Topic', 'AWS::CloudWatch::Alarm']) {
    const of = Object.entries(resources).filter(([id, r]) => r.Type === type && !isCdkProvider(id));
    assert.ok(of.length > 0 && of.every(([, r]) => hasStageTag(r.Properties?.Tags, 'production')), `${type} must carry loop:stage`);
  }
  assert.deepEqual(stack.tags.tagValues(), { 'loop:stage': 'production' });
  assert.ok(!JSON.stringify(resources).includes('"loop:stage","Value":"staging"'));
});

test('one architecture: protection aside, production has exactly staging\'s resource types, and the same secret env wiring', () => {
  const protection = ['AWS::SNS::Topic', 'AWS::SNS::Subscription', 'AWS::Budgets::Budget', 'AWS::CloudWatch::Alarm'];
  assert.deepEqual(typesOf(template).filter((t) => !protection.includes(t)), typesOf(stagingTemplate));
  const container = (t: Template) => (Object.values(resourcesOf(t)).find((r) => r.Type === 'AWS::ECS::TaskDefinition')!.Properties.ContainerDefinitions as any[])[0];
  const secretNames = (t: Template) => (container(t).Secrets as Array<{ Name: string }>).map((s) => s.Name).sort();
  assert.deepEqual(secretNames(template), secretNames(stagingTemplate));
  const env = (t: Template) => Object.fromEntries((container(t).Environment as Array<{ Name: string; Value: string }>).map((e) => [e.Name, e.Value]));
  assert.deepEqual(env(template), env(stagingTemplate), 'the worker is configured identically; only the secrets it reads differ by name');
  // Nothing speculative here either.
  for (const forbidden of ['AWS::SQS::Queue', 'AWS::RDS::DBInstance', 'AWS::DynamoDB::Table', 'AWS::IAM::User', 'AWS::IAM::AccessKey', 'AWS::Lambda::Url', 'AWS::CloudFront::Distribution']) {
    assert.equal(typesOf(template).filter((t) => t === forbidden).length, 0, `unexpected ${forbidden}`);
  }
});
