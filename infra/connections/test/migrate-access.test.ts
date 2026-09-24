// The GitHub MIGRATIONS identity + the staging workflow: apply STAGING migrations, never production,
// never exposing the DB URL. These checks read the committed access template, render it for each
// stage the way CloudFormation would, prove the default renders EXACTLY the staging identity that
// is already deployed, prove the production render reads exactly the production secret and nothing
// of staging's, and prove the staging workflow targets only staging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertStageIsTheOnlyInput, includeTemplate, render, strings } from './access-render';

const ACCESS_TEMPLATE = resolve(__dirname, '..', 'access', 'github-migrate-access.yaml');
const WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'connections-migrate-staging.yml');
const PROD_WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'deploy-prisma-migrations.yml');

const REPOSITORY = 'elitemediagroup1/emgloop-platform';
const STAGING_ACCOUNT = '065148797865';
const PRODUCTION_ACCOUNT = '123456789012'; // a dummy: the real one is not created yet and never in source
const secretArn = (account: string, stage: string) => `arn:aws:secretsmanager:us-east-1:${account}:secret:loop/connections/${stage}/database-url-??????`;

const template = includeTemplate(ACCESS_TEMPLATE);
const staging = render(template, 'staging', STAGING_ACCOUNT);
const production = render(template, 'production', PRODUCTION_ACCOUNT);

/** The migrations identity a stage holds, in full. */
function expectedRole(stage: 'staging' | 'production', account: string, roleName: string, sid: string, policySid: string) {
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: roleName,
      Description: `GitHub Actions (connections-${stage} environment) reads ONLY the ${stage} connections DB URL secret to run prisma migrate deploy.`,
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: sid,
            Effect: 'Allow',
            Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:environment:connections-${stage}`,
              },
            },
          },
        ],
      },
      Policies: [
        {
          PolicyName: `read-${stage}-connections-db-url-only`,
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: policySid,
                Effect: 'Allow',
                Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                Resource: secretArn(account, stage),
              },
            ],
          },
        },
      ],
      Tags: [
        { Key: 'app', Value: 'loop' },
        { Key: 'component', Value: 'connections-migrate-access' },
        { Key: 'env', Value: stage },
      ],
    },
  };
}

test('the template holds only the migrations role and takes ONE input, Stage, staging by default', () => {
  assert.deepEqual(Object.entries(template.Resources).map(([id, r]: [string, any]) => [id, r.Type]), [['GitHubMigrateRole', 'AWS::IAM::Role']]);
  assert.doesNotThrow(() => assertStageIsTheOnlyInput(template));
  assert.throws(() => render(template, 'development', STAGING_ACCOUNT), /unresolvable FindInMap/);
});

test('the default (Stage=staging, in 065148797865) renders EXACTLY the staging identity that is already deployed', () => {
  const { Type, Properties } = staging.Resources.GitHubMigrateRole!;
  assert.deepEqual({ Type, Properties }, expectedRole('staging', STAGING_ACCOUNT, 'loop-connections-migrate-github', 'ConnectionsStagingEnvironmentOnly', 'ReadStagingConnectionsDatabaseUrlOnly'));
  assert.equal(Properties.ManagedPolicyArns, undefined);
  assert.deepEqual(staging.Outputs.MigrateRoleArn!.Value, { 'Fn::GetAtt': 'GitHubMigrateRole.Arn' }); // CfnInclude's string form of !GetAtt
});

test('Stage=production renders its own role, trusting ONLY connections-production and reading EXACTLY the production DB URL secret', () => {
  const { Type, Properties } = production.Resources.GitHubMigrateRole!;
  assert.deepEqual({ Type, Properties }, expectedRole('production', PRODUCTION_ACCOUNT, 'loop-connections-migrate-github-production', 'ConnectionsProductionEnvironmentOnly', 'ReadProductionConnectionsDatabaseUrlOnly'));
});

test('each stage may read EXACTLY its own DB URL secret -- nothing else, and never the other stage\'s', () => {
  for (const [rendered, stage, other] of [[staging, 'staging', 'production'], [production, 'production', 'staging']] as const) {
    const role = rendered.Resources.GitHubMigrateRole!;
    const stmts = role.Properties.Policies[0].PolicyDocument.Statement;
    assert.equal(stmts.length, 1);
    assert.deepEqual([...stmts[0].Action].sort(), ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
    assert.equal(stmts[0].Resource, secretArn(stage === 'staging' ? STAGING_ACCOUNT : PRODUCTION_ACCOUNT, stage));
    const json = JSON.stringify(role.Properties);
    assert.ok(!json.includes('"*"'), 'no wildcard action/resource');
    assert.ok(json.includes(`loop/connections/${stage}/database-url`), `scoped to the ${stage} DB secret`);
    assert.ok(!new RegExp(other, 'i').test(json), `the ${stage} identity never mentions ${other}`);
    // The only wildcard is the 6-char Secrets Manager suffix, not a broad match over other secrets.
    assert.ok((stmts[0].Resource as string).endsWith('database-url-??????'));
    assert.ok(!(stmts[0].Resource as string).includes('*'));
  }
});

test('no wildcard, negation or placeholder anywhere in either rendered identity', () => {
  for (const rendered of [staging, production]) {
    for (const s of strings(rendered.Resources).concat(strings(rendered.Outputs))) {
      assert.doesNotMatch(s, /[*]/, `wildcard in ${s}`); // '?' is allowed only in the SM suffix, tested above
      assert.doesNotMatch(s, /\$\{|<|>/, `placeholder in ${s}`);
    }
    assert.ok(!JSON.stringify(rendered.Resources).includes('"Deny"'));
  }
});

test('the staging migrations workflow is manual, staging-scoped, OIDC-only, and never touches production or prints the URL', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, /^    environment: connections-staging$/m);
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
  assert.doesNotMatch(code, /loop\/connections\/production/, 'never the production connections secret');

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
