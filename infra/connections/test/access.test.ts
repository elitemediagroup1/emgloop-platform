// The GitHub deploy identity: who may deploy the connections stack, and what it may touch.
//
// access/github-deploy-access.yaml is deployed once, by hand, outside the connections CDK app. These
// checks read that committed template and the workflow that uses it, and compare the roles it may
// assume with the ones the stack's cloud assembly actually asks CDK to assume (plus image-publishing,
// which the Fargate image asset needs and a registry-image synth cannot exercise without Docker).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { App, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';
import { CONNECTIONS_STAGING_TARGET } from '../lib/target';
import { stubAssets } from './assets';

const ACCESS_TEMPLATE = resolve(__dirname, '..', 'access', 'github-deploy-access.yaml');
const DEPLOY_WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'connections-infra-deploy.yml');

const REPOSITORY = 'elitemediagroup1/emgloop-platform';
const ENVIRONMENT = 'connections-staging';
const { account, region, bootstrapQualifier } = CONNECTIONS_STAGING_TARGET;
const cdkRole = (name: string) => `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-${name}-role-${account}-${region}`;

type Resource = { Type: string; Properties: Record<string, any> };

function accessTemplate(): Record<string, any> {
  const app = new App({ analyticsReporting: false });
  const stack = new Stack(app, 'Access', { synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }) });
  new CfnInclude(stack, 'Template', { templateFile: ACCESS_TEMPLATE });
  return Template.fromStack(stack).toJSON();
}

const template = accessTemplate();
const resources = template.Resources as Record<string, Resource>;
const role = resources.GitHubDeployRole!;

test('the template holds ONLY the deploy role (the OIDC provider already exists) and takes no input', () => {
  assert.deepEqual(
    Object.entries(resources).map(([id, r]) => [id, r.Type]),
    [['GitHubDeployRole', 'AWS::IAM::Role']],
  );
  assert.equal(template.Parameters, undefined, 'no parameter can widen the trust at deploy time');
  assert.equal(template.Conditions, undefined);
});

test('only the connections-staging environment of this repository can assume the role', () => {
  assert.equal(role.Properties.RoleName, 'loop-connections-github-deploy');
  assert.equal(role.Properties.MaxSessionDuration, 3600);
  assert.equal(role.Properties.ManagedPolicyArns, undefined, 'no managed policy');
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument, {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ConnectionsStagingEnvironmentOnly',
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:environment:${ENVIRONMENT}`,
          },
        },
      },
    ],
  });
});

test('the role may assume exactly the four CDK bootstrap roles (deploy, file-publishing, image-publishing, lookup)', () => {
  assert.deepEqual(role.Properties.Policies, [
    {
      PolicyName: 'assume-cdk-bootstrap-roles',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'UseCdkBootstrapRolesOnly',
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: [cdkRole('deploy'), cdkRole('file-publishing'), cdkRole('image-publishing'), cdkRole('lookup')],
          },
        ],
      },
    },
  ]);
});

test('the non-image roles are exactly the ones the stack deployment asks CDK to assume; image-publishing covers the Fargate image', () => {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  const outdir = mkdtempSync(join(tmpdir(), 'connections-cdk-out-'));
  buildConnectionsApp({ image, assetsDir: stubAssets(), outdir }).app.synth();
  const literal = (arn: string) => arn.replace('${AWS::Partition}', 'aws');
  const stack = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')).artifacts[CONNECTIONS_STAGING_TARGET.stackName];
  const published = JSON.parse(readFileSync(join(outdir, `${CONNECTIONS_STAGING_TARGET.stackName}.assets.json`), 'utf8'));
  const needed = new Set<string>([
    literal(stack.properties.assumeRoleArn),
    literal(stack.properties.lookupRole.arn),
    ...Object.values(published.files as Record<string, { destinations: Record<string, { assumeRoleArn: string }> }>)
      .flatMap((f) => Object.values(f.destinations))
      .map((d) => literal(d.assumeRoleArn)),
  ]);
  const granted = new Set<string>(role.Properties.Policies[0].PolicyDocument.Statement[0].Resource as string[]);
  // Everything the (registry-image) synth needs is granted.
  for (const arn of needed) assert.ok(granted.has(arn), `deploy needs ${arn} but the role cannot assume it`);
  // deploy + file-publishing + lookup are actually exercised; image-publishing is additionally
  // granted for the container image the real (Dockerfile) deploy publishes.
  assert.ok(needed.has(cdkRole('deploy')) && needed.has(cdkRole('file-publishing')) && needed.has(cdkRole('lookup')));
  assert.ok(granted.has(cdkRole('image-publishing')), 'the Fargate image asset requires image-publishing');
});

test('no wildcard, negation or unresolved placeholder anywhere in the identity', () => {
  const strings: string[] = [];
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
  };
  walk(resources);
  walk(template.Outputs);
  for (const s of strings) {
    assert.doesNotMatch(s, /[*?]/, `wildcard in ${s}`);
    assert.doesNotMatch(s, /\$\{|<|>/, `placeholder in ${s}`);
  }
  for (const k of keys) {
    assert.doesNotMatch(k, /^Not(Action|Resource|Principal)$|Like$|^ForAnyValue|^ForAllValues/, `broadening operator ${k}`);
  }
  assert.ok(!JSON.stringify(resources).includes('"Deny"'), 'nothing relies on a deny to stay narrow');
});

test('the deploy workflow reaches AWS only through this identity, the pinned action and the staging account', () => {
  const workflow = readFileSync(DEPLOY_WORKFLOW, 'utf8');
  const code = workflow.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, new RegExp(`^    environment: ${ENVIRONMENT}$`, 'm'));
  assert.match(code, /^  id-token: write$/m);
  assert.doesNotMatch(code, /secrets\./, 'no AWS secret in GitHub');
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned to the v6.3.0 commit');
  assert.match(code, /^          role-to-assume: \$\{\{ vars\.CONNECTIONS_STAGING_DEPLOY_ROLE_ARN \}\}$/m);
  assert.match(code, new RegExp(`^          aws-region: ${region}$`, 'm'));
  assert.match(code, new RegExp(`^          allowed-account-ids: '${account}'$`, 'm'));
  assert.match(code, new RegExp(`^      CONNECTIONS_ACCOUNT: '${account}'$`, 'm'));
  // synth runs before deploy; deploy is gated on the confirmation text.
  assert.match(code, /cdk synth --no-notices LoopConnections-staging/);
  assert.match(code, /inputs\.confirm != 'deploy loop-connections-staging'/);
});
