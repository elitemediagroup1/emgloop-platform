// The Brain deployable's CDK app. Slice B6.
//
//   npm run bundle        # build the function bundles into dist/
//   npx cdk synth         # render the template; creates nothing, needs no credentials
//   npx cdk diff          # ONLY with read access to Loop Brain Staging
//   npx cdk deploy        # ONLY with Matt's explicit authorization (B7)
//
// The stack is pinned to Loop Brain Staging (065148797865, us-east-1): lib/target.ts.

import { join } from 'node:path';

import { buildBrainApp } from '../lib/app';

const { app } = buildBrainApp({
  assetsDir: join(__dirname, '..', 'dist'),
  credentialAccount: process.env.CDK_DEFAULT_ACCOUNT,
});
app.synth();
