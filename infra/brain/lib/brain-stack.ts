// The Brain execution environment, dark (B6). One stack per workload account.
//
// Record: docs/architecture/brain-aws-foundation.md. Every resource below says why it
// exists. There is no VPC, no NAT, no database, no Step Functions, no Temporal and no
// IAM user. Nothing here can call a model provider: no function is granted a provider
// secret, and no bundle contains a provider client (test/bundle.test.ts).

import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export type BrainStage = 'staging';

export interface BrainStackProps extends StackProps {
  readonly stage: BrainStage;
  /** Where `npm run bundle` wrote one directory per function. */
  readonly assetsDir: string;
  /** Alarm notifications. Optional: without it, alarms still show in the console. */
  readonly alarmEmail?: string;
  /** Monthly cost budget notifications, and the budget in US dollars. */
  readonly budgetEmail?: string;
  readonly monthlyBudgetUsd?: number;
}

/** Safe defaults for operational parameters. Changing one here resets it on deploy. */
export const BRAIN_PARAMETER_DEFAULTS = Object.freeze({
  'doorbell/public-keys': '{}',
  'doorbell/trusted-issuers': 'UNSET',
  'doorbell/trusted-callers': 'UNSET',
  'loop/internal-base-url': 'UNSET',
  'worker/enabled': 'false',
  'worker/key-id': 'worker-2026-1',
  'ai/floor': JSON.stringify({ enabled: false, organizations: [], tasks: [], providers: [], killSwitches: [] }),
});

export class BrainStack extends Stack {
  constructor(scope: Construct, id: string, props: BrainStackProps) {
    super(scope, id, props);
    const stage = props.stage;
    const name = (component: string) => `loop-brain-${stage}-${component}`;
    const parameterPrefix = `/loop/brain/${stage}`;
    const secretPrefix = `loop/brain/${stage}`;

    Tags.of(this).add('app', 'loop');
    Tags.of(this).add('component', 'brain');
    Tags.of(this).add('env', stage);
    Tags.of(this).add('managed-by', 'cdk');
    Tags.of(this).add('data-class', 'operational');

    // --- Keys ----------------------------------------------------------------------------

    // Why: encrypts the secrets (database URLs, the checkpoint secret, future provider
    // keys) and the log groups, with a key this account controls and CloudTrail records.
    const dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${name('data')}`,
      description: 'Loop Brain: secrets and logs',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsForBrainLogGroups',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'], // In a key policy, "*" means this key.
        conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/${name('')}*` } },
      }),
    );

    // Why: the workers sign their requests to Loop with a key that never leaves the key
    // service. Loop pins its public half.
    const signingKey = new kms.Key(this, 'WorkerSigningKey', {
      alias: `alias/${name('worker-signing')}`,
      description: 'Loop Brain: worker request signing (ES256)',
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Secrets (no real values) ----------------------------------------------------------

    const unset = (id: string, secretName: string, description: string) =>
      new secretsmanager.Secret(this, id, {
        secretName,
        description,
        encryptionKey: dataKey,
        removalPolicy: RemovalPolicy.RETAIN,
        // A marked placeholder: nothing reads a secret whose state is UNSET as a value.
        generateSecretString: { secretStringTemplate: JSON.stringify({ state: 'UNSET' }), generateStringKey: 'placeholder', excludePunctuation: true },
      });
    // Why: provider keys will live here (B7). Revision 1 grants them to no function.
    const anthropicSecret = unset('AnthropicSecret', `${secretPrefix}/anthropic`, 'Anthropic API key (not set; no function may read it in B6)');
    const openaiSecret = unset('OpenAiSecret', `${secretPrefix}/openai`, 'OpenAI API key (not set; no function may read it in B6)');
    // Why: each component connects to Neon as its own restricted role.
    const workerDatabase = unset('WorkerDatabaseSecret', `${secretPrefix}/neon-worker`, 'Neon URL for loop_brain_worker: {"url": "..."}');
    const dispatcherDatabase = unset('DispatcherDatabaseSecret', `${secretPrefix}/neon-dispatcher`, 'Neon URL for loop_brain_dispatcher: {"url": "..."}');
    const sweeperDatabase = unset('SweeperDatabaseSecret', `${secretPrefix}/neon-sweeper`, 'Neon URL for loop_brain_sweeper: {"url": "..."}');
    // Why: checkpoints are sealed with a key derived from this generated secret.
    const checkpointSecret = new secretsmanager.Secret(this, 'CheckpointSecret', {
      secretName: `${secretPrefix}/checkpoint-key`,
      description: 'Checkpoint sealing secret (generated here; never leaves AWS)',
      encryptionKey: dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // --- Parameters (not secret) ------------------------------------------------------------

    const parameters = Object.fromEntries(
      Object.entries(BRAIN_PARAMETER_DEFAULTS).map(([key, value]) => [
        key,
        new ssm.StringParameter(this, `Param-${key.replace(/[^A-Za-z0-9]/g, '-')}`, {
          parameterName: `${parameterPrefix}/${key}`,
          stringValue: value,
          tier: ssm.ParameterTier.STANDARD,
          description: `Loop Brain (${stage}): ${key}`,
        }),
      ]),
    ) as Record<keyof typeof BRAIN_PARAMETER_DEFAULTS, ssm.StringParameter>;

    // --- Replay ledger, queues -----------------------------------------------------------------

    // Why: a doorbell token is accepted once. Items expire on their own.
    const replayTable = new dynamodb.Table(this, 'RingReplay', {
      tableName: name('ring-replay'),
      partitionKey: { name: 'jti', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Why: messages carry job references only (no content), so queue-managed encryption
    // is enough; the DLQs keep what could not be processed for an operator.
    const queue = (component: string, visibility: Duration) => {
      const dlq = new sqs.Queue(this, `${component}-dlq`, {
        queueName: name(`${component}-dlq`),
        retentionPeriod: Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
      const main = new sqs.Queue(this, `${component}-queue`, {
        queueName: name(`${component}-queue`),
        visibilityTimeout: visibility,
        retentionPeriod: Duration.days(4),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      });
      return { main, dlq };
    };
    const WORKER_TIMEOUT = Duration.seconds(120);
    // AWS: visibility timeout at least six times the function timeout.
    const interactive = queue('interactive', Duration.seconds(720));
    const durable = queue('durable', Duration.seconds(720));

    // --- Functions ------------------------------------------------------------------------------

    const fn = (
      component: string,
      options: { memory: number; timeout: Duration; reserved: number; environment: Record<string, string>; description: string },
    ) => {
      const logGroup = new logs.LogGroup(this, `${component}-logs`, {
        logGroupName: `/aws/lambda/${name(component)}`,
        retention: logs.RetentionDays.ONE_MONTH,
        encryptionKey: dataKey,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const role = new iam.Role(this, `${component}-role`, {
        roleName: name(`${component}-role`),
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        description: `Loop Brain ${component}`,
      });
      role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteOwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
      const f = new lambda.Function(this, component, {
        functionName: name(component),
        description: options.description,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(join(props.assetsDir, component)),
        memorySize: options.memory,
        timeout: options.timeout,
        reservedConcurrentExecutions: options.reserved,
        role,
        logGroup,
        environment: { ...options.environment, BRAIN_STAGE: stage, BRAIN_PARAMETER_PREFIX: parameterPrefix, NODE_OPTIONS: '--enable-source-maps' },
      });
      return { f, role };
    };

    const queueEnv = { BRAIN_INTERACTIVE_QUEUE_URL: interactive.main.queueUrl, BRAIN_DURABLE_QUEUE_URL: durable.main.queueUrl };

    // Why: verifies a ring's signature and freshness before anything with data access runs.
    const authorizer = fn('authorizer', {
      memory: 256,
      timeout: Duration.seconds(5),
      reserved: 5,
      description: 'Doorbell authorizer: pinned keys, claims, replay ledger',
      environment: { BRAIN_REPLAY_TABLE: replayTable.tableName },
    });
    for (const key of ['doorbell/public-keys', 'doorbell/trusted-issuers', 'doorbell/trusted-callers'] as const) parameters[key].grantRead(authorizer.role);
    authorizer.role.addToPolicy(new iam.PolicyStatement({ sid: 'RecordRingOnce', actions: ['dynamodb:PutItem'], resources: [replayTable.tableArn] }));

    // Why: turns a ring (or a sweeper hand-over) into a queued job reference, after reading
    // the command and its job from Neon.
    const dispatcher = fn('dispatcher', {
      memory: 256,
      timeout: Duration.seconds(15),
      reserved: 5,
      description: 'Dispatcher: stored command -> queued reference',
      environment: { ...queueEnv, BRAIN_DATABASE_SECRET: dispatcherDatabase.secretName },
    });
    dispatcherDatabase.grantRead(dispatcher.role);
    for (const key of ['doorbell/trusted-issuers', 'doorbell/trusted-callers'] as const) parameters[key].grantRead(dispatcher.role);
    interactive.main.grantSendMessages(dispatcher.role);
    durable.main.grantSendMessages(dispatcher.role);

    // Why: two workers from one bundle, so interactive work has its own concurrency (and,
    // later, provisioned concurrency) and each can be stopped on its own.
    const worker = (kind: 'interactive' | 'durable', reserved: number, source: sqs.Queue) => {
      const w = fn(`worker-${kind}`, {
        memory: 1024,
        timeout: WORKER_TIMEOUT,
        reserved,
        description: `Worker (${kind}): advances jobs, dark`,
        environment: {
          ...queueEnv,
          BRAIN_DATABASE_SECRET: workerDatabase.secretName,
          BRAIN_CHECKPOINT_SECRET: checkpointSecret.secretName,
          BRAIN_SIGNING_KEY_ARN: signingKey.keyArn,
          BRAIN_WORKER_ISSUER: `loop-brain-${stage}`,
          BRAIN_WORKER_SUBJECT: `worker-${kind}`,
        },
      });
      workerDatabase.grantRead(w.role);
      checkpointSecret.grantRead(w.role);
      for (const key of ['worker/enabled', 'worker/key-id', 'ai/floor', 'loop/internal-base-url'] as const) parameters[key].grantRead(w.role);
      w.role.addToPolicy(new iam.PolicyStatement({ sid: 'SignWorkerRequests', actions: ['kms:Sign'], resources: [signingKey.keyArn] }));
      interactive.main.grantSendMessages(w.role);
      durable.main.grantSendMessages(w.role);
      w.f.addEventSource(new SqsEventSource(source, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: reserved }));
      return w;
    };
    const workerInteractive = worker('interactive', 5, interactive.main);
    const workerDurable = worker('durable', 2, durable.main);

    // Why: recovers work whose wakeup was lost. Reads only; hands lost commands to the dispatcher.
    const sweeper = fn('sweeper', {
      memory: 256,
      timeout: Duration.seconds(60),
      reserved: 1,
      description: 'Sweeper: lost rings, expired questions, stale leases',
      environment: { BRAIN_DURABLE_QUEUE_URL: durable.main.queueUrl, BRAIN_DATABASE_SECRET: sweeperDatabase.secretName, BRAIN_DISPATCHER_FUNCTION: dispatcher.f.functionName },
    });
    sweeperDatabase.grantRead(sweeper.role);
    durable.main.grantSendMessages(sweeper.role);
    sweeper.role.addToPolicy(new iam.PolicyStatement({ sid: 'HandLostCommandsToDispatcher', actions: ['lambda:InvokeFunction'], resources: [dispatcher.f.functionArn] }));

    // Why: staging sweeps every five minutes (it keeps a Neon compute awake while it runs).
    new scheduler.Schedule(this, 'SweepSchedule', {
      scheduleName: name('sweep'),
      description: 'Loop Brain sweeper',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(5)),
      target: new targets.LambdaInvoke(sweeper.f, { retryAttempts: 0 }),
    });

    // --- The doorbell -----------------------------------------------------------------------------

    // Why: the only public entry. One route; the authorizer runs first, with no caching.
    const api = new apigw.HttpApi(this, 'Doorbell', { apiName: name('doorbell'), createDefaultStage: true });
    api.addRoutes({
      path: '/v1/doorbell',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('DispatcherIntegration', dispatcher.f),
      authorizer: new HttpLambdaAuthorizer('RingAuthorizer', authorizer.f, {
        authorizerName: name('ring-authorizer'),
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        resultsCacheTtl: Duration.seconds(0),
        identitySource: ['$request.header.Authorization'],
      }),
    });
    const stageResource = api.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    stageResource?.addPropertyOverride('DefaultRouteSettings', { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 });

    // --- Alarms and cost -----------------------------------------------------------------------------

    // Why: an operator hears about stuck or failing work.
    const topic = new sns.Topic(this, 'Alarms', { topicName: name('alarms') });
    if (props.alarmEmail) topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const a = new cloudwatch.Alarm(this, `Alarm-${id}`, {
        alarmName: name(id),
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new actions.SnsAction(topic));
    };
    const fiveMinutes = { period: Duration.minutes(5) };
    alarm('interactive-dlq', interactive.dlq.metricApproximateNumberOfMessagesVisible(fiveMinutes), 0, 'Interactive work reached its dead-letter queue');
    alarm('durable-dlq', durable.dlq.metricApproximateNumberOfMessagesVisible(fiveMinutes), 0, 'Durable work reached its dead-letter queue');
    alarm('interactive-age', interactive.main.metricApproximateAgeOfOldestMessage(fiveMinutes), 120, 'Interactive work waited more than two minutes');
    alarm('durable-age', durable.main.metricApproximateAgeOfOldestMessage(fiveMinutes), 600, 'Durable work waited more than ten minutes');
    for (const [id, f] of [
      ['worker-interactive-errors', workerInteractive.f],
      ['worker-durable-errors', workerDurable.f],
      ['dispatcher-errors', dispatcher.f],
      ['sweeper-errors', sweeper.f],
      ['authorizer-errors', authorizer.f],
    ] as const) {
      alarm(id, f.metricErrors(fiveMinutes), 0, `${f.node.id} raised errors`);
    }
    alarm('authorizer-refusals', new cloudwatch.Metric({ namespace: 'Loop/Brain', metricName: 'DoorbellRefused', dimensionsMap: { Component: 'authorizer' }, statistic: 'Sum', ...fiveMinutes }), 20, 'Many doorbell rings were refused');

    // Why: a monthly ceiling that notifies before infrastructure cost surprises anyone.
    if (props.budgetEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: { budgetName: name('monthly'), budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.monthlyBudgetUsd ?? 25, unit: 'USD' } },
        notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail! }],
        })),
      });
    }

    // --- Outputs -----------------------------------------------------------------------------------

    new CfnOutput(this, 'DoorbellUrl', { value: `${api.apiEndpoint}/v1/doorbell`, description: 'LOOP_BRAIN_DOORBELL_URL for the Loop deployment that rings this environment' });
    new CfnOutput(this, 'WorkerSigningKeyArn', { value: signingKey.keyArn, description: 'Export its public key for LOOP_BRAIN_WORKER_PUBLIC_KEYS' });
    new CfnOutput(this, 'ParameterPrefix', { value: parameterPrefix });
    new CfnOutput(this, 'ProviderSecretNames', { value: [anthropicSecret.secretName, openaiSecret.secretName].join(','), description: 'Not set in B6' });
  }
}
