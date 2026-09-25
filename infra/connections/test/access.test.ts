// The GitHub deploy identity: who may deploy the connections stack, and what it may touch.
//
// access/github-deploy-access.yaml is deployed once PER STAGE, by hand, in that stage's account,
// outside the connections CDK app. These checks read the committed template, render it for each
// stage the way CloudFormation would (Stage parameter + the deploying account), prove the default
// renders EXACTLY the staging identity that is already deployed, prove the production render trusts
// only the production environment, and compare the roles each may assume with the ones that stage's
// cloud assembly actually asks CDK to assume (plus image-publishing, which the Fargate image asset
// needs and a registry-image synth cannot exercise without Docker). They also read the workflow
// that uses the identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';
import { CONNECTIONS_STAGING_TARGET, productionTarget, type ConnectionsTarget } from '../lib/target';
import { assertStageIsTheOnlyInput, includeTemplate, keys, render, strings } from './access-render';
import { stubAssets } from './assets';

const ACCESS_TEMPLATE = resolve(__dirname, '..', 'access', 'github-deploy-access.yaml');
const DEPLOY_WORKFLOW = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'connections-infra-deploy.yml');

const REPOSITORY = 'elitemediagroup1/emgloop-platform';
// A DUMMY production account: the real one is not created yet and its id is never in source.
const PRODUCTION = productionTarget('123456789012');

const cdkRole = (t: ConnectionsTarget, name: string) => `arn:aws:iam::${t.account}:role/cdk-${t.bootstrapQualifier}-${name}-role-${t.account}-${t.region}`;

const template = includeTemplate(ACCESS_TEMPLATE);
const staging = render(template, 'staging', CONNECTIONS_STAGING_TARGET.account);
const production = render(template, 'production', PRODUCTION.account);

/** The deploy identity a stage holds, in full. */
function expectedRole(t: ConnectionsTarget, roleName: string, sid: string) {
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: roleName,
      Description: `GitHub Actions (connections-${t.stage} environment) deploys ${t.stackName} through the CDK bootstrap roles.`,
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: sid,
            Effect: 'Allow',
            Principal: { Federated: `arn:aws:iam::${t.account}:oidc-provider/token.actions.githubusercontent.com` },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:environment:connections-${t.stage}`,
              },
            },
          },
        ],
      },
      Policies: [
        {
          PolicyName: 'assume-cdk-bootstrap-roles',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'UseCdkBootstrapRolesOnly',
                Effect: 'Allow',
                Action: 'sts:AssumeRole',
                Resource: [cdkRole(t, 'deploy'), cdkRole(t, 'file-publishing'), cdkRole(t, 'image-publishing'), cdkRole(t, 'lookup')],
              },
            ],
          },
        },
      ],
      Tags: [
        { Key: 'app', Value: 'loop' },
        { Key: 'component', Value: 'connections-deploy-access' },
        { Key: 'env', Value: t.stage },
      ],
    },
  };
}

test('the template holds ONLY the deploy role (the OIDC provider already exists) and takes ONE input, Stage, staging by default', () => {
  assert.deepEqual(Object.entries(template.Resources).map(([id, r]: [string, any]) => [id, r.Type]), [['GitHubDeployRole', 'AWS::IAM::Role']]);
  assert.doesNotThrow(() => assertStageIsTheOnlyInput(template));
  // No parameter can widen the trust: Stage picks a row of the mapping, and the account is the
  // one the template is deployed in. There is nothing else to type.
  assert.throws(() => render(template, 'development', CONNECTIONS_STAGING_TARGET.account), /unresolvable FindInMap/);
});

test('the default (Stage=staging, deployed in 065148797865) renders EXACTLY the staging identity that is already deployed', () => {
  const { Type, Properties } = staging.Resources.GitHubDeployRole!;
  assert.deepEqual({ Type, Properties }, expectedRole(CONNECTIONS_STAGING_TARGET, 'loop-connections-github-deploy', 'ConnectionsStagingEnvironmentOnly'));
  assert.equal(Properties.ManagedPolicyArns, undefined, 'no managed policy');
  assert.deepEqual(staging.Outputs.DeployRoleArn!.Value, { 'Fn::GetAtt': 'GitHubDeployRole.Arn' }); // CfnInclude's string form of !GetAtt
});

test('Stage=production renders its own role, trusting ONLY the connections-production environment, over the production account\'s bootstrap roles', () => {
  const { Type, Properties } = production.Resources.GitHubDeployRole!;
  assert.deepEqual({ Type, Properties }, expectedRole(PRODUCTION, 'loop-connections-github-deploy-production', 'ConnectionsProductionEnvironmentOnly'));
  // Neither render can reach the other stage: no staging name in production, no production name in staging.
  const stagingJson = JSON.stringify(staging.Resources);
  const productionJson = JSON.stringify(production.Resources);
  assert.ok(!/production/i.test(stagingJson), 'the staging identity never mentions production');
  assert.ok(!/staging/i.test(productionJson), 'the production identity never mentions staging');
  assert.ok(!productionJson.includes(CONNECTIONS_STAGING_TARGET.account), 'the production identity never names the staging account');
  assert.ok(!productionJson.includes('670682108352'), 'the production identity never names the management account');
});

test('for each stage, the non-image roles are exactly the ones its stack deployment asks CDK to assume; image-publishing covers the Fargate image', () => {
  const image = ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');
  const literal = (arn: string) => arn.replace('${AWS::Partition}', 'aws');
  const cases: Array<[ConnectionsTarget, Record<string, unknown>, ReturnType<typeof render>]> = [
    [CONNECTIONS_STAGING_TARGET, {}, staging],
    [PRODUCTION, { stage: 'production', productionAccount: PRODUCTION.account, alertEmail: 'alerts@example.invalid' }, production],
  ];
  for (const [target, context, rendered] of cases) {
    const outdir = mkdtempSync(join(tmpdir(), 'connections-cdk-out-'));
    buildConnectionsApp({ image, assetsDir: stubAssets(), outdir, context }).app.synth();
    const stack = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')).artifacts[target.stackName];
    assert.ok(stack, `${target.stackName} is in the cloud assembly`);
    const published = JSON.parse(readFileSync(join(outdir, `${target.stackName}.assets.json`), 'utf8'));
    const needed = new Set<string>([
      literal(stack.properties.assumeRoleArn),
      literal(stack.properties.lookupRole.arn),
      ...Object.values(published.files as Record<string, { destinations: Record<string, { assumeRoleArn: string }> }>)
        .flatMap((f) => Object.values(f.destinations))
        .map((d) => literal(d.assumeRoleArn)),
    ]);
    const granted = new Set<string>(rendered.Resources.GitHubDeployRole!.Properties.Policies[0].PolicyDocument.Statement[0].Resource as string[]);
    // Everything the (registry-image) synth needs is granted.
    for (const arn of needed) assert.ok(granted.has(arn), `${target.stage}: deploy needs ${arn} but the role cannot assume it`);
    // deploy + file-publishing + lookup are actually exercised; image-publishing is additionally
    // granted for the container image the real (Dockerfile) deploy publishes.
    assert.ok(needed.has(cdkRole(target, 'deploy')) && needed.has(cdkRole(target, 'file-publishing')) && needed.has(cdkRole(target, 'lookup')));
    assert.ok(granted.has(cdkRole(target, 'image-publishing')), 'the Fargate image asset requires image-publishing');
    assert.equal(granted.size, 4, 'nothing beyond the four bootstrap roles');
  }
});

test('no wildcard, negation or unresolved placeholder anywhere in either rendered identity', () => {
  for (const rendered of [staging, production]) {
    for (const s of strings(rendered.Resources).concat(strings(rendered.Outputs))) {
      assert.doesNotMatch(s, /[*?]/, `wildcard in ${s}`);
      assert.doesNotMatch(s, /\$\{|<|>/, `placeholder in ${s}`);
    }
    for (const k of keys(rendered.Resources)) {
      assert.doesNotMatch(k, /^Not(Action|Resource|Principal)$|Like$|^ForAnyValue|^ForAllValues/, `broadening operator ${k}`);
    }
    assert.ok(!JSON.stringify(rendered.Resources).includes('"Deny"'), 'nothing relies on a deny to stay narrow');
  }
});

test('the deploy workflow: manual, one stage per run, environment and confirmation follow the stage, AWS reached only through the stage\'s identity in the stage\'s account', () => {
  const workflow = readFileSync(DEPLOY_WORKFLOW, 'utf8');
  const code = workflow.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  // The stage input admits exactly the two stages and defaults to staging.
  assert.match(code, /^      stage:\n/m);
  assert.match(code, /^        options: \[staging, production\]\n        default: staging$/m);
  // The GitHub environment -- part of the OIDC trust -- and the stack name follow the stage.
  assert.match(code, /^    environment: connections-\$\{\{ inputs\.stage \}\}$/m);
  assert.match(code, /^      STACK_NAME: LoopConnections-\$\{\{ inputs\.stage \}\}$/m);
  assert.match(code, /^  id-token: write$/m);
  assert.doesNotMatch(code, /secrets\./, 'no AWS secret in GitHub');
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned to the v6.3.0 commit');

  // The known accounts are literals; the production id is a variable and is NEVER a literal.
  assert.match(code, /^      STAGING_ACCOUNT: '065148797865'$/m);
  assert.match(code, /^      MANAGEMENT_ACCOUNT: '670682108352'$/m);
  assert.match(code, /^      PRODUCTION_ACCOUNT_ID: \$\{\{ vars\.CONNECTIONS_PRODUCTION_ACCOUNT_ID \}\}$/m);
  // Exactly these GitHub variables, all stage-named; nothing else is read.
  assert.deepEqual([...new Set([...code.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), [
    'CONNECTIONS_PRODUCTION_ACCOUNT_ID',
    'CONNECTIONS_PRODUCTION_AI_ORG_ID',
    'CONNECTIONS_PRODUCTION_AI_PROVIDERS',
    'CONNECTIONS_PRODUCTION_AI_TASKS',
    'CONNECTIONS_PRODUCTION_ALERT_EMAIL',
    'CONNECTIONS_PRODUCTION_DEPLOY_ROLE_ARN',
    'CONNECTIONS_STAGING_AI_ORG_ID',
    'CONNECTIONS_STAGING_AI_PROVIDERS',
    'CONNECTIONS_STAGING_AI_TASKS',
    'CONNECTIONS_STAGING_ALERT_EMAIL',
    'CONNECTIONS_STAGING_DEPLOY_ROLE_ARN',
  ]);

  // The resolve step fails closed: 12 digits; production is never the staging or management
  // account; production needs the alert address. The values are picked by STAGE, never by which
  // variable happens to be set.
  assert.match(code, /case "\$STAGE" in\n\s+staging\)/);
  assert.match(code, /if ! \[\[ "\$account" =~ \^\[0-9\]\{12\}\$ \]\]; then/);
  assert.match(code, /\[ "\$account" = "\$STAGING_ACCOUNT" \] \|\| \[ "\$account" = "\$MANAGEMENT_ACCOUNT" \]/);
  assert.match(code, /if \[ -z "\$alert_email" \]; then\n\s+echo "Refusing: CONNECTIONS_PRODUCTION_ALERT_EMAIL is unset/);
  assert.match(code, /\*\) echo "Refusing: unknown stage/);
  // The AI provider and task lists are resolved by STAGE exactly like the AI organization id,
  // trimmed, whitespace-refused, and handed to the CDK steps (empty = the app's default).
  for (const [stage, prefix] of [['staging', 'STAGING'], ['production', 'PRODUCTION']] as const) {
    for (const [name, local] of [['AI_PROVIDERS', 'ai_providers'], ['AI_TASKS', 'ai_tasks']] as const) {
      assert.ok(code.includes(`      ${prefix}_${name}: \${{ vars.CONNECTIONS_${prefix}_${name} }}`), `${prefix}_${name} comes from its ${stage} variable`);
      assert.ok(code.includes(`${local}="$(trim "$${prefix}_${name}")"`), `${stage} resolves ${local} from ${prefix}_${name}`);
    }
  }
  assert.ok(code.includes('for v in "$role" "$alert_email" "$ai_org_id" "$ai_providers" "$ai_tasks"; do'));
  assert.ok(code.includes('echo "AI_PROVIDERS=${ai_providers}"') && code.includes('echo "AI_TASKS=${ai_tasks}"'));

  // Credentials: the resolved role, first checked to be in the resolved account; the credentials
  // are bounded to that account and then checked again.
  assert.match(code, /^          role-to-assume: \$\{\{ steps\.resolve\.outputs\.deploy_role_arn \}\}$/m);
  assert.match(code, /^          aws-region: us-east-1$/m);
  assert.match(code, /^          allowed-account-ids: \$\{\{ steps\.resolve\.outputs\.account \}\}$/m);
  assert.match(code, /"arn:aws:iam::\$\{CONNECTIONS_ACCOUNT\}:role\/"\?\*\) ;;/);
  assert.match(code, /account="\$\(aws sts get-caller-identity --query Account --output text\)"\n\s+if \[ "\$account" != "\$CONNECTIONS_ACCOUNT" \]; then/);

  // synth runs before diff, diff before deploy; all three carry the same stage context; deploy is
  // gated on the stage's confirmation text.
  const context = '-c "stage=$STAGE" -c "productionAccount=$PRODUCTION_ACCOUNT" -c "alertEmail=$ALERT_EMAIL" -c "aiOrganizationId=$AI_ORG_ID" -c "aiProviders=$AI_PROVIDERS" -c "aiTasks=$AI_TASKS"';
  for (const verb of ['synth --no-notices', 'diff --no-notices', 'deploy --no-notices --require-approval never']) {
    assert.ok(code.includes(`npx cdk ${verb} "$STACK_NAME" ${context}`), `cdk ${verb} carries the stage context`);
  }
  assert.ok(code.indexOf('npx cdk synth') < code.indexOf('npx cdk diff') && code.indexOf('npx cdk diff') < code.indexOf('npx cdk deploy'));
  // The confirmation is a shell comparison on the event payload (never `inputs.confirm` in an
  // expression, which compares padded bytes and explains nothing -- the seed workflow's scar).
  assert.doesNotMatch(code, /\$\{\{[^}]*inputs\.confirm/, 'the typed phrase is never read through the expression context');
  assert.match(code, /- name: Confirm\n\s+if: \$\{\{ inputs\.action == 'deploy' \}\}\n\s+shell: bash/);
  assert.match(code, /REQUIRED="deploy loop-connections-\$\{STAGE\}"/);
  assert.match(code, /CONFIRM="\$\(jq -r '\.inputs\.confirm \/\/ ""' "\$\{GITHUB_EVENT_PATH\}"\)"/);
  assert.match(code, /if: \$\{\{ inputs\.action == 'deploy' \}\}\n\s+working-directory: infra\/connections\n\s+run: npx cdk deploy/);
});

test('the deploy workflow: the Confirm step, executed, requires the phrase for the stage and forgives only padding and case', () => {
  const workflow = readFileSync(DEPLOY_WORKFLOW, 'utf8');
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: Confirm');
  assert.ok(at >= 0);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'connections-confirm-'));
  const attempt = (stage: string, confirm: string) => {
    const event = join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ inputs: { stage, action: 'deploy', confirm } }));
    return spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', STAGE: stage, GITHUB_EVENT_PATH: event }, encoding: 'utf8' });
  };
  assert.equal(attempt('production', 'deploy loop-connections-production').status, 0, 'the exact phrase');
  assert.equal(attempt('production', '    deploy loop-connections-production\u00a0\r\n').status, 0, 'padding, NBSP and CR are forgiven');
  assert.equal(attempt('production', 'Deploy  Loop-Connections-Production').status, 0, 'case and repeated inner whitespace are forgiven');
  assert.equal(attempt('staging', 'deploy loop-connections-staging').status, 0, 'staging keeps its phrase');
  const wrongStage = attempt('production', 'deploy loop-connections-staging');
  assert.equal(wrongStage.status, 1, 'the staging phrase never deploys production');
  assert.match(wrongStage.stdout, /Confirmation text required: deploy loop-connections-production/);
  assert.match(wrongStage.stdout, /Received \d+ bytes; with whitespace made visible:/);
  assert.equal(attempt('production', '').status, 1, 'an empty phrase refuses');
  assert.equal(attempt('production', 'deploy loop-connections-productionx').status, 1, 'a superstring refuses');
  assert.equal(attempt('production', 'deploy loop connections production').status, 1, 'hyphens are part of the phrase');
});
