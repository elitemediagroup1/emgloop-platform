// The connections worker deployable's CDK app. Staging only.
//
//   npm run synth    # OFFLINE synth: placeholder image, no docker, no AWS -- what PR CI runs
//   npx cdk synth    # deploy-time synth: builds the real worker image asset (docker)
//   npx cdk diff     # ONLY with read access to Loop Brain Staging
//   npx cdk deploy   # ONLY with Matt's explicit authorization
//
// Pinned to Loop Brain Staging (065148797865, us-east-1): lib/target.ts.
//
// CONNECTIONS_SYNTH_OFFLINE=1 substitutes a placeholder registry image so synth is fully offline and
// deterministic (no docker build, no network, no AWS). The real deploy leaves it unset and builds the
// image from apps/connections-worker/Dockerfile. Both synthesize the same stack; only the image ref
// differs, and the real image asset is built and validated in the deploy job.

import { join } from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';

const repoRoot = join(__dirname, '..', '..', '..');
const image =
  process.env.CONNECTIONS_SYNTH_OFFLINE === '1'
    ? ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim')
    : ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/connections-worker/Dockerfile' });

const { app } = buildConnectionsApp({ image, credentialAccount: process.env.CDK_DEFAULT_ACCOUNT });
app.synth();
