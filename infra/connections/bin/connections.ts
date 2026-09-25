// The connections worker deployable's CDK app: staging (the default) or production.
//
//   npm run bundle             # build the media signer bundle into dist/ (synth needs it)
//   npm run synth              # OFFLINE staging synth: bundles, placeholder image, no docker, no AWS -- what PR CI runs
//   npm run synth:production   # OFFLINE production synth with a dummy account and address -- also PR CI
//   npx cdk synth              # deploy-time synth: builds the real worker image asset (docker); run bundle first
//   npx cdk diff               # ONLY with read access to the stage's account
//   npx cdk deploy             # ONLY through connections-infra-deploy.yml, with Matt's authorization
//
// Targets (lib/target.ts): staging is pinned to Loop Brain Staging (065148797865, us-east-1);
// production is the dedicated workload account named by `-c productionAccount=<12 digits>`, and the
// management account is refused. The app refuses credentials for any account but the target's.
//
// CONNECTIONS_SYNTH_OFFLINE=1 substitutes a placeholder registry image so synth is fully offline and
// deterministic (no docker build, no network, no AWS). The real deploy leaves it unset and builds the
// image from apps/connections-worker/Dockerfile. Both synthesize the same stack; only the image ref
// differs, and the real image asset is built and validated in the deploy job.
//
// Context (see lib/app.ts):
//   -c stage=staging|production       which target (cdk.json defaults to staging)
//   -c productionAccount=<12 digits>  production only: the workload account id
//   -c alertEmail=<address>           the budget + alarm recipient; REQUIRED for production
//   -c monthlyBudgetUsd=<whole USD>   the cost ceiling (default 60 staging / 150 production)
//   -c mediaOrigins=https://a,https://b  the browser origins the media bucket answers CORS for
//                                     (default: the stage's web origin)
//   -c aiOrganizationId=<id>          activates AI content triage for that organization
//   -c aiProviders=anthropic,openai   with aiOrganizationId: the providers given a key (default anthropic;
//                                     listing one makes it callable, never approved)
//   -c aiTasks=<task>,<task>          with aiOrganizationId: the tasks run (default telegram.content.triage)

import { join } from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';

const repoRoot = join(__dirname, '..', '..', '..');
const image =
  process.env.CONNECTIONS_SYNTH_OFFLINE === '1'
    ? ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim')
    : ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/connections-worker/Dockerfile' });

const { app } = buildConnectionsApp({
  image,
  assetsDir: join(__dirname, '..', 'dist'),
  credentialAccount: process.env.CDK_DEFAULT_ACCOUNT,
});
app.synth();
