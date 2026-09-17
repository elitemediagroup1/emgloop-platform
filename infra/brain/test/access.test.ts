// The GitHub deploy identity: who may deploy the Brain stack, and what it may touch. Slice B7.
//
// access/github-deploy-access.yaml is deployed once, by hand, outside the Brain CDK app. These
// checks read that committed template and the workflow that uses it, and compare the roles it
// may assume with the ones the Brain stack's cloud assembly will actually ask CDK to assume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { App, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

import { buildBrainApp } from '../lib/app';
import { BRAIN_STAGING_TARGET } from '../lib/target';
import { BRAIN_FUNCTIONS } from '../scripts/bundle';

const ACCESS_TEMPLATE = resolve(__dirname, '..', 'access', 'github-deploy-access.yaml');
const DEPLOY_WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'brain-infra-deploy.yml');

const REPOSITORY = 'elitemediagroup1/emgloop-platform';
const ENVIRONMENT = 'brain-staging';
const { account, region, bootstrapQualifier } = BRAIN_STAGING_TARGET;
const cdkRole = (name: string) => `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-${name}-role-${account}-${region}`;

type Resource = { Type: string; Properties: Record<string, any> };

// CfnInclude parses the YAML (short-form intrinsics included) exactly as CloudFormation reads it.
function accessTemplate(): Record<string, any> {
  const app = new App({ analyticsReporting: false });
  const stack = new Stack(app, 'Access', { synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }) });
  new CfnInclude(stack, 'Template', { templateFile: ACCESS_TEMPLATE });
  return Template.fromStack(stack).toJSON();
}

const template = accessTemplate();
const resources = template.Resources as Record<string, Resource>;
const role = resources.GitHubDeployRole!;
const provider = resources.GitHubOidcProvider!;

test('the template holds only the GitHub OIDC provider and one role, and takes no input', () => {
  assert.deepEqual(
    Object.entries(resources).map(([id, r]) => [id, r.Type]).sort(),
    [
      ['GitHubDeployRole', 'AWS::IAM::Role'],
      ['GitHubOidcProvider', 'AWS::IAM::OIDCProvider'],
    ],
  );
  assert.equal(template.Parameters, undefined, 'no parameter can widen the trust at deploy time');
  assert.equal(template.Conditions, undefined);
  // `!GetAtt A.B` and `Fn::GetAtt: [A, B]` are the same reference; compare the array form.
  const outputs = JSON.parse(JSON.stringify(template.Outputs), (_k, v) =>
    v && typeof v === 'object' && typeof v['Fn::GetAtt'] === 'string' ? { 'Fn::GetAtt': v['Fn::GetAtt'].split('.') } : v,
  );
  assert.deepEqual(outputs, {
    DeployRoleArn: {
      Description: 'The value of the brain-staging environment variable BRAIN_STAGING_DEPLOY_ROLE_ARN.',
      Value: { 'Fn::GetAtt': ['GitHubDeployRole', 'Arn'] },
    },
    OidcProviderArn: {
      Description: 'The GitHub Actions OIDC identity provider in this account.',
      Value: { Ref: 'GitHubOidcProvider' },
    },
  });
});

test("the provider is GitHub's issuer, for the STS audience only", () => {
  assert.equal(provider.Properties.Url, 'https://token.actions.githubusercontent.com');
  assert.deepEqual(provider.Properties.ClientIdList, ['sts.amazonaws.com']);
  assert.equal(provider.Properties.ThumbprintList, undefined, 'IAM verifies this issuer against its trusted CAs');
});

test('only the brain-staging environment of this repository can assume the role', () => {
  assert.equal(role.Properties.RoleName, 'loop-brain-github-deploy');
  assert.equal(role.Properties.MaxSessionDuration, 3600);
  assert.equal(role.Properties.ManagedPolicyArns, undefined, 'no managed policy');
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument, {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BrainStagingEnvironmentOnly',
        Effect: 'Allow',
        Principal: { Federated: { Ref: 'GitHubOidcProvider' } },
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

test('the role may only assume the deploy, file-publishing and lookup roles of the CDK bootstrap', () => {
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
            Resource: [cdkRole('deploy'), cdkRole('file-publishing'), cdkRole('lookup')],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(
    [cdkRole('deploy'), cdkRole('file-publishing'), cdkRole('lookup')],
    [
      'arn:aws:iam::065148797865:role/cdk-hnb659fds-deploy-role-065148797865-us-east-1',
      'arn:aws:iam::065148797865:role/cdk-hnb659fds-file-publishing-role-065148797865-us-east-1',
      'arn:aws:iam::065148797865:role/cdk-hnb659fds-lookup-role-065148797865-us-east-1',
    ],
  );
});

test('those three roles are exactly the ones the Brain stack deployment asks CDK to assume', () => {
  const assets = mkdtempSync(join(tmpdir(), 'brain-assets-'));
  for (const f of BRAIN_FUNCTIONS) {
    mkdirSync(join(assets, f.name));
    writeFileSync(join(assets, f.name, 'index.js'), `exports.handler = async () => (${JSON.stringify({ stub: f.name })});`);
  }
  const outdir = mkdtempSync(join(tmpdir(), 'brain-cdk-out-'));
  buildBrainApp({ assetsDir: assets, outdir }).app.synth();
  const literal = (arn: string) => arn.replace('${AWS::Partition}', 'aws');
  const stack = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')).artifacts[BRAIN_STAGING_TARGET.stackName];
  const published = JSON.parse(readFileSync(join(outdir, `${BRAIN_STAGING_TARGET.stackName}.assets.json`), 'utf8'));
  assert.deepEqual(published.dockerImages ?? {}, {}, 'no image assets, so the image-publishing role is not needed');
  const needed = new Set<string>([
    literal(stack.properties.assumeRoleArn),
    literal(stack.properties.lookupRole.arn),
    ...Object.values(published.files as Record<string, { destinations: Record<string, { assumeRoleArn: string }> }>)
      .flatMap((f) => Object.values(f.destinations))
      .map((d) => literal(d.assumeRoleArn)),
  ]);
  assert.deepEqual([...needed].sort(), [...role.Properties.Policies[0].PolicyDocument.Statement[0].Resource].sort());
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
  const code = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, new RegExp(`^    environment: ${ENVIRONMENT}$`, 'm'));
  assert.match(code, /^  id-token: write$/m);
  assert.doesNotMatch(code, /secrets\./, 'no AWS secret in GitHub');
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned to the v6.3.0 commit');
  assert.match(workflow, /configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6\.3\.0$/m);
  assert.match(code, /^          role-to-assume: \$\{\{ vars\.BRAIN_STAGING_DEPLOY_ROLE_ARN \}\}$/m);
  assert.match(code, new RegExp(`^          aws-region: ${region}$`, 'm'));
  assert.match(code, new RegExp(`^          allowed-account-ids: '${account}'$`, 'm'));
  assert.match(code, new RegExp(`^      BRAIN_ACCOUNT: '${account}'$`, 'm'));
});
