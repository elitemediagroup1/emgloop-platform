// The GitHub MIGRATIONS identity + workflow: apply STAGING migrations, never production, never
// exposing the DB URL. These checks read the committed access template and the workflow and prove
// the identity can read exactly one secret and the workflow targets only staging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

const ACCESS_TEMPLATE = resolve(__dirname, '..', 'access', 'github-migrate-access.yaml');
const WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'connections-migrate-staging.yml');
const PROD_WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'deploy-prisma-migrations.yml');

const REPOSITORY = 'elitemediagroup1/emgloop-platform';
const ENVIRONMENT = 'connections-staging';
const ACCOUNT = '065148797865';
const STAGING_SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:loop/connections/staging/database-url-??????`;

function accessTemplate(): Record<string, any> {
  const app = new App({ analyticsReporting: false });
  const stack = new Stack(app, 'Access', { synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }) });
  new CfnInclude(stack, 'Template', { templateFile: ACCESS_TEMPLATE });
  return Template.fromStack(stack).toJSON();
}

const template = accessTemplate();
const resources = template.Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
const role = resources.GitHubMigrateRole!;

test('the template holds only the migrations role and takes no input', () => {
  assert.deepEqual(Object.entries(resources).map(([id, r]) => [id, r.Type]), [['GitHubMigrateRole', 'AWS::IAM::Role']]);
  assert.equal(template.Parameters, undefined);
  assert.equal(template.Conditions, undefined);
});

test('only the connections-staging environment can assume it', () => {
  assert.equal(role.Properties.RoleName, 'loop-connections-migrate-github');
  assert.equal(role.Properties.ManagedPolicyArns, undefined);
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:environment:${ENVIRONMENT}`,
    },
  });
  assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated, `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`);
});

test('it may read EXACTLY the staging DB URL secret -- nothing else, and never production', () => {
  const stmts = role.Properties.Policies[0].PolicyDocument.Statement;
  assert.equal(stmts.length, 1);
  assert.deepEqual([...stmts[0].Action].sort(), ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
  assert.equal(stmts[0].Resource, STAGING_SECRET_ARN);
  // No other action, no other resource, no wildcard resource.
  const json = JSON.stringify(role.Properties);
  assert.ok(!json.includes('"*"'), 'no wildcard action/resource');
  assert.ok(json.includes('loop/connections/staging/database-url'), 'scoped to the staging DB secret');
  assert.ok(!/production|prod\//i.test(json), 'never references a production secret');
  // The only wildcard is the 6-char Secrets Manager suffix, not a broad match over other secrets.
  assert.ok(STAGING_SECRET_ARN.endsWith('database-url-??????'));
  assert.ok(!STAGING_SECRET_ARN.includes('*'));
});

test('no wildcard, negation or placeholder anywhere in the identity', () => {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(resources);
  walk(template.Outputs);
  for (const s of strings) {
    assert.doesNotMatch(s, /[*]/, `wildcard in ${s}`); // '?' is allowed only in the SM suffix, tested above
    assert.doesNotMatch(s, /\$\{|<|>/, `placeholder in ${s}`);
  }
  assert.ok(!JSON.stringify(resources).includes('"Deny"'));
});

test('the workflow is manual, staging-scoped, OIDC-only, and never touches production or prints the URL', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, new RegExp(`^    environment: ${ENVIRONMENT}$`, 'm'));
  assert.match(code, /^  id-token: write$/m);

  // OIDC, pinned action, staging account/region, the migrate role.
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned v6.3.0');
  assert.match(code, /role-to-assume: \$\{\{ vars\.CONNECTIONS_STAGING_MIGRATE_ROLE_ARN \}\}/);
  assert.match(code, /allowed-account-ids: '065148797865'/);
  assert.match(code, /aws-region: us-east-1/);

  // Reads ONLY the staging secret; never the production migration secret; no GitHub DB secret.
  assert.match(code, /STAGING_DB_SECRET: 'loop\/connections\/staging\/database-url'/);
  assert.doesNotMatch(code, /DIRECT_DATABASE_URL/, 'must not touch the production migration secret');
  assert.doesNotMatch(code, /secrets\.[A-Z_]*DATABASE_URL/, 'must not read a GitHub DB secret');

  // The URL is masked and never echoed.
  assert.match(code, /::add-mask::\$url/);
  assert.doesNotMatch(code, /echo\s+"?\$\{?DATABASE_URL/, 'must not echo DATABASE_URL');
  assert.doesNotMatch(code, /echo\s+"?\$url"?\s*$/m, 'must not echo the raw URL');

  // Applies migrations, gated on the confirmation text.
  assert.match(code, /prisma@5\.22\.0 migrate deploy/);
  assert.match(code, /inputs\.confirm != 'migrate loop-connections-staging'/);

  // Production migration workflow is untouched (still its own secret, still production).
  const prod = readFileSync(PROD_WORKFLOW, 'utf8');
  assert.match(prod, /DATABASE_URL: \$\{\{ secrets\.DIRECT_DATABASE_URL \}\}/, 'production workflow unchanged');
});
