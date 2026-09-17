// Where the stack can go, and what the CLI will need there first. Slice B6.
//
// Synthesis only: nothing here reads credentials or calls AWS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENTLY_RECOMMENDED_FLAGS } from 'aws-cdk-lib/cx-api';

import { CDK_JSON, buildBrainApp } from '../lib/app';
import { BRAIN_STAGING_TARGET, WrongTargetError, assertStagingCredentials } from '../lib/target';
import { BRAIN_FUNCTIONS } from '../scripts/bundle';

function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-assets-'));
  for (const f of BRAIN_FUNCTIONS) {
    mkdirSync(join(dir, f.name));
    writeFileSync(join(dir, f.name, 'index.js'), `exports.handler = async () => (${JSON.stringify({ stub: f.name })});`);
  }
  return dir;
}

test('the stack is pinned to Loop Brain Staging, not to whichever credentials are active', () => {
  assert.deepEqual({ ...BRAIN_STAGING_TARGET }, {
    accountName: 'Loop Brain Staging',
    account: '065148797865',
    region: 'us-east-1',
    stackName: 'LoopBrain-staging',
    stage: 'staging',
    bootstrapQualifier: 'hnb659fds',
  });
  for (const credentialAccount of [undefined, '065148797865']) {
    const { stack } = buildBrainApp({ assetsDir: stubAssets(), credentialAccount });
    assert.equal(stack.account, '065148797865');
    assert.equal(stack.region, 'us-east-1');
    assert.equal(stack.stackName, 'LoopBrain-staging');
    assert.equal(stack.terminationProtection, true);
  }
});

test('credentials for any other account are refused before anything is built', () => {
  assert.doesNotThrow(() => assertStagingCredentials(undefined), 'synthesis needs no credentials');
  assert.doesNotThrow(() => assertStagingCredentials(''));
  assert.doesNotThrow(() => assertStagingCredentials('065148797865'));
  for (const other of ['111111111111', '065148797866', ' 065148797865', '65148797865']) {
    assert.throws(() => assertStagingCredentials(other), WrongTargetError, other);
    assert.throws(() => buildBrainApp({ assetsDir: stubAssets(), credentialAccount: other }), /Refusing: the active AWS credentials are for account/);
  }
});

test('the CLI entry point passes the active credentials to the guard', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'bin', 'brain.ts')], {
    env: { PATH: process.env.PATH, CDK_DEFAULT_ACCOUNT: '111111111111', CDK_OUTDIR: mkdtempSync(join(tmpdir(), 'brain-refused-')) },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Refusing: the active AWS credentials are for account 111111111111, not Loop Brain Staging \(065148797865\)/);
});

test('only the staging stage builds', () => {
  for (const stage of ['production', 'prod', '', 'Staging']) {
    assert.throws(() => buildBrainApp({ assetsDir: stubAssets(), context: { stage } }), /staging environment only/, JSON.stringify(stage));
  }
});

test('cdk.json pins the stage and every currently recommended feature flag, and nothing else', () => {
  const json = JSON.parse(readFileSync(CDK_JSON, 'utf8'));
  assert.deepEqual(Object.keys(json).sort(), ['app', 'cli-telemetry', 'context']);
  assert.equal(json.app, 'npx tsx bin/brain.ts');
  assert.equal(json['cli-telemetry'], false);
  const { stage, '@aws-cdk/core:enableAdditionalMetadataCollection': metadata, ...flags } = json.context;
  assert.equal(stage, 'staging');
  // The one departure from the recommendation: no construct metadata is sent with the template.
  assert.equal(metadata, false);
  assert.equal(CURRENTLY_RECOMMENDED_FLAGS['@aws-cdk/core:enableAdditionalMetadataCollection' as keyof typeof CURRENTLY_RECOMMENDED_FLAGS], true);
  const { '@aws-cdk/core:enableAdditionalMetadataCollection': _recommended, ...recommended } = CURRENTLY_RECOMMENDED_FLAGS as Record<string, unknown>;
  assert.deepEqual(flags, recommended, 'flags are fixed before the first deploy, not changed under a live stack');
});

test('the cloud assembly needs the default bootstrap in 065148797865 / us-east-1, and no container registry', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'brain-cdk-out-'));
  buildBrainApp({ assetsDir: stubAssets(), outdir }).app.synth();
  const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
  const stack = manifest.artifacts['LoopBrain-staging'];
  assert.equal(stack.environment, 'aws://065148797865/us-east-1');
  const role = (name: string) => `arn:\${AWS::Partition}:iam::065148797865:role/cdk-hnb659fds-${name}-role-065148797865-us-east-1`;
  assert.equal(stack.properties.assumeRoleArn, role('deploy'));
  assert.equal(stack.properties.cloudFormationExecutionRoleArn, role('cfn-exec'));
  assert.equal(stack.properties.requiresBootstrapStackVersion, 6);
  assert.equal(stack.properties.bootstrapStackVersionSsmParameter, '/cdk-bootstrap/hnb659fds/version');
  assert.equal(stack.properties.terminationProtection, true);

  const assets = JSON.parse(readFileSync(join(outdir, 'LoopBrain-staging.assets.json'), 'utf8'));
  assert.deepEqual(assets.dockerImages ?? {}, {}, 'no image assets, so the bootstrap ECR repository stays empty');
  const destinations = Object.values(assets.files as Record<string, { destinations: Record<string, { bucketName: string; assumeRoleArn: string }> }>).flatMap((f) => Object.values(f.destinations));
  assert.equal(destinations.length, BRAIN_FUNCTIONS.length + 1, 'one zip per distinct function bundle, plus the template');
  for (const d of destinations) {
    assert.equal(d.bucketName, 'cdk-hnb659fds-assets-065148797865-us-east-1');
    assert.equal(d.assumeRoleArn, role('file-publishing'));
  }
});
