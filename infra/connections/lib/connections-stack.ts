// The connections worker on AWS: a single always-on Fargate service that holds the persistent
// Telegram (MTProto) sessions, runs the observation sweep, and serves the signed control endpoints
// the Loop web tier calls to drive an interactive login. One stack shape for both stages; the stage
// (lib/target.ts) decides only the account, the stack name, the secret names and the defaults.
//
// SMALLEST APPROPRIATE SHAPE. One small Fargate task in private subnets; one NAT for its outbound
// (Telegram, Neon); an INTERNAL ALB in front of it; and an HTTP API with a VPC Link so the web tier
// reaches it over HTTPS (the execute-api domain) WITHOUT a custom domain or certificate. Nothing is
// internet-facing except the HTTP API, and only signed requests are honoured by the worker itself.
//
// SECRETS. api_id/api_hash come from the pre-created `loop/connections/<stage>/telegram`. The
// session-sealing key and the Neon URL are operator-provided and referenced, not created; the
// conversation-key secret and the web<->worker control secret are generated here and never leave
// AWS (the control secret is also read once by the operator to set the web env var). Every secret
// reaches the container as an environment variable injected by the task from Secrets Manager; the
// worker holds no AWS SDK and reads only its environment.
//
// CREATOR MEDIA. The same HTTP API also fronts the media signer: one small Lambda (lambda/
// media-signer.ts) that mints short-lived presigned URLs for a PRIVATE S3 bucket, so the browser
// uploads and plays creator media directly against S3 while the web tier holds no AWS credential.
// The signer honours only calls signed with the SAME worker-control secret, and its role can touch
// only objects under `media/`. Nothing about the worker's shape changes for it.
//
// PROTECTION. With `protection` set (CDK context `alertEmail`, required for production), the stack
// adds exactly three boring things: an SNS topic subscribed to that address, a monthly cost budget
// for the account with notifications at 80% and 100% of actual spend, and one CloudWatch alarm that
// fires when the worker has had no healthy target for five minutes. Without it (staging may omit
// the email) none of the three exists and synth warns. Every resource carries the tag
// `loop:stage=<stage>`.

import { join } from 'node:path';
import { Annotations, Stack, StackProps, CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { HttpApi, HttpMethod, VpcLink } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpAlbIntegration, HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Construct } from 'constructs';

import { CONNECTIONS_REGION, type ConnectionsStage } from './target';

/** The cost budget and availability alarm, both notifying one address. See protectionFromContext (app.ts). */
export interface StackProtection {
  readonly alertEmail: string;
  /** The monthly cost ceiling for the ACCOUNT (not just this stack), in whole US dollars. */
  readonly monthlyBudgetUsd: number;
}

export interface ConnectionsStackProps extends StackProps {
  readonly stage: ConnectionsStage;
  /** The worker container image. bin/ builds it from the Dockerfile; tests inject a registry image. */
  readonly image: ecs.ContainerImage;
  /** Where `npm run bundle` wrote the function bundles (dist/<function>/index.js). */
  readonly assetsDir: string;
  /** The browser origins the media bucket answers CORS for (the web tier's deploy URLs). */
  readonly mediaOrigins: readonly string[];
  /** Retention horizon (days) for the content-free observation store. */
  readonly observationRetentionDays?: number;
  /**
   * Operator-activated AI content triage. Set ONLY when the operator supplies a real organization
   * id (via CDK context `aiOrganizationId`, wired in app.ts). When undefined, no AI secret is
   * referenced and no LOOP_AI_* env is set: the worker stays fail-closed (NOT_ACTIVATED) and the
   * synthesized stack is byte-for-byte identical to the AI-off shape.
   */
  readonly aiActivation?: { readonly organizationId: string; readonly openAiFallback: boolean };
  /** The cost budget and availability alarm. Absent: neither exists, and synth warns. */
  readonly protection?: StackProtection;
}

/** The Secrets Manager names a stage's stack references or creates: `loop/connections/<stage>/…`. */
export function connectionSecretNames(stage: ConnectionsStage) {
  const prefix = `loop/connections/${stage}`;
  return Object.freeze({
    telegram: `${prefix}/telegram`,
    connectionKey: `${prefix}/connection-key`,
    conversationSecret: `${prefix}/conversation-secret`,
    workerControl: `${prefix}/worker-control`,
    databaseUrl: `${prefix}/database-url`,
    ai: `${prefix}/ai`,
  } as const);
}

const CONTAINER_PORT = 8080;

/** The only key prefix the media signer mints URLs for, and the only prefix its role may touch. */
export const MEDIA_KEY_PREFIX = 'media/';

/** The route on the control API that the media signer answers (`${WorkerUrl}/media/sign`). */
export const MEDIA_SIGN_PATH = '/media/sign';

export class ConnectionsStack extends Stack {
  // Pin the AZs so `cdk synth` is deterministic and needs NO AWS credentials or context lookup: a
  // VPC with a concrete env otherwise asks AWS for the account's availability zones at synth time.
  // Both stages are pinned to us-east-1 (lib/target.ts), where these two AZ names always exist.
  override get availabilityZones(): string[] {
    return ['us-east-1a', 'us-east-1b'];
  }

  constructor(scope: Construct, id: string, props: ConnectionsStackProps) {
    super(scope, id, props);
    if (this.region !== CONNECTIONS_REGION) throw new Error(`the availability-zone pin holds for ${CONNECTIONS_REGION} only, not ${this.region}`);
    const names = connectionSecretNames(props.stage);
    Tags.of(this).add('loop:stage', props.stage);

    // --- Network: private tasks, one NAT for outbound, nothing else public --------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // --- Secrets ------------------------------------------------------------------------------
    const telegram = secretsmanager.Secret.fromSecretNameV2(this, 'TelegramSecret', names.telegram);

    const generated = (id2: string, secretName: string, description: string) =>
      new secretsmanager.Secret(this, id2, {
        secretName,
        description,
        removalPolicy: RemovalPolicy.RETAIN,
        generateSecretString: { passwordLength: 64, excludePunctuation: true },
      });

    // OPERATOR-PROVIDED PREREQUISITES, referenced not created (like the Telegram secret): they must
    // exist with real values BEFORE deploy, so the worker -- which fails closed on a missing sealing
    // key at boot -- starts healthy and the Fargate service reaches steady state. Creating them here
    // as empty placeholders would crash the first task and roll the deployment back. See the runbook.
    const connectionKey = secretsmanager.Secret.fromSecretNameV2(this, 'ConnectionKeySecret', names.connectionKey);
    const databaseUrl = secretsmanager.Secret.fromSecretNameV2(this, 'DatabaseUrlSecret', names.databaseUrl);
    // Generated here; never leave AWS. The control secret is also read once to set the web env var.
    const conversationSecret = generated('ConversationSecret', names.conversationSecret, 'HMAC key for one-way conversation keys (generated).');
    const workerControl = generated('WorkerControlSecret', names.workerControl, 'Web<->worker control channel shared secret (generated).');

    // --- AI content triage: operator-activated, fail-closed, credential via Secrets Manager --------
    // apps/connections-worker/src/ai-runtime.ts is OFF unless LOOP_AI_ENABLED === 'true' AND a provider
    // is listed, terms-confirmed, and its key present. We feed exactly that env, and ONLY when the
    // operator supplied an organization id (CDK context aiOrganizationId -> app.ts -> props.aiActivation).
    // When absent: no ai secret reference, no LOOP_AI_* env, no key -- the stack is unchanged and the
    // worker refuses every invocation. The credential is injected from Secrets Manager JSON fields, never
    // as plaintext env; OpenAI is opt-in, so a default activation never requires an OpenAI key.
    const aiEnvironment: Record<string, string> = {};
    const aiSecrets: Record<string, ecs.Secret> = {};
    if (props.aiActivation) {
      const providers = props.aiActivation.openAiFallback ? 'anthropic,openai' : 'anthropic';
      // Referenced, not created (like telegram/connection-key/database-url): the operator pre-creates
      // `loop/connections/<stage>/ai` with the real key(s) before deploy. See the runbooks.
      const aiSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AiSecret', names.ai);
      aiSecrets.ANTHROPIC_API_KEY = ecs.Secret.fromSecretsManager(aiSecret, 'anthropic_api_key');
      if (props.aiActivation.openAiFallback) {
        aiSecrets.OPENAI_API_KEY = ecs.Secret.fromSecretsManager(aiSecret, 'openai_api_key');
      }
      aiEnvironment.LOOP_AI_ENABLED = 'true';
      aiEnvironment.LOOP_AI_PROVIDERS = providers;
      aiEnvironment.LOOP_AI_PROVIDER_TERMS_CONFIRMED = providers;
      aiEnvironment.LOOP_AI_ORGANIZATIONS = props.aiActivation.organizationId;
      aiEnvironment.LOOP_AI_TASKS = 'telegram.content.triage';
    }

    // --- Compute: one small always-on Fargate task -------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED });
    const logGroup = new logs.LogGroup(this, 'WorkerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });
    taskDefinition.addContainer('worker', {
      image: props.image,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'connections-worker', logGroup }),
      environment: {
        LOOP_CONNECTIONS_WORKER_RUN: '1',
        PORT: String(CONTAINER_PORT),
        LOOP_CONNECTION_OBSERVATION_RETENTION_DAYS: String(props.observationRetentionDays ?? 30),
        LOOP_CONNECTION_SWEEP_INTERVAL_MS: '60000',
        ...aiEnvironment,
      },
      secrets: {
        TELEGRAM_API_ID: ecs.Secret.fromSecretsManager(telegram, 'api_id'),
        TELEGRAM_API_HASH: ecs.Secret.fromSecretsManager(telegram, 'api_hash'),
        LOOP_CONNECTION_SECRET_KEY: ecs.Secret.fromSecretsManager(connectionKey),
        LOOP_CONNECTION_CONVERSATION_SECRET: ecs.Secret.fromSecretsManager(conversationSecret),
        LOOP_CONNECTIONS_WORKER_SECRET: ecs.Secret.fromSecretsManager(workerControl),
        DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrl),
        ...aiSecrets,
      },
      portMappings: [{ containerPort: CONTAINER_PORT }],
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 0, // one task; allow it to be replaced without a second running
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      // Give the container time to start and register before the load balancer judges it unhealthy.
      healthCheckGracePeriod: Duration.seconds(120),
    });

    // --- Ingress: internal ALB, reached only through an HTTPS HTTP API via a VPC Link ---------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: false });
    const listener = alb.addListener('Listener', { port: 80, protocol: elbv2.ApplicationProtocol.HTTP, open: false });
    const workerTargets = listener.addTargets('Worker', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/healthz', interval: Duration.seconds(30), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: Duration.seconds(10),
    });

    // The VPC Link gets its OWN security group so the ALB can admit exactly it -- and so it is not
    // silently placed in the (locked-down) default SG, which would strip its egress to the ALB.
    const vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', {
      vpc,
      description: 'API Gateway VPC Link to the connections worker ALB',
      allowAllOutbound: false,
    });
    const vpcLink = new VpcLink(this, 'VpcLink', { vpc, securityGroups: [vpcLinkSg] });
    // The internal ALB accepts traffic ONLY from the VPC Link's ENIs -- not 0.0.0.0/0, and not the
    // rest of the VPC. `open: false` on the listener suppresses CDK's default anyone-on-80 rule, and
    // this is the only ingress. allowFrom also wires the VPC Link SG's egress to the ALB.
    alb.connections.allowFrom(vpcLinkSg, ec2.Port.tcp(80), 'API Gateway VPC Link only');
    const httpApi = new HttpApi(this, 'ControlApi', {
      description: `Loop connections worker control API (${props.stage}).`,
      defaultIntegration: new HttpAlbIntegration('AlbIntegration', listener, { vpcLink }),
    });
    // The control endpoints and the health check, all through the same private integration.
    for (const path of ['/telegram/login/start', '/telegram/login/code', '/telegram/login/password', '/telegram/login/cancel', '/telegram/disconnect']) {
      httpApi.addRoutes({ path, methods: [HttpMethod.POST], integration: new HttpAlbIntegration(`R${path.replace(/\//g, '_')}`, listener, { vpcLink }) });
    }
    httpApi.addRoutes({ path: '/healthz', methods: [HttpMethod.GET], integration: new HttpAlbIntegration('RHealth', listener, { vpcLink }) });

    // --- Creator media: a private bucket and the signer that is the only way to reach it ---------
    // PRIVATE in every dimension: public access blocked, owner-enforced (no ACLs), SSE at rest, TLS
    // in transit. The browser reaches objects ONLY through presigned URLs, which is why CORS allows
    // PUT/GET/HEAD from the web tier's origins. RETAIN: media outlives any stack mistake.
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: false,
      // An abandoned multipart upload otherwise bills forever and is invisible to a listing.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [...props.mediaOrigins],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
    });

    // The signer's role is built by hand (no managed policy) so it holds exactly: its own log
    // group, the three object actions under `media/`, and a read of the worker-control secret.
    // No ListBucket, nothing on the bucket root, no other secret.
    const mediaSignerLogs = new logs.LogGroup(this, 'MediaSignerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const mediaSignerRole = new iam.Role(this, 'MediaSignerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Loop connections media signer: presigned URLs under media/ only',
    });
    mediaSignerRole.addToPolicy(new iam.PolicyStatement({ sid: 'WriteOwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [mediaSignerLogs.logGroupArn] }));
    mediaSignerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MediaObjectsOnly',
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [mediaBucket.arnForObjects(`${MEDIA_KEY_PREFIX}*`)],
      }),
    );
    workerControl.grantRead(mediaSignerRole);

    const mediaSigner = new lambda.Function(this, 'MediaSigner', {
      description: 'Creator media signer: presigned S3 URLs for HMAC-signed calls from the Loop web tier',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(join(props.assetsDir, 'media-signer')),
      memorySize: 256,
      timeout: Duration.seconds(10),
      role: mediaSignerRole,
      logGroup: mediaSignerLogs,
      environment: {
        LOOP_MEDIA_BUCKET: mediaBucket.bucketName,
        LOOP_MEDIA_KEY_PREFIX: MEDIA_KEY_PREFIX,
        LOOP_MEDIA_SIGNER_SECRET_ARN: workerControl.secretArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    // The one route on the existing API that is NOT the worker: everything else still goes to the ALB.
    httpApi.addRoutes({ path: MEDIA_SIGN_PATH, methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('MediaSignIntegration', mediaSigner) });

    // --- Protection: one topic, one budget, one alarm -- or nothing, loudly ----------------------
    if (props.protection) {
      const { alertEmail, monthlyBudgetUsd } = props.protection;
      const alerts = new sns.Topic(this, 'Alerts', { displayName: `Loop connections (${props.stage}) alerts` });
      alerts.addSubscription(new subscriptions.EmailSubscription(alertEmail));

      // An ACCOUNT-level cost budget (no filter): in a member account it measures that account. In
      // production the account is dedicated to this workload, so the number is exact; in staging the
      // account is shared with the Brain, so the ceiling covers both (see the runbooks).
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: { budgetName: `loop-connections-${props.stage}-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        })),
      });

      // "Is the worker up?" as the load balancer sees it: no healthy target for five consecutive
      // minutes. This is the ALB's own metric, emitted without Container Insights (which the
      // cluster leaves off); the ECS RunningTaskCount metric would need Insights. Missing data is
      // BREACHING: a target group with nothing registered is exactly the outage this reports.
      const down = new cloudwatch.Alarm(this, 'WorkerDownAlarm', {
        alarmName: `loop-connections-${props.stage}-worker-down`,
        alarmDescription: `The connections worker (${props.stage}) has had no healthy target for 5 minutes.`,
        metric: workerTargets.metrics.healthyHostCount({ period: Duration.minutes(1), statistic: 'Minimum' }),
        threshold: 1,
        evaluationPeriods: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      down.addAlarmAction(new actions.SnsAction(alerts));
      down.addOkAction(new actions.SnsAction(alerts));
    } else {
      Annotations.of(this).addWarningV2(
        '@emgloop/infra-connections:noAlertEmail',
        `No alertEmail context: the ${props.stage} stack has NO cost budget and NO availability alarm.`,
      );
    }

    // The worker URL the web tier uses (set LOOP_CONNECTIONS_WORKER_URL to this).
    new CfnOutput(this, 'WorkerUrl', { value: httpApi.apiEndpoint, description: 'LOOP_CONNECTIONS_WORKER_URL for the web tier' });
    new CfnOutput(this, 'WorkerControlSecretArn', { value: workerControl.secretArn, description: 'Read this once to set LOOP_CONNECTIONS_WORKER_SECRET in the web tier' });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName, description: 'The private creator-media bucket (reached only via the signer)' });
    new CfnOutput(this, 'MediaSignerUrl', { value: `${httpApi.apiEndpoint}${MEDIA_SIGN_PATH}`, description: 'The media signer endpoint for the web tier (signed with the worker-control secret)' });
  }
}
