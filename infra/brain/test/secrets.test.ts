// Secret references, never secret values. Slice B6.
//
// The stack may define a secret RESOURCE (its name, its key, who may read it) and a
// placeholder or AWS-generated value. The actual values (provider keys, Neon URLs, private
// keys, tokens) are written in AWS by an operator after deployment and never appear in
// source, CDK context, the template, its outputs, the function environment or a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';

import { buildBrainApp } from '../lib/app';
import { BRAIN_FUNCTIONS } from '../scripts/bundle';

const ROOT = resolve(__dirname, '..');

function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-assets-'));
  for (const f of BRAIN_FUNCTIONS) {
    mkdirSync(join(dir, f.name));
    writeFileSync(join(dir, f.name, 'index.js'), 'exports.handler = async () => ({});');
  }
  return dir;
}

const template = Template.fromStack(buildBrainApp({ assetsDir: stubAssets() }).stack).toJSON();
const resources = Object.entries(template.Resources as Record<string, { Type: string; Properties?: any }>);
const text = JSON.stringify(template);

// Shapes of real credentials. Written as sources so this file does not match itself.
const CREDENTIAL_SHAPES: RegExp[] = [
  new RegExp('sk-' + 'ant-'),
  new RegExp('sk-' + '(proj|svcacct|admin)-'),
  new RegExp('\\bsk-' + '[A-Za-z0-9]{32,}'),
  new RegExp('postgres(ql)?://[^/\\s"\'@]+:[^/\\s"\'@]+@'),
  new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY'),
  new RegExp('\\b(AKIA|ASIA)' + '[0-9A-Z]{16}\\b'),
  new RegExp('aws_secret_access' + '_key[\'"]?\\s*[=:]\\s*[\'"]?[A-Za-z0-9/+=]{40}', 'i'),
  new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{30,}'),
  new RegExp('\\bxox[abprs]-' + '[A-Za-z0-9-]{10,}'),
  new RegExp('\\beyJ[A-Za-z0-9_-]{10,}\\.' + 'eyJ[A-Za-z0-9_-]{10,}'),
];

test('no secret value is in the template: only generated or placeholder contents', () => {
  assert.doesNotMatch(text, /"SecretString"/, 'no literal SecretString');
  assert.doesNotMatch(text, /\{\{resolve:(secretsmanager|ssm-secure)/, 'no dynamic secret reference is resolved into any property');
  assert.equal(resources.filter(([, r]) => r.Type === 'AWS::SecretsManager::SecretTargetAttachment' || r.Type === 'AWS::SecretsManager::RotationSchedule').length, 0);
  const secrets = Object.fromEntries(resources.filter(([, r]) => r.Type === 'AWS::SecretsManager::Secret').map(([, r]) => [r.Properties.Name, r.Properties.GenerateSecretString]));
  const placeholder = { SecretStringTemplate: '{"state":"UNSET"}', GenerateStringKey: 'placeholder', ExcludePunctuation: true };
  assert.deepEqual(secrets, {
    'loop/brain/staging/anthropic': placeholder,
    'loop/brain/staging/openai': placeholder,
    'loop/brain/staging/neon-worker': placeholder,
    'loop/brain/staging/neon-dispatcher': placeholder,
    'loop/brain/staging/neon-sweeper': placeholder,
    'loop/brain/staging/checkpoint-key': { PasswordLength: 64, ExcludePunctuation: true },
  });
  for (const [, r] of resources.filter(([, r]) => r.Type === 'AWS::SSM::Parameter')) {
    assert.equal(r.Properties.Type, 'String', 'parameters hold public configuration, not secrets');
  }
});

test('outputs carry names and public identifiers only', () => {
  const outputs = template.Outputs as Record<string, { Value: unknown }>;
  assert.deepEqual(Object.keys(outputs).sort(), ['DoorbellUrl', 'ParameterPrefix', 'ProviderSecretNames', 'WorkerSigningKeyArn']);
  const secretIds = resources.filter(([, r]) => r.Type === 'AWS::SecretsManager::Secret').map(([id]) => id);
  for (const [name, o] of Object.entries(outputs)) {
    for (const id of secretIds) assert.ok(!JSON.stringify(o.Value).includes(id), `${name} does not reference ${id}`);
  }
  assert.equal(outputs.ProviderSecretNames!.Value, 'loop/brain/staging/anthropic,loop/brain/staging/openai');
  assert.deepEqual(Object.keys(template.Parameters ?? {}), ['BootstrapVersion'], 'no deploy-time parameter can carry a value');
});

test('functions receive secret names or ARNs, never secret contents', () => {
  for (const [id, r] of resources.filter(([, r]) => r.Type === 'AWS::Lambda::Function')) {
    for (const [key, value] of Object.entries(r.Properties.Environment.Variables as Record<string, unknown>)) {
      if (typeof value === 'string') {
        assert.ok(value.length < 200, `${id}.${key} is short configuration`);
        for (const shape of CREDENTIAL_SHAPES) assert.doesNotMatch(value, shape, `${id}.${key}`);
      } else {
        // A reference to another resource (its ARN, name or URL), resolved by CloudFormation.
        assert.match(JSON.stringify(value), /^\{"(Ref|Fn::GetAtt|Fn::Join|Fn::Select|Fn::Split)"/, `${id}.${key}`);
      }
    }
  }
});

test('no credential-shaped literal in the template, the CDK context or any tracked file', () => {
  const self = 'test/secrets.test.ts';
  // Committed and not-yet-committed files alike, so a secret is caught before it is committed.
  // Regular files only: a symlink (say, to a shared node_modules) is not content.
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT })
    .toString()
    .split('\n')
    .filter((f) => f && f !== self && f !== 'package-lock.json' && lstatSync(join(ROOT, f), { throwIfNoEntry: false })?.isFile());
  assert.ok(tracked.includes('cdk.json') && tracked.includes('lib/brain-stack.ts'));
  const corpus: [string, string][] = [['template', text], ...tracked.map((f): [string, string] => [f, readFileSync(join(ROOT, f), 'utf8')])];
  for (const [where, body] of corpus) {
    for (const shape of CREDENTIAL_SHAPES) assert.doesNotMatch(body, shape, `${where} matches ${shape}`);
  }
  assert.ok(!tracked.some((f) => /(^|\/)\.env/.test(f) || f.endsWith('.env') || f === 'cdk.context.json'), 'no environment or context file is committed');
});
