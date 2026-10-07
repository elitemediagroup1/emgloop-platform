// The CRM outreach import's private production source area and its ONE GitHub identity (CRM slice 5,
// PR B). These checks render the committed template the way CloudFormation would and prove:
//   - the bucket is private (every public-access block, no ACLs), encrypted, versioned, TLS-only,
//     retained on deletion, with the conservative lifecycle;
//   - the role is assumable ONLY by the connections-production environment of this repository;
//   - it may read sources and configs and write review artifacts in that bucket -- nothing else:
//     no list, no delete, no other bucket, no secret, no database, no deploy, no migration;
//   - the deploy and migrate identities are untouched and gain no S3 authority;
//   - the import workflow runs only from main, in connections-production, and never offers APPLY.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { includeTemplate, keys, render, strings } from './access-render';

const ROOT = resolve(__dirname, '..', '..', '..');
const TEMPLATE = resolve(__dirname, '..', 'access', 'crm-import-source-access.yaml');
const WORKFLOW = resolve(ROOT, '.github', 'workflows', 'crm-outreach-import.yml');
const ACCOUNT = '123456789012'; // a dummy for rendering; the workflow pins the real one (080891698678)
const BUCKET = `loop-crm-import-${ACCOUNT}`;

const rendered = render(includeTemplate(TEMPLATE), 'production', ACCOUNT);
const R = rendered.Resources;

test('exactly three resources: the bucket, its policy and the one role', () => {
  assert.deepEqual(
    Object.entries(R).map(([k, v]) => [k, v.Type]).sort(),
    [['CrmImportBucket', 'AWS::S3::Bucket'], ['CrmImportBucketPolicy', 'AWS::S3::BucketPolicy'], ['GitHubCrmImportRole', 'AWS::IAM::Role']],
  );
  const raw = includeTemplate(TEMPLATE);
  assert.equal(raw.Parameters, undefined, 'production only: no parameter, so it cannot be pointed anywhere else');
});

test('the bucket: private, owner-enforced, encrypted, versioned, retained, with the conservative lifecycle', () => {
  const raw = includeTemplate(TEMPLATE).Resources.CrmImportBucket;
  assert.deepEqual([raw.DeletionPolicy, raw.UpdateReplacePolicy], ['Retain', 'Retain']);
  const p = R.CrmImportBucket!.Properties;
  assert.equal(p.BucketName, BUCKET);
  assert.deepEqual(p.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.deepEqual(p.OwnershipControls, { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, 'no ACLs at all');
  assert.deepEqual(p.BucketEncryption, { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] });
  assert.deepEqual(p.VersioningConfiguration, { Status: 'Enabled' });
  assert.equal(p.WebsiteConfiguration, undefined, 'never a website');
  assert.equal(p.CorsConfiguration, undefined, 'never read from a browser');
  assert.equal(p.AccessControl, undefined);
  const rules = p.LifecycleConfiguration.Rules as Record<string, any>[];
  const rule = (id: string) => rules.find((r) => r.Id === id);
  assert.deepEqual([rule('source-noncurrent-versions-90-days')?.Prefix, rule('source-noncurrent-versions-90-days')?.NoncurrentVersionExpiration], ['crm-import/source/', { NoncurrentDays: 90 }]);
  assert.equal(rule('source-noncurrent-versions-90-days')?.ExpirationInDays, undefined, 'the current source is kept until a person deletes it');
  assert.deepEqual([rule('config-noncurrent-versions-90-days')?.Prefix, rule('config-noncurrent-versions-90-days')?.NoncurrentVersionExpiration], ['crm-import/config/', { NoncurrentDays: 90 }]);
  assert.deepEqual([rule('review-artifacts-90-days')?.Prefix, rule('review-artifacts-90-days')?.ExpirationInDays], ['crm-import/review/', 90]);
  assert.deepEqual(rule('abort-incomplete-multipart-uploads')?.AbortIncompleteMultipartUpload, { DaysAfterInitiation: 1 });
  for (const r of rules) assert.equal(r.Status, 'Enabled');
});

test('the bucket policy denies any request without TLS, and grants nothing', () => {
  const doc = R.CrmImportBucketPolicy!.Properties.PolicyDocument;
  assert.equal(R.CrmImportBucketPolicy!.Properties.Bucket, BUCKET);
  assert.deepEqual(doc.Statement, [
    {
      Sid: 'DenyInsecureTransport',
      Effect: 'Deny',
      Principal: '*',
      Action: 's3:*',
      Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ]);
});

test('the role: only the connections-production environment of this repository may assume it', () => {
  const p = R.GitHubCrmImportRole!.Properties;
  assert.equal(p.RoleName, 'loop-crm-import-github-production');
  assert.equal(p.MaxSessionDuration, 3600);
  assert.deepEqual(p.AssumeRolePolicyDocument, {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ConnectionsProductionEnvironmentOnly',
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:elitemediagroup1/emgloop-platform:environment:connections-production',
          },
        },
      },
    ],
  });
  assert.equal(keys(p.AssumeRolePolicyDocument).includes('StringLike'), false, 'no wildcard subject');
});

test('the role reads sources and configs, writes review artifacts, and can do nothing else', () => {
  const statements = (R.GitHubCrmImportRole!.Properties.Policies as { PolicyDocument: { Statement: Record<string, any>[] } }[]).flatMap((p) => p.PolicyDocument.Statement);
  assert.deepEqual(
    statements.map((s) => [s.Effect, s.Action, s.Resource]),
    [
      ['Allow', ['s3:GetObject', 's3:GetObjectVersion'], [`arn:aws:s3:::${BUCKET}/crm-import/source/*`, `arn:aws:s3:::${BUCKET}/crm-import/config/*`]],
      ['Allow', ['s3:PutObject'], [`arn:aws:s3:::${BUCKET}/crm-import/review/*`]],
    ],
  );
  const all = strings(statements);
  for (const forbidden of ['s3:*', 's3:ListBucket', 's3:DeleteObject', 's3:PutObjectAcl', 's3:PutBucketPolicy', 'secretsmanager', 'rds', 'iam:', 'sts:', 'cloudformation', 'kms:']) {
    assert.equal(all.some((s) => s.includes(forbidden)), false, `no ${forbidden}`);
  }
  assert.equal(all.some((s) => s === '*' || /:::\*|:\*$/.test(s)), false, 'no account- or service-wide resource');
  assert.equal(keys(statements).includes('NotAction') || keys(statements).includes('NotResource'), false);
});

test('the deploy and migrate identities are untouched and hold no S3 authority', () => {
  for (const file of ['github-deploy-access.yaml', 'github-migrate-access.yaml']) {
    const text = readFileSync(resolve(__dirname, '..', 'access', file), 'utf8');
    assert.equal(/crm-import|s3:/i.test(text), false, `${file} gains no import or S3 authority`);
  }
});

test('the workflow: main only, connections-production only, the production account pinned, never APPLY', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  assert.match(wf, /^on:\n  workflow_dispatch:/m, 'dispatched by a person only');
  assert.doesNotMatch(wf, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /environment: connections-production/);
  assert.match(wf, /PRODUCTION_ACCOUNT: '080891698678'/);
  assert.match(wf, /allowed-account-ids: \$\{\{ env\.PRODUCTION_ACCOUNT \}\}/);
  const modes = wf.slice(wf.indexOf('mode:'), wf.indexOf('source_key:'));
  assert.deepEqual([...modes.matchAll(/^\s+- ([a-z-]+)$/gm)].map((m) => m[1]), ['validate', 'inventory', 'record-config', 'dry-run']);
  assert.doesNotMatch(wf, /\b(apply|approve|abandon)\s+--/, 'no import execution, approval or abandon is ever invoked');
  assert.doesNotMatch(wf, /executionTarget|LOCAL_TEST/);
});
