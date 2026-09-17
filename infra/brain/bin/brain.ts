// The Brain deployable's CDK app. Slice B6.
//
//   npm run bundle        # build the four function bundles into dist/
//   npx cdk synth         # render the template; creates nothing
//   npx cdk deploy        # ONLY with Matt's authorization, into loop-brain-staging

import { join } from 'node:path';
import { App } from 'aws-cdk-lib';

import { BrainStack } from '../lib/brain-stack';

const app = new App();
const stage = app.node.tryGetContext('stage');
if (stage !== 'staging') throw new Error('B6 builds the staging environment only');

new BrainStack(app, 'LoopBrain-staging', {
  stage,
  // us-east-1 beside production Neon and Netlify's IAD functions. The account comes from
  // the credentials used to deploy (loop-brain-staging), never from this file.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  assetsDir: join(__dirname, '..', 'dist'),
  alarmEmail: app.node.tryGetContext('alarmEmail'),
  budgetEmail: app.node.tryGetContext('budgetEmail'),
  monthlyBudgetUsd: Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 25),
  terminationProtection: true,
  description: 'Loop Brain execution environment (staging, dark)',
});
