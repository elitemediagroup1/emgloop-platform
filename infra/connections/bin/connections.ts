// The connections worker deployable's CDK app. Staging only.
//
//   npx cdk synth    # render the template; creates nothing, needs no credentials (builds the image)
//   npx cdk diff     # ONLY with read access to Loop Brain Staging
//   npx cdk deploy   # ONLY with Matt's explicit authorization
//
// Pinned to Loop Brain Staging (065148797865, us-east-1): lib/target.ts.

import { join } from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { buildConnectionsApp } from '../lib/app';

const repoRoot = join(__dirname, '..', '..', '..');
const image = ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/connections-worker/Dockerfile' });

const { app } = buildConnectionsApp({ image, credentialAccount: process.env.CDK_DEFAULT_ACCOUNT });
app.synth();
