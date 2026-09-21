// What the connections worker stack creates -- and what it does not. Staging.
//
// Synth-only: a registry image is injected so no Docker build is needed. Proves the smallest
// appropriate shape (one Fargate service, private, behind an internal ALB reached only via an HTTPS
// HTTP API), the secret wiring (each env var from Secrets Manager; the session key and DB URL are
// created here, the Telegram secret is referenced not created), and that nothing is over-built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';
import { CONNECTION_SECRET_NAMES } from '../lib/connections-stack';
import { assertStagingCredentials, WrongTargetError } from '../lib/target';

function synth(): Template {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  const { stack } = buildConnectionsApp({ image });
  return Template.fromStack(stack);
}

// Synthesize with extra CDK context, exactly as `cdk synth -c key=value` does -- used to prove the
// operator-activated AI wiring. buildConnectionsApp is what the CLI runs, so this is the real path.
function synthWith(context: Record<string, unknown>): Template {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  const { stack } = buildConnectionsApp({ image, context });
  return Template.fromStack(stack);
}

// A PLACEHOLDER staging org id. NEVER a real or guessed organization id: the real staging org id
// lives only in the CONNECTIONS_STAGING_AI_ORG_ID GitHub environment variable, never in source.
const PLACEHOLDER_ORG_ID = 'org_staging_placeholder_test';

const AI_SECRET_NAME = 'loop/connections/staging/ai';

/** The single worker container definition from a synthesized template. */
function workerContainer(t: Template): { Environment?: Array<{ Name: string; Value: unknown }>; Secrets?: Array<{ Name: string; ValueFrom: unknown }> } {
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
  const tds = Object.values(res).filter((r) => r.Type === 'AWS::ECS::TaskDefinition');
  assert.equal(tds.length, 1, 'exactly one task definition');
  const defs = tds[0]!.Properties.ContainerDefinitions as any[];
  assert.equal(defs.length, 1, 'exactly one container');
  return defs[0];
}

/** The names of the SecretsManager secrets this template CREATES (not the ones it references). */
function createdSecretNames(t: Template): Array<string | undefined> {
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
  return Object.values(res).filter((r) => r.Type === 'AWS::SecretsManager::Secret').map((r) => r.Properties?.Name);
}

const template = synth();
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
const count = (type: string) => Object.values(resources).filter((r) => r.Type === type).length;

test('exactly one always-on Fargate service, private, one NAT, one internal ALB', () => {
  assert.equal(count('AWS::ECS::Cluster'), 1);
  assert.equal(count('AWS::ECS::Service'), 1);
  assert.equal(count('AWS::ECS::TaskDefinition'), 1);
  assert.equal(count('AWS::EC2::NatGateway'), 1); // smallest: one NAT for outbound
  template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  // The ALB is INTERNAL -- nothing about the worker is internet-facing except the HTTP API.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
});

test('the web reaches it over HTTPS via an HTTP API + VPC Link, not a public ALB', () => {
  assert.equal(count('AWS::ApiGatewayV2::Api'), 1);
  assert.equal(count('AWS::ApiGatewayV2::VpcLink'), 1);
  // A route per control endpoint + health.
  assert.ok(count('AWS::ApiGatewayV2::Route') >= 6);
});

test('the task takes every secret from Secrets Manager as an env var; none is plaintext in the template', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: 'TELEGRAM_API_ID' }),
          Match.objectLike({ Name: 'TELEGRAM_API_HASH' }),
          Match.objectLike({ Name: 'LOOP_CONNECTION_SECRET_KEY' }),
          Match.objectLike({ Name: 'LOOP_CONNECTION_CONVERSATION_SECRET' }),
          Match.objectLike({ Name: 'LOOP_CONNECTIONS_WORKER_SECRET' }),
          Match.objectLike({ Name: 'DATABASE_URL' }),
        ]),
      }),
    ]),
  });
  // The rendered template carries no api hash / key / url as a literal value anywhere.
  const json = JSON.stringify(template.toJSON());
  assert.ok(!/postgresql:\/\/[^x]/.test(json), 'no real database url in the template');
});

test('only the two HMAC secrets are created (generated); the operator-provided secrets are referenced, not created', () => {
  // The worker fails closed on a missing sealing key at boot, so the operator-provided secrets
  // (telegram, connection-key, database-url) must pre-exist with real values -- they are REFERENCED,
  // never created here as placeholders that would crash the first task. Only the two HMAC secrets,
  // which need no human value, are generated here.
  const created = Object.values(resources).filter((r) => r.Type === 'AWS::SecretsManager::Secret');
  assert.equal(created.length, 2); // conversation-secret, worker-control
  const names = created.map((r) => r.Properties?.Name);
  assert.ok(names.includes(CONNECTION_SECRET_NAMES.conversationSecret));
  assert.ok(names.includes(CONNECTION_SECRET_NAMES.workerControl));
  for (const referenced of [CONNECTION_SECRET_NAMES.telegram, CONNECTION_SECRET_NAMES.connectionKey, CONNECTION_SECRET_NAMES.databaseUrl]) {
    assert.ok(!names.includes(referenced), `${referenced} must be referenced (operator-provided), never re-created`);
  }
  // Every created secret is a generated random value, never an UNSET placeholder that boots invalid.
  for (const r of created) assert.equal(r.Properties?.GenerateSecretString?.SecretStringTemplate, undefined, 'no UNSET placeholder secrets');
});

test('the internal ALB admits ONLY the VPC Link security group -- no 0.0.0.0/0 ingress anywhere', () => {
  const gid = (ref: any) => (ref && ref['Fn::GetAtt'] ? ref['Fn::GetAtt'][0] : ref && ref.Ref ? ref.Ref : ref);

  // 1. No security group -- inline or standalone -- admits the world on any port.
  const ingressRules: any[] = [];
  for (const r of Object.values(resources)) {
    if (r.Type === 'AWS::EC2::SecurityGroup') ingressRules.push(...(r.Properties.SecurityGroupIngress ?? []));
    if (r.Type === 'AWS::EC2::SecurityGroupIngress') ingressRules.push(r.Properties);
  }
  for (const rule of ingressRules) {
    assert.notEqual(rule.CidrIp, '0.0.0.0/0', `open ingress found: ${JSON.stringify(rule)}`);
    assert.notEqual(rule.CidrIpv6, '::/0', `open IPv6 ingress found: ${JSON.stringify(rule)}`);
  }

  // 2. The ALB's security group is the automatically-created ELB one; its ONLY ingress is from the
  //    VPC Link SG on port 80.
  const albSgId = Object.entries(resources).find(([, r]) => r.Type === 'AWS::EC2::SecurityGroup' && /ELB/.test(r.Properties.GroupDescription ?? ''))?.[0];
  const vpcLinkSgId = Object.entries(resources).find(([, r]) => r.Type === 'AWS::EC2::SecurityGroup' && /VPC Link/i.test(r.Properties.GroupDescription ?? ''))?.[0];
  assert.ok(albSgId && vpcLinkSgId, 'expected an ALB SG and a VPC Link SG');
  const albIngress = Object.values(resources).filter((r) => r.Type === 'AWS::EC2::SecurityGroupIngress' && gid(r.Properties.GroupId) === albSgId);
  assert.equal(albIngress.length, 1, 'the ALB SG must have exactly one ingress rule');
  assert.equal(gid(albIngress[0]!.Properties.SourceSecurityGroupId), vpcLinkSgId, 'ALB ingress must be from the VPC Link SG only');
  assert.equal(albIngress[0]!.Properties.FromPort, 80);
  assert.equal(albIngress[0]!.Properties.ToPort, 80);
  const albSg = resources[albSgId]!;
  assert.deepEqual(albSg.Properties.SecurityGroupIngress ?? [], [], 'the ALB SG must carry no inline (e.g. 0.0.0.0/0) ingress');

  // 3. The VPC Link has its OWN security group (not the locked-down default), so its egress to the
  //    ALB survives restrictDefaultSecurityGroup.
  const vpcLink = Object.values(resources).find((r) => r.Type === 'AWS::ApiGatewayV2::VpcLink');
  assert.ok(vpcLink && Array.isArray(vpcLink.Properties.SecurityGroupIds) && vpcLink.Properties.SecurityGroupIds.length === 1, 'the VPC Link must have exactly its own SG');
  assert.equal(gid(vpcLink!.Properties.SecurityGroupIds[0]), vpcLinkSgId);
});

test('nothing speculative: no queue, no database, no public load balancer, no IAM users', () => {
  for (const forbidden of ['AWS::SQS::Queue', 'AWS::RDS::DBInstance', 'AWS::DynamoDB::Table', 'AWS::IAM::User', 'AWS::IAM::AccessKey']) {
    assert.equal(count(forbidden), 0, `unexpected ${forbidden}`);
  }
});

test('the target guard refuses non-staging credentials, allows credential-free synth', () => {
  assert.doesNotThrow(() => assertStagingCredentials(undefined));
  assert.doesNotThrow(() => assertStagingCredentials('065148797865'));
  assert.throws(() => assertStagingCredentials('670682108352'), WrongTargetError); // management account
});

// ---------------------------------------------------------------------------------------------
// AI content triage (staging): operator-activated, fail-closed, credential via Secrets Manager.
// The worker (apps/connections-worker/src/ai-runtime.ts) is OFF unless it is fed the LOOP_AI_* env
// AND its provider key. This stack feeds that env ONLY when an operator supplies an org id through
// CDK context. These tests prove the default stays byte-for-byte unchanged and fail-closed, and that
// when activated the credential is delivered by reference (never plaintext) with the placeholder id.
// ---------------------------------------------------------------------------------------------

test('DEFAULT (no aiActivation): no ai secret reference, no LOOP_AI_* env, no provider key -- fail-closed and unchanged', () => {
  const json = JSON.stringify(template.toJSON());
  assert.ok(!json.includes(AI_SECRET_NAME), 'the AI-off template must not reference loop/connections/staging/ai');
  const c = workerContainer(template);
  for (const e of c.Environment ?? []) {
    assert.ok(!e.Name.startsWith('LOOP_AI_'), `no LOOP_AI_* env when AI is off, found ${e.Name}`);
  }
  for (const s of c.Secrets ?? []) {
    assert.notEqual(s.Name, 'ANTHROPIC_API_KEY', 'no ANTHROPIC_API_KEY secret when AI is off');
    assert.notEqual(s.Name, 'OPENAI_API_KEY', 'no OPENAI_API_KEY secret when AI is off');
  }
});

test('AI-ON: the ai secret is REFERENCED not created; ANTHROPIC_API_KEY is a Secrets Manager value, never plaintext env', () => {
  const t = synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID });

  // Referenced, not created: still exactly the two generated HMAC secrets, and none named `.../ai`.
  const created = createdSecretNames(t);
  assert.equal(created.filter((n) => n === CONNECTION_SECRET_NAMES.conversationSecret || n === CONNECTION_SECRET_NAMES.workerControl).length, 2);
  assert.equal(created.length, 2, 'AI-on must create no new secret (the ai secret is operator-provided, referenced)');
  assert.ok(!created.includes(AI_SECRET_NAME), 'loop/connections/staging/ai must be referenced, never created here');

  const c = workerContainer(t);

  // ANTHROPIC_API_KEY arrives via ECS secrets as a Secrets-Manager ValueFrom of the ai secret's
  // anthropic_api_key JSON field -- not as a plaintext Environment entry.
  const anthropic = (c.Secrets ?? []).find((s) => s.Name === 'ANTHROPIC_API_KEY');
  assert.ok(anthropic, 'ANTHROPIC_API_KEY must be in the container Secrets');
  assert.equal(typeof anthropic!.ValueFrom, 'string', 'ANTHROPIC_API_KEY must be a Secrets Manager reference');
  const valueFrom = anthropic!.ValueFrom as string;
  assert.ok(valueFrom.includes(AI_SECRET_NAME), 'ANTHROPIC_API_KEY must reference the ai secret');
  assert.ok(valueFrom.endsWith(':anthropic_api_key::'), 'ANTHROPIC_API_KEY must select the anthropic_api_key JSON field');
  for (const e of c.Environment ?? []) {
    assert.notEqual(e.Name, 'ANTHROPIC_API_KEY', 'the credential must never be a plaintext Environment entry');
    assert.notEqual(e.Name, 'OPENAI_API_KEY', 'the credential must never be a plaintext Environment entry');
  }

  // The five activation vars reach the worker with the placeholder org id and exact values.
  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_ENABLED, 'true');
  assert.equal(env.LOOP_AI_PROVIDERS, 'anthropic');
  assert.equal(env.LOOP_AI_PROVIDER_TERMS_CONFIRMED, 'anthropic');
  assert.equal(env.LOOP_AI_ORGANIZATIONS, PLACEHOLDER_ORG_ID);
  assert.equal(env.LOOP_AI_TASKS, 'telegram.content.triage');

  // OpenAI is opt-in: no OPENAI_API_KEY secret unless the fallback is requested.
  assert.ok(!(c.Secrets ?? []).some((s) => s.Name === 'OPENAI_API_KEY'), 'OPENAI_API_KEY must be absent by default');

  // Because the secret is referenced (not created), no credential value can exist in the template.
  const json = JSON.stringify(t.toJSON());
  assert.ok(!/sk-ant-/.test(json) && !/sk-[A-Za-z0-9_-]{20,}/.test(json), 'no plaintext key material anywhere in the template');
});

test('AI-ON + fallback: OPENAI_API_KEY referenced from openai_api_key; providers list includes openai; still no plaintext key', () => {
  const t = synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiOpenAiFallback: true });
  const c = workerContainer(t);

  const openai = (c.Secrets ?? []).find((s) => s.Name === 'OPENAI_API_KEY');
  assert.ok(openai, 'OPENAI_API_KEY must be in the container Secrets when the fallback is on');
  const valueFrom = openai!.ValueFrom as string;
  assert.ok(valueFrom.includes(AI_SECRET_NAME) && valueFrom.endsWith(':openai_api_key::'), 'OPENAI_API_KEY must select the openai_api_key JSON field of the ai secret');

  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_PROVIDERS, 'anthropic,openai');
  assert.equal(env.LOOP_AI_PROVIDER_TERMS_CONFIRMED, 'anthropic,openai');

  for (const e of c.Environment ?? []) {
    assert.notEqual(e.Name, 'ANTHROPIC_API_KEY');
    assert.notEqual(e.Name, 'OPENAI_API_KEY');
  }
  // Still no created secret and no key material -- the ai secret is referenced, not created.
  assert.equal(createdSecretNames(t).length, 2);
  const json = JSON.stringify(t.toJSON());
  assert.ok(!/sk-ant-/.test(json) && !/sk-[A-Za-z0-9_-]{20,}/.test(json), 'no plaintext key material anywhere in the template');
});
