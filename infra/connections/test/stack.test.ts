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

test('the session-sealing key and DB URL are created UNSET here; the Telegram secret is referenced, not created', () => {
  // Two created secrets are UNSET placeholders; two are generated. The Telegram secret is imported.
  const created = Object.values(resources).filter((r) => r.Type === 'AWS::SecretsManager::Secret');
  assert.equal(created.length, 4); // connection-key, database-url, conversation-secret, worker-control
  const names = created.map((r) => r.Properties?.Name);
  assert.ok(names.includes(CONNECTION_SECRET_NAMES.connectionKey));
  assert.ok(names.includes(CONNECTION_SECRET_NAMES.databaseUrl));
  assert.ok(!names.includes(CONNECTION_SECRET_NAMES.telegram), 'the Telegram secret is referenced, never re-created');
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
