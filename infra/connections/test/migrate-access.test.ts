// The GitHub MIGRATIONS identity + the staging workflow: apply STAGING migrations, never production,
// never exposing the DB URL. These checks read the committed access template, render it for each
// stage the way CloudFormation would, prove the default renders EXACTLY the staging identity that
// is already deployed, prove the production render reads exactly the production secret and nothing
// of staging's, and prove the staging workflow targets only staging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

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

});

// --- The PRODUCTION migrations workflow (Deploy Prisma Migrations) -----------------------------

const PRODUCTION_ACCOUNT_PIN = '080891698678';

test('the production migrations workflow is manual, environment-gated, OIDC-only through the production migrate role, and reads exactly the production DB secret', () => {
  const workflow = readFileSync(PROD_WORKFLOW, 'utf8');
  const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  assert.match(code, /^name: Deploy Prisma Migrations$/m, 'the name every runbook and the constitution cite');
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m);
  assert.match(code, /^    environment: connections-production$/m, 'the environment is part of the OIDC trust');
  assert.match(code, /^  id-token: write$/m);
  assert.match(code, /^  contents: read$/m);

  // The production account is pinned, the environment variable must agree, and the role must live there.
  assert.match(code, new RegExp(`^      PRODUCTION_ACCOUNT: '${PRODUCTION_ACCOUNT_PIN}'$`, 'm'));
  assert.match(code, /^      PRODUCTION_ACCOUNT_ID_VAR: \$\{\{ vars\.CONNECTIONS_PRODUCTION_ACCOUNT_ID \}\}$/m);
  assert.match(code, /^      MIGRATE_ROLE_ARN: \$\{\{ vars\.CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN \}\}$/m);
  assert.deepEqual([...new Set([...code.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['CONNECTIONS_PRODUCTION_ACCOUNT_ID', 'CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN']);
  assert.match(code, /if \[ "\$\{account_var\}" != "\$\{PRODUCTION_ACCOUNT\}" \]; then/);
  assert.match(code, /"arn:aws:iam::\$\{PRODUCTION_ACCOUNT\}:role\/"\?\*\) ;;/);

  // OIDC, pinned action, bounded to the pinned account, then STS-checked against it.
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned v6.3.0');
  assert.match(code, /role-to-assume: \$\{\{ steps\.guard\.outputs\.role_arn \}\}/, 'the role the guard step validated');
  assert.match(code, new RegExp(`allowed-account-ids: '${PRODUCTION_ACCOUNT_PIN}'`));
  assert.match(code, /aws-region: us-east-1/);
  assert.match(code, /account="\$\(aws sts get-caller-identity --query Account --output text\)"\n\s+if \[ "\$account" != "\$PRODUCTION_ACCOUNT" \]; then/);

  // Reads ONLY the production secret, through the role; never a GitHub secret; never a staging name.
  assert.match(code, /PRODUCTION_DB_SECRET: 'loop\/connections\/production\/database-url'/);
  assert.doesNotMatch(code, /secrets\./, 'no GitHub secret at all -- DIRECT_DATABASE_URL is no longer a migration path');
  assert.doesNotMatch(code, /DIRECT_DATABASE_URL/);
  assert.doesNotMatch(code, /staging|065148797865/, 'never a staging name or account');

  // The URL is masked and never echoed.
  assert.match(code, /::add-mask::\$url/);
  assert.doesNotMatch(code, /echo\s+"?\$\{?DATABASE_URL/, 'must not echo DATABASE_URL');
  assert.doesNotMatch(code, /echo\s+"?\$url"?\s*$/m, 'must not echo the raw URL');
  assert.doesNotMatch(code, /\$\{\{[^}]*inputs\.confirm/, 'the typed phrase is never read through the expression context');

  // Order: confirm, guard, credentials, STS check, secret, validate, status, deploy, status.
  const order = ['- name: Confirm', 'The environment names the production account', 'AWS credentials (OIDC, short-lived)', 'The credentials are for the production account', 'Read the production DATABASE_URL', 'prisma@5.22.0 validate', 'Migration status before', 'prisma@5.22.0 migrate deploy', 'Migration status after'];
  const positions = order.map((needle) => code.indexOf(needle));
  assert.ok(positions.every((p) => p >= 0), `every step present: ${positions.join(',')}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'steps run in this order');
});

/** The `run: |` body of the named step of a workflow, dedented. */
function stepScript(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the workflow has a step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

test('the production Confirm step, executed, requires the production phrase and forgives only padding and case', () => {
  const script = stepScript(readFileSync(PROD_WORKFLOW, 'utf8'), 'Confirm');
  const dir = mkdtempSync(join(tmpdir(), 'prisma-migrations-confirm-'));
  const attempt = (confirm: string) => {
    const event = join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ inputs: { confirm } }));
    return spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event }, encoding: 'utf8' });
  };
  assert.equal(attempt('migrate loop-connections-production').status, 0, 'the exact phrase');
  assert.equal(attempt('   migrate loop-connections-production\u00a0\r\n').status, 0, 'padding, NBSP and CR are forgiven');
  assert.equal(attempt('Migrate  Loop-Connections-Production').status, 0, 'case and repeated inner whitespace are forgiven');
  const staging = attempt('migrate loop-connections-staging');
  assert.equal(staging.status, 1, 'the staging phrase never migrates production');
  assert.match(staging.stdout, /Confirmation text required: migrate loop-connections-production/);
  assert.match(staging.stdout, /Received \d+ bytes; with whitespace made visible:/);
  assert.equal(attempt('').status, 1, 'an empty phrase refuses');
  assert.equal(attempt('deploy loop-connections-production').status, 1, 'the deploy phrase is not the migrate phrase');
  assert.equal(attempt('migrate loop-connections-productionx').status, 1, 'a superstring refuses');
});

test('the production guard step, executed, refuses a wrong account variable or a role outside the pinned account before any credential', () => {
  const script = stepScript(readFileSync(PROD_WORKFLOW, 'utf8'), 'The environment names the production account, and the migrate role lives in it');
  const dir = mkdtempSync(join(tmpdir(), 'prisma-migrations-guard-'));
  const attempt = (accountVar: string, role: string) => {
    const envFile = join(dir, 'env');
    const outFile = join(dir, 'out');
    writeFileSync(envFile, '');
    writeFileSync(outFile, '');
    const r = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', PRODUCTION_ACCOUNT: PRODUCTION_ACCOUNT_PIN, PRODUCTION_ACCOUNT_ID_VAR: accountVar, MIGRATE_ROLE_ARN: role, GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, out: readFileSync(outFile, 'utf8') };
  };
  const good = `arn:aws:iam::${PRODUCTION_ACCOUNT_PIN}:role/loop-connections-migrate-github-production`;
  const ok = attempt(PRODUCTION_ACCOUNT_PIN, good);
  assert.equal(ok.status, 0);
  assert.equal(ok.out.trim(), `role_arn=${good}`, 'the validated role is what the credential step assumes');
  assert.equal(attempt(` ${PRODUCTION_ACCOUNT_PIN} `, ` ${good} `).status, 0, 'surrounding whitespace on a variable is trimmed');
  assert.equal(attempt('', good).status, 1, 'an unset account variable refuses');
  assert.equal(attempt('065148797865', good).status, 1, 'the staging account refuses');
  assert.equal(attempt('670682108352', good).status, 1, 'the management account refuses');
  assert.equal(attempt(PRODUCTION_ACCOUNT_PIN, 'arn:aws:iam::065148797865:role/loop-connections-migrate-github').status, 1, 'a role in another account refuses');
  assert.equal(attempt(PRODUCTION_ACCOUNT_PIN, '').status, 1, 'an unset role refuses');
  assert.equal(attempt(PRODUCTION_ACCOUNT_PIN, `arn:aws:iam::${PRODUCTION_ACCOUNT_PIN}:role/`).status, 1, 'an empty role name refuses');
});
