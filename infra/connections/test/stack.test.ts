// What the connections worker stack creates -- and what it does not. The STAGING stage (the
// cdk.json default); test/production.test.ts covers the production stage on the same shape.
//
// Synth-only: a registry image is injected so no Docker build is needed, and the function bundle
// is stubbed. Proves the smallest appropriate shape (one Fargate service, private, behind an
// internal ALB reached only via an HTTPS HTTP API), the secret wiring (each env var from Secrets
// Manager; the two HMAC secrets are generated here, the operator-provided ones are referenced not
// created), the creator-media bucket and signer (private bucket, least-privilege role, one route),
// and that nothing is over-built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Template, Match } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiProvidersFromContext, aiTasksFromContext, buildConnectionsApp, DEFAULT_MEDIA_ORIGINS, intelligenceFromContext, mediaOriginsFromContext } from '../lib/app';
import { connectionSecretNames, MEDIA_KEY_PREFIX, MEDIA_SIGN_PATH } from '../lib/connections-stack';
import { assertTargetCredentials, CONNECTIONS_STAGING_TARGET, WrongTargetError } from '../lib/target';
import { stubAssets } from './assets';

/** The Secrets Manager names the staging stack references or creates. */
const CONNECTION_SECRET_NAMES = connectionSecretNames('staging');

function synth(): Template {
  return Template.fromStack(synthStack().stack);
}

function synthStack(context: Record<string, unknown> = {}) {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  return buildConnectionsApp({ image, assetsDir: stubAssets(), context });
}

// Synthesize with extra CDK context, exactly as `cdk synth -c key=value` does -- used to prove the
// operator-activated AI wiring. buildConnectionsApp is what the CLI runs, so this is the real path.
function synthWith(context: Record<string, unknown>): Template {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  const { stack } = buildConnectionsApp({ image, assetsDir: stubAssets(), context });
  return Template.fromStack(stack);
}

// A PLACEHOLDER staging org id. NEVER a real or guessed organization id: the real staging org id
// lives only in the CONNECTIONS_STAGING_AI_ORG_ID GitHub environment variable, never in source.
const PLACEHOLDER_ORG_ID = 'org_staging_placeholder_test';

const AI_SECRET_NAME = CONNECTION_SECRET_NAMES.ai;
assert.equal(AI_SECRET_NAME, 'loop/connections/staging/ai');

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

test('nothing speculative: no queue, no database, no public load balancer, no IAM users or access keys', () => {
  for (const forbidden of ['AWS::SQS::Queue', 'AWS::RDS::DBInstance', 'AWS::DynamoDB::Table', 'AWS::IAM::User', 'AWS::IAM::AccessKey', 'AWS::Lambda::Url', 'AWS::CloudFront::Distribution']) {
    assert.equal(count(forbidden), 0, `unexpected ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Creator media: a PRIVATE bucket the browser reaches only through presigned URLs, minted by one
// Lambda on the existing control API. The web tier holds no AWS credential, so what the signer's
// role may do IS the security boundary: objects under media/ only, and the worker-control secret.
// ---------------------------------------------------------------------------------------------

/** A CloudFormation reference's logical id, for Ref and Fn::GetAtt alike. */
const logicalId = (ref: any): string | undefined => (ref && ref['Fn::GetAtt'] ? ref['Fn::GetAtt'][0] : ref && ref.Ref ? ref.Ref : undefined);

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);

/** The single media signer function and its role's inline policy statements. */
function mediaSigner(t: Template = template) {
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties?: any }>;
  const fns = Object.entries(res).filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && /^MediaSigner/.test(id));
  assert.equal(fns.length, 1, 'exactly one Lambda function named for the media signer');
  // The only other function is CDK's own provider for restrictDefaultSecurityGroup (pre-existing).
  const others = Object.keys(res).filter((id) => res[id]!.Type === 'AWS::Lambda::Function' && !/^MediaSigner/.test(id));
  assert.deepEqual(others.map((id) => id.replace(/[0-9A-F]{8}$/, '')), ['CustomVpcRestrictDefaultSGCustomResourceProviderHandler'], 'no other function');
  const [fnId, fn] = fns[0]!;
  const roleId = logicalId(fn.Properties.Role);
  assert.ok(roleId && res[roleId]?.Type === 'AWS::IAM::Role', 'the signer has its own role');
  const statements = Object.values(res)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles as any[]).some((ref) => logicalId(ref) === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
  return { fnId, fn: fn.Properties, roleId, role: res[roleId]!.Properties, statements };
}

const bucketId = () => Object.entries(resources).find(([, r]) => r.Type === 'AWS::S3::Bucket')?.[0];
const workerControlId = () => Object.entries(resources).find(([, r]) => r.Type === 'AWS::SecretsManager::Secret' && r.Properties?.Name === CONNECTION_SECRET_NAMES.workerControl)?.[0];

test('media bucket: exactly one, private in every dimension, encrypted, TLS-only, kept, unversioned', () => {
  assert.equal(count('AWS::S3::Bucket'), 1);
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    VersioningConfiguration: Match.absent(),
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } })]) },
  });
  const bucket = resources[bucketId()!] as any;
  assert.equal(bucket.DeletionPolicy, 'Retain', 'media outlives any stack mistake');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.equal(bucket.Properties.BucketName, undefined, 'no fixed bucket name (globally unique names collide on a re-create)');
  // enforceSSL: the bucket policy denies every non-TLS request, for every principal.
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Principal: { AWS: '*' }, Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
  });
});

test('media bucket: CORS admits PUT/GET/HEAD from the staging web origin only, exposing ETag', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: {
      CorsRules: [{ AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedOrigins: [...DEFAULT_MEDIA_ORIGINS.staging], AllowedHeaders: ['*'], ExposedHeaders: ['ETag'], MaxAge: 3600 }],
    },
  });
  assert.deepEqual([...DEFAULT_MEDIA_ORIGINS.staging], ['https://staging--emgloop2.netlify.app']);
});

test('mediaOrigins context: a comma-separated list replaces the default exactly; junk fails synth', () => {
  const t = synthWith({ mediaOrigins: 'https://a.example,https://b.example' });
  t.hasResourceProperties('AWS::S3::Bucket', {
    CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://a.example', 'https://b.example'] })] },
  });
  const defaults = DEFAULT_MEDIA_ORIGINS.staging;
  assert.deepEqual(mediaOriginsFromContext(' https://a.example , https://b.example:8443 ', defaults), ['https://a.example', 'https://b.example:8443']);
  assert.deepEqual(mediaOriginsFromContext(undefined, defaults), defaults);
  assert.deepEqual(mediaOriginsFromContext('  ', defaults), defaults);
  assert.throws(() => mediaOriginsFromContext('https://a.example/path', defaults), /bare http\(s\) origin/);
  assert.throws(() => mediaOriginsFromContext('https://a.example/', defaults), /bare http\(s\) origin/);
  assert.throws(() => mediaOriginsFromContext('*', defaults), /not a URL/);
  assert.throws(() => mediaOriginsFromContext('ftp://a.example', defaults), /bare http\(s\) origin/);
});

test('media signer: one Node 24 function, small and short-lived, fed the bucket, the prefix and the worker-control secret ARN', () => {
  const { fn } = mediaSigner();
  assert.equal(fn.Runtime, 'nodejs24.x');
  assert.equal(fn.Handler, 'index.handler');
  assert.equal(fn.MemorySize, 256);
  assert.equal(fn.Timeout, 10);
  const env = fn.Environment.Variables as Record<string, unknown>;
  assert.equal(logicalId(env.LOOP_MEDIA_BUCKET), bucketId(), 'LOOP_MEDIA_BUCKET is the media bucket');
  assert.equal(env.LOOP_MEDIA_KEY_PREFIX, MEDIA_KEY_PREFIX);
  assert.equal(env.LOOP_MEDIA_KEY_PREFIX, 'media/');
  assert.equal(logicalId(env.LOOP_MEDIA_SIGNER_SECRET_ARN), workerControlId(), 'the signer verifies against the EXISTING worker-control secret, not a new one');
  assert.ok(!JSON.stringify(env).match(/anthropic|openai|postgresql/i), 'no provider or database in the signer environment');
  // Its own log group, one month, destroyable; the worker's log group is untouched.
  assert.equal(count('AWS::Logs::LogGroup'), 2);
  for (const r of Object.values(resources).filter((r) => r.Type === 'AWS::Logs::LogGroup')) assert.equal(r.Properties.RetentionInDays, 30);
  // A rolled-back first deploy must leave its logs behind: the only `worker_fatal` line a boot failure
  // writes lives here, and a DESTROY policy deleted it with the stack on 2026-09-24.
  for (const r of Object.values(resources).filter((r) => r.Type === 'AWS::Logs::LogGroup') as any[]) {
    assert.equal(r.DeletionPolicy, 'Retain', 'log groups outlive a failed stack');
    assert.equal(r.UpdateReplacePolicy, 'Retain');
  }
  assert.equal(logicalId(fn.LoggingConfig?.LogGroup), Object.entries(resources).find(([id, r]) => r.Type === 'AWS::Logs::LogGroup' && /MediaSigner/.test(id))?.[0]);
});

test('media signer: its role may touch ONLY objects under media/ (put/get/delete) and read ONLY the worker-control secret', () => {
  const { role, statements } = mediaSigner();
  assert.equal(role.ManagedPolicyArns, undefined, 'no managed policy');
  const actions = [...new Set(statements.flatMap(actionsOf))].sort();
  assert.deepEqual(actions, [
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    's3:DeleteObject',
    's3:GetObject',
    's3:PutObject',
    'secretsmanager:DescribeSecret',
    'secretsmanager:GetSecretValue',
  ]);
  for (const s of statements) {
    assert.equal(s.Effect, 'Allow');
    for (const a of actionsOf(s)) assert.ok(!a.endsWith(':*') && a !== '*' && a !== 's3:ListBucket', `forbidden action ${a}`);
    for (const r of resourcesOf(s)) assert.notEqual(r, '*', 'no wildcard resource');
  }
  // Every S3 grant is the object ARN under media/ -- never the bucket root, never bucket/*.
  const s3Statements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('s3:')));
  assert.equal(s3Statements.length, 1);
  for (const r of resourcesOf(s3Statements[0]!) as any[]) {
    const parts = r['Fn::Join']?.[1] as any[] | undefined;
    assert.ok(parts, 'the S3 resource is bucketArn + suffix');
    assert.equal(logicalId(parts[0]), bucketId());
    assert.equal(parts[parts.length - 1], `/${MEDIA_KEY_PREFIX}*`);
  }
  const bare = statements.flatMap(resourcesOf).filter((r: any) => logicalId(r) === bucketId() && !r['Fn::Join']);
  assert.equal(bare.length, 0, 'no grant on the bucket ARN itself (that is where ListBucket would live)');
  // The secret grant is the worker-control secret and nothing else.
  const secretStatements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('secretsmanager:')));
  assert.equal(secretStatements.length, 1);
  assert.deepEqual(resourcesOf(secretStatements[0]!).map(logicalId), [workerControlId()]);
  // No other principal in the stack gains any S3 access: the worker task cannot reach media.
  const signerRoleId = mediaSigner().roleId;
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Policy') {
      if ((r.Properties.Roles as any[]).map(logicalId).includes(signerRoleId)) continue;
      const others = (r.Properties.PolicyDocument.Statement as Statement[]).flatMap(actionsOf).filter((a) => a.startsWith('s3:'));
      assert.deepEqual(others, [], `${id} must not hold S3 access`);
    }
    if (r.Type === 'AWS::IAM::Role') {
      const inline = ((r.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Statement[] } }>).flatMap((p) => p.PolicyDocument.Statement).flatMap(actionsOf);
      assert.deepEqual(inline.filter((a) => a.startsWith('s3:')), [], `${id} must not hold inline S3 access`);
    }
  }
});

test('media signer: exactly one new route, POST /media/sign, proxied to the function; every other route still reaches the worker', () => {
  const { fnId } = mediaSigner();
  const routes = Object.values(resources).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route');
  const media = routes.filter((r) => r.Properties.RouteKey === `POST ${MEDIA_SIGN_PATH}`);
  assert.equal(media.length, 1);
  assert.equal(MEDIA_SIGN_PATH, '/media/sign');
  const integrationId = (media[0]!.Properties.Target['Fn::Join'][1] as any[]).map(logicalId).find(Boolean);
  assert.ok(integrationId, 'the route targets an integration in this template');
  const integration = resources[integrationId]!;
  assert.equal(integration.Type, 'AWS::ApiGatewayV2::Integration');
  assert.equal(integration.Properties.IntegrationType, 'AWS_PROXY');
  assert.equal(integration.Properties.PayloadFormatVersion, '2.0');
  assert.equal(logicalId(integration.Properties.IntegrationUri), fnId);
  // The worker's routes are intact: the ALB default, five control endpoints and health, all via
  // the VPC Link -- and none of them is a Lambda integration.
  const viaAlb = routes.filter((r) => r.Properties.RouteKey !== `POST ${MEDIA_SIGN_PATH}`);
  assert.deepEqual(viaAlb.map((r) => r.Properties.RouteKey).sort(), ['$default', 'GET /healthz', 'POST /telegram/disconnect', 'POST /telegram/login/cancel', 'POST /telegram/login/code', 'POST /telegram/login/password', 'POST /telegram/login/start']);
  const lambdaIntegrations = Object.values(resources).filter((r) => r.Type === 'AWS::ApiGatewayV2::Integration' && r.Properties.IntegrationType === 'AWS_PROXY');
  assert.equal(lambdaIntegrations.length, 1, 'the signer is the only Lambda integration');
  assert.equal(count('AWS::ApiGatewayV2::Api'), 1, 'the signer rides the EXISTING API');
  assert.equal(count('AWS::ApiGatewayV2::VpcLink'), 1);
  // Only API Gateway may invoke the function.
  const permissions = Object.values(resources).filter((r) => r.Type === 'AWS::Lambda::Permission');
  assert.ok(permissions.length >= 1);
  for (const p of permissions) assert.equal(p.Properties.Principal, 'apigateway.amazonaws.com');
});

test('media: the stack still creates exactly the two HMAC secrets and exposes the bucket name and signer URL', () => {
  assert.equal(createdSecretNames(template).length, 2, 'the signer adds no secret; it shares the worker-control secret');
  const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
  assert.ok(outputs.MediaBucketName, 'MediaBucketName output');
  assert.equal(logicalId(outputs.MediaBucketName!.Value), bucketId());
  assert.ok(outputs.MediaSignerUrl, 'MediaSignerUrl output');
  assert.ok(JSON.stringify(outputs.MediaSignerUrl!.Value).includes(MEDIA_SIGN_PATH));
  assert.ok(outputs.WorkerUrl && outputs.WorkerControlSecretArn, 'the existing outputs remain');
});

test('the target guard refuses non-staging credentials, allows credential-free synth', () => {
  assert.doesNotThrow(() => assertTargetCredentials(CONNECTIONS_STAGING_TARGET, undefined));
  assert.doesNotThrow(() => assertTargetCredentials(CONNECTIONS_STAGING_TARGET, ''));
  assert.doesNotThrow(() => assertTargetCredentials(CONNECTIONS_STAGING_TARGET, '065148797865'));
  assert.throws(() => assertTargetCredentials(CONNECTIONS_STAGING_TARGET, '670682108352'), WrongTargetError); // management account
  assert.throws(() => assertTargetCredentials(CONNECTIONS_STAGING_TARGET, '123456789012'), WrongTargetError);
  // The app runs the same guard: staging credentials build; management credentials are refused.
  assert.doesNotThrow(() => buildConnectionsApp({ image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim'), assetsDir: stubAssets(), credentialAccount: '065148797865' }));
  assert.throws(() => buildConnectionsApp({ image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim'), assetsDir: stubAssets(), credentialAccount: '670682108352' }), WrongTargetError);
});

test('the staging target is pinned exactly as authorized; the stack lands there under its name', () => {
  assert.deepEqual({ ...CONNECTIONS_STAGING_TARGET }, {
    accountName: 'Loop Brain Staging',
    account: '065148797865',
    region: 'us-east-1',
    stackName: 'LoopConnections-staging',
    stage: 'staging',
    bootstrapQualifier: 'hnb659fds',
  });
  const { stack } = synthStack();
  assert.equal(stack.stackName, 'LoopConnections-staging');
  assert.equal(stack.account, '065148797865');
  assert.equal(stack.region, 'us-east-1');
  assert.equal(stack.terminationProtection, true);
  assert.equal(stack.templateOptions.description, 'Loop connections worker (staging): Teams/Telegram durable observation worker');
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', { Description: 'Loop connections worker control API (staging).' });
});

// ---------------------------------------------------------------------------------------------
// Protection: absent by default in staging (no alertEmail context) -- and loudly so. With an
// address, exactly one topic, one budget and one alarm appear. test/production.test.ts proves the
// production stage REQUIRES the address. Every resource carries loop:stage.
// ---------------------------------------------------------------------------------------------

/** Whether a resource's Tags (list or map form) carry loop:stage=<stage>. */
function hasStageTag(tags: unknown, stage: string): boolean {
  if (Array.isArray(tags)) return tags.some((t) => t && t.Key === 'loop:stage' && t.Value === stage);
  if (tags && typeof tags === 'object') return (tags as Record<string, unknown>)['loop:stage'] === stage;
  return false;
}

test('DEFAULT staging (no alertEmail): no topic, no budget, no alarm -- and synth warns about it', () => {
  for (const type of ['AWS::SNS::Topic', 'AWS::SNS::Subscription', 'AWS::Budgets::Budget', 'AWS::CloudWatch::Alarm']) {
    assert.equal(count(type), 0, `unexpected ${type} without an alert address`);
  }
  const { stack } = synthStack();
  Annotations.fromStack(stack).hasWarning('/LoopConnections-staging', Match.stringLikeRegexp('No alertEmail context: the staging stack has NO cost budget and NO availability alarm'));
});

test('staging with alertEmail: one topic subscribed to it, a $60 monthly budget at 80%/100%, one worker-down alarm wired to the topic', () => {
  const { stack } = synthStack({ alertEmail: 'ops@example.invalid' });
  const t = Template.fromStack(stack);
  Annotations.fromStack(stack).hasNoWarning('/LoopConnections-staging', Match.stringLikeRegexp('No alertEmail'));
  t.resourceCountIs('AWS::SNS::Topic', 1);
  t.resourceCountIs('AWS::SNS::Subscription', 1);
  t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.invalid' });
  t.resourceCountIs('AWS::Budgets::Budget', 1);
  t.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: { BudgetName: 'loop-connections-staging-monthly', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 60, Unit: 'USD' }, CostFilters: Match.absent() },
    NotificationsWithSubscribers: [80, 100].map((threshold) => ({
      Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: threshold, ThresholdType: 'PERCENTAGE' },
      Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.invalid' }],
    })),
  });
  t.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'loop-connections-staging-worker-down',
    Namespace: 'AWS/ApplicationELB',
    MetricName: 'HealthyHostCount',
    Statistic: 'Minimum',
    Period: 60,
    EvaluationPeriods: 5,
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
    TreatMissingData: 'breaching',
    AlarmActions: [Match.anyValue()],
    OKActions: [Match.anyValue()],
  });
  // A budget override is honoured; junk is refused.
  Template.fromStack(synthStack({ alertEmail: 'ops@example.invalid', monthlyBudgetUsd: '75' }).stack).hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 75, Unit: 'USD' } }) });
  assert.throws(() => synthStack({ alertEmail: 'ops@example.invalid', monthlyBudgetUsd: '0' }), /positive whole number/);
  assert.throws(() => synthStack({ alertEmail: 'ops@example.invalid', monthlyBudgetUsd: '12.5' }), /positive whole number/);
  assert.throws(() => synthStack({ alertEmail: 'not-an-address' }), /not an email address/);
  // Nothing else changed: the worker, its secrets and the signer are the same shape.
  const res = t.toJSON().Resources as Record<string, { Type: string }>;
  const added = ['AWS::SNS::Topic', 'AWS::SNS::Subscription', 'AWS::Budgets::Budget', 'AWS::CloudWatch::Alarm'];
  const types = (r: Record<string, { Type: string }>) => Object.values(r).map((x) => x.Type).filter((x) => !added.includes(x)).sort();
  assert.deepEqual(types(res), types(resources));
});

test('every resource carries loop:stage=staging: per resource where CDK can, and as a stack tag for the rest', () => {
  const tagged = Object.entries(resources).filter(([, r]) => r.Properties?.Tags !== undefined);
  assert.ok(tagged.length >= 10, 'expected the VPC, service, task, ALB, bucket, functions, secrets, log groups and roles to be tagged');
  for (const [id, r] of tagged) assert.ok(hasStageTag(r.Properties.Tags, 'staging'), `${id} lacks loop:stage=staging`);
  // The one role the tag aspect cannot reach is CDK's own custom-resource provider (a raw
  // CfnResource); the stack-level tag below reaches it at deploy time.
  const isCdkProvider = (id: string) => /^CustomVpcRestrictDefaultSG/.test(id);
  for (const type of ['AWS::EC2::VPC', 'AWS::ECS::Cluster', 'AWS::ECS::Service', 'AWS::ECS::TaskDefinition', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::S3::Bucket', 'AWS::SecretsManager::Secret', 'AWS::Logs::LogGroup', 'AWS::IAM::Role']) {
    const of = Object.entries(resources).filter(([id, r]) => r.Type === type && !isCdkProvider(id));
    assert.ok(of.length > 0 && of.every(([, r]) => hasStageTag(r.Properties?.Tags, 'staging')), `${type} must carry loop:stage`);
  }
  assert.deepEqual(synthStack().stack.tags.tagValues(), { 'loop:stage': 'staging' });
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

  // The four activation vars reach the worker with the placeholder org id and exact values -- and
  // exactly those four. LOOP_AI_PROVIDER_TERMS_CONFIRMED is NOT set (2026-09-24): the stack used to set
  // it automatically for every provider it listed, which made "listed" imply "terms approved". G2 is
  // now a recorded provider policy in the database, and nothing in this stack can stand in for it.
  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_ENABLED, 'true');
  assert.equal(env.LOOP_AI_PROVIDERS, 'anthropic');
  assert.equal(env.LOOP_AI_ORGANIZATIONS, PLACEHOLDER_ORG_ID);
  assert.equal(env.LOOP_AI_TASKS, 'telegram.content.triage');
  assert.equal('LOOP_AI_PROVIDER_TERMS_CONFIRMED' in env, false, 'the stack never implies a provider policy');
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('LOOP_AI_')).sort(), ['LOOP_AI_ENABLED', 'LOOP_AI_ORGANIZATIONS', 'LOOP_AI_PROVIDERS', 'LOOP_AI_TASKS']);

  // OpenAI is opt-in: no OPENAI_API_KEY secret unless aiProviders lists it.
  assert.ok(!(c.Secrets ?? []).some((s) => s.Name === 'OPENAI_API_KEY'), 'OPENAI_API_KEY must be absent by default');

  // Because the secret is referenced (not created), no credential value can exist in the template.
  const json = JSON.stringify(t.toJSON());
  assert.ok(!/sk-ant-/.test(json) && !/sk-[A-Za-z0-9_-]{20,}/.test(json), 'no plaintext key material anywhere in the template');
});

test('aiProviders=anthropic,openai: OPENAI_API_KEY referenced from openai_api_key and nothing else added; still no plaintext key', () => {
  // A task other than telegram.content.triage: beside triage v4, openai is refused (see the guard test).
  const base = synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiTasks: 'chats.digest.v2' });
  const t = synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: 'anthropic,openai', aiTasks: 'chats.digest.v2' });
  const c = workerContainer(t);

  const openai = (c.Secrets ?? []).find((s) => s.Name === 'OPENAI_API_KEY');
  assert.ok(openai, 'OPENAI_API_KEY must be in the container Secrets when openai is listed');
  const valueFrom = openai!.ValueFrom as string;
  assert.ok(valueFrom.includes(AI_SECRET_NAME) && valueFrom.endsWith(':openai_api_key::'), 'OPENAI_API_KEY must select the openai_api_key JSON field of the ai secret');
  // Exactly one secret more than the default activation, and it is the openai field.
  const names = (x: typeof c) => (x.Secrets ?? []).map((s) => s.Name).sort();
  assert.deepEqual(names(c), [...names(workerContainer(base)), 'OPENAI_API_KEY'].sort());

  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_PROVIDERS, 'anthropic,openai');
  assert.equal(env.LOOP_AI_TASKS, 'chats.digest.v2');
  assert.equal('LOOP_AI_PROVIDER_TERMS_CONFIRMED' in env, false, 'listing openai does not approve it either');

  for (const e of c.Environment ?? []) {
    assert.notEqual(e.Name, 'ANTHROPIC_API_KEY');
    assert.notEqual(e.Name, 'OPENAI_API_KEY');
  }
  // Still no created secret and no key material -- the ai secret is referenced, not created.
  assert.equal(createdSecretNames(t).length, 2);
  const json = JSON.stringify(t.toJSON());
  assert.ok(!/sk-ant-/.test(json) && !/sk-[A-Za-z0-9_-]{20,}/.test(json), 'no plaintext key material anywhere in the template');
});

test('the AI defaults are exactly today: unset aiProviders/aiTasks synthesize the SAME template as anthropic + telegram.content.triage', () => {
  const defaults = synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID }).toJSON();
  assert.deepEqual(synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: 'anthropic', aiTasks: 'telegram.content.triage' }).toJSON(), defaults);
  // An empty value -- what the workflow passes when the variable is unset -- is the default too.
  assert.deepEqual(synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: '', aiTasks: ' ' }).toJSON(), defaults);
  assert.deepEqual([...aiProvidersFromContext(undefined)], ['anthropic']);
  assert.deepEqual([...aiTasksFromContext('')], ['telegram.content.triage']);
});

test('aiProviders=openai alone: only the openai_api_key field is referenced', () => {
  const c = workerContainer(synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: 'openai', aiTasks: 'chats.digest.v2' }));
  const ai = (c.Secrets ?? []).filter((s) => String(s.ValueFrom).includes(AI_SECRET_NAME));
  assert.deepEqual(ai.map((s) => s.Name), ['OPENAI_API_KEY']);
  assert.ok((ai[0]!.ValueFrom as string).endsWith(':openai_api_key::'));
  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_PROVIDERS, 'openai');
  // Order is the operator's, preserved.
  const reversed = workerContainer(synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: ' openai , anthropic ', aiTasks: 'chats.digest.v2' }));
  assert.equal(Object.fromEntries((reversed.Environment ?? []).map((e) => [e.Name, e.Value])).LOOP_AI_PROVIDERS, 'openai,anthropic');
});

test('aiTasks flows to LOOP_AI_TASKS in order', () => {
  const c = workerContainer(synthWith({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiTasks: 'telegram.content.triage, chats.digest.v2' }));
  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_AI_TASKS, 'telegram.content.triage,chats.digest.v2');
});

test('an invalid aiProviders or aiTasks value fails synth loudly, naming the context key -- never a silent default', () => {
  const refuses = (context: Record<string, unknown>, key: RegExp) =>
    assert.throws(() => synthStack({ aiOrganizationId: PLACEHOLDER_ORG_ID, ...context }), key);
  refuses({ aiProviders: 'gemini' }, /^Error: aiProviders: "gemini" is not one of anthropic, openai/);
  refuses({ aiProviders: 'Anthropic' }, /aiProviders/);
  refuses({ aiProviders: 'anthropic,anthropic' }, /aiProviders: "anthropic" is listed twice/);
  refuses({ aiProviders: 'anthropic,,openai', aiTasks: 'chats.digest.v2' }, /aiProviders: .* has an empty entry/);
  refuses({ aiProviders: true }, /aiProviders must be a comma-separated string/);
  refuses({ aiTasks: 'triage' }, /aiTasks: "triage" is not a task id/);
  refuses({ aiTasks: 'Telegram.content.triage' }, /aiTasks/);
  refuses({ aiTasks: 'telegram.content.triage,telegram.content.triage' }, /aiTasks: "telegram.content.triage" is listed twice/);
  refuses({ aiTasks: 'telegram..triage' }, /aiTasks/);
  // The lists are validated even while AI is off: a bad variable is caught before it is ever used.
  assert.throws(() => synthStack({ aiProviders: 'gemini' }), /aiProviders/);
});

test('without aiOrganizationId nothing AI-related appears, whatever the lists say', () => {
  const t = synthWith({ aiProviders: 'anthropic,openai', aiTasks: 'chats.digest.v2,case.explanation' });
  assert.deepEqual(t.toJSON(), template.toJSON());
  const json = JSON.stringify(t.toJSON());
  assert.ok(!json.includes(AI_SECRET_NAME) && !/LOOP_AI_|ANTHROPIC_API_KEY|OPENAI_API_KEY/.test(json));
});

test('Chats v5: the triage-v4 provider guard is retired -- a second provider beside triage synthesizes (and is still commissioned only by policy + activation)', () => {
  assert.doesNotThrow(() => synthStack({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: 'anthropic,openai' }));
  assert.doesNotThrow(() => synthStack({ aiOrganizationId: PLACEHOLDER_ORG_ID, aiProviders: 'anthropic' }));
  assert.doesNotThrow(() => synthStack({ aiProviders: 'anthropic,openai' }));
});

test('the guard retired TOGETHER with the exemption: both the shared exemption list and the verified-provider policy are empty', () => {
  const repo = join(__dirname, '..', '..', '..');
  const shared = readFileSync(join(repo, 'packages', 'shared', 'src', 'ai', 'portable-schema.ts'), 'utf8');
  const policy = readFileSync(join(repo, 'packages', 'providers', 'src', 'ai', 'policy', 'schema-verification.ts'), 'utf8');
  const app = readFileSync(join(__dirname, '..', 'lib', 'app.ts'), 'utf8');
  assert.match(shared, /AI_PORTABLE_SCHEMA_EXEMPTIONS: Readonly<Record<string, readonly string\[\]>> = Object\.freeze\(\{\}\);/, 'no schema is exempt');
  assert.match(policy, /AI_SCHEMA_VERIFIED_PROVIDERS: Readonly<Record<string, readonly string\[\]>> = Object\.freeze\(\{\}\);/, 'no provider restriction is recorded');
  assert.doesNotMatch(app, /TRIAGE_V4_VERIFIED_PROVIDERS|assertAiProvidersVerified\(/, 'and this stack carries none either');
});

// --- Loop Intelligence (2026-09-26) ----------------------------------------------------------------

test('Loop Intelligence: unset (the default) sets no LOOP_INTELLIGENCE_* variable and changes nothing', () => {
  const c = workerContainer(template);
  assert.ok(!(c.Environment ?? []).some((e) => e.Name.startsWith('LOOP_INTELLIGENCE_')));
  assert.deepEqual(synthWith({ intelligenceProducers: '', intelligenceSituations: ' ', intelligenceBriefings: '', intelligenceActingUsers: '' }).toJSON(), template.toJSON());
});

test('Loop Intelligence: named producers, situations, briefings and acting operators reach the worker as plain settings (never secrets)', () => {
  const c = workerContainer(synthWith({ intelligenceProducers: 'callgrid.domain@1,work.domain@1', intelligenceSituations: 'organization,private', intelligenceBriefings: 'on', intelligenceActingUsers: 'org_1=user_1' }));
  const env = Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.equal(env.LOOP_INTELLIGENCE_PRODUCERS, 'callgrid.domain@1,work.domain@1');
  assert.equal(env.LOOP_INTELLIGENCE_SITUATIONS, 'organization,private');
  assert.equal(env.LOOP_INTELLIGENCE_BRIEFINGS, 'on');
  assert.equal(env.LOOP_INTELLIGENCE_ACTING_USERS, 'org_1=user_1');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('LOOP_AI_')), 'intelligence settings never switch the AI runtime on');
});

test('Loop Intelligence: a malformed setting fails synth rather than half-configuring the worker', () => {
  assert.throws(() => intelligenceFromContext({ producers: 'callgrid' }), /producer id/);
  assert.throws(() => intelligenceFromContext({ situations: 'everyone' }), /organization or private/);
  assert.throws(() => intelligenceFromContext({ briefings: 'true' }), /exactly "on"/);
  assert.throws(() => intelligenceFromContext({ actingUsers: 'org_1' }), /orgId=userId/);
  assert.deepEqual(intelligenceFromContext({}), {});
});
