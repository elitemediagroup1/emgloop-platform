// The connections worker on AWS: a single always-on Fargate service that holds the persistent
// Telegram (MTProto) sessions, runs the observation sweep, and serves the signed control endpoints
// the Loop web tier calls to drive an interactive login. Staging only.
//
// SMALLEST APPROPRIATE SHAPE. One small Fargate task in private subnets; one NAT for its outbound
// (Telegram, Neon); an INTERNAL ALB in front of it; and an HTTP API with a VPC Link so the web tier
// reaches it over HTTPS (the execute-api domain) WITHOUT a custom domain or certificate. Nothing is
// internet-facing except the HTTP API, and only signed requests are honoured by the worker itself.
//
// SECRETS. api_id/api_hash come from the pre-created `loop/connections/staging/telegram`. The
// session-sealing key and the Neon URL are created here as UNSET placeholders for an operator to
// populate; the conversation-key secret and the web<->worker control secret are generated here and
// never leave AWS (the control secret is also read once by the operator to set the web env var).
// Every secret reaches the container as an environment variable injected by the task from Secrets
// Manager; the worker holds no AWS SDK and reads only its environment.

import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { HttpApi, HttpMethod, VpcLink } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpAlbIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Construct } from 'constructs';

export interface ConnectionsStackProps extends StackProps {
  readonly stage: 'staging';
  /** The worker container image. bin/ builds it from the Dockerfile; tests inject a registry image. */
  readonly image: ecs.ContainerImage;
  /** Retention horizon (days) for the content-free observation store. */
  readonly observationRetentionDays?: number;
}

/** The Secrets Manager names this stack references or creates. */
export const CONNECTION_SECRET_NAMES = Object.freeze({
  telegram: 'loop/connections/staging/telegram',
  connectionKey: 'loop/connections/staging/connection-key',
  conversationSecret: 'loop/connections/staging/conversation-secret',
  workerControl: 'loop/connections/staging/worker-control',
  databaseUrl: 'loop/connections/staging/database-url',
} as const);

const CONTAINER_PORT = 8080;

export class ConnectionsStack extends Stack {
  // Pin the AZs so `cdk synth` is deterministic and needs NO AWS credentials or context lookup: a
  // VPC with a concrete env otherwise asks AWS for the account's availability zones at synth time.
  // The stack is pinned to us-east-1 (lib/target.ts), where these two AZ names always exist.
  override get availabilityZones(): string[] {
    return ['us-east-1a', 'us-east-1b'];
  }

  constructor(scope: Construct, id: string, props: ConnectionsStackProps) {
    super(scope, id, props);

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
    const telegram = secretsmanager.Secret.fromSecretNameV2(this, 'TelegramSecret', CONNECTION_SECRET_NAMES.telegram);

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
    const connectionKey = secretsmanager.Secret.fromSecretNameV2(this, 'ConnectionKeySecret', CONNECTION_SECRET_NAMES.connectionKey);
    const databaseUrl = secretsmanager.Secret.fromSecretNameV2(this, 'DatabaseUrlSecret', CONNECTION_SECRET_NAMES.databaseUrl);
    // Generated here; never leave AWS. The control secret is also read once to set the web env var.
    const conversationSecret = generated('ConversationSecret', CONNECTION_SECRET_NAMES.conversationSecret, 'HMAC key for one-way conversation keys (generated).');
    const workerControl = generated('WorkerControlSecret', CONNECTION_SECRET_NAMES.workerControl, 'Web<->worker control channel shared secret (generated).');

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
      },
      secrets: {
        TELEGRAM_API_ID: ecs.Secret.fromSecretsManager(telegram, 'api_id'),
        TELEGRAM_API_HASH: ecs.Secret.fromSecretsManager(telegram, 'api_hash'),
        LOOP_CONNECTION_SECRET_KEY: ecs.Secret.fromSecretsManager(connectionKey),
        LOOP_CONNECTION_CONVERSATION_SECRET: ecs.Secret.fromSecretsManager(conversationSecret),
        LOOP_CONNECTIONS_WORKER_SECRET: ecs.Secret.fromSecretsManager(workerControl),
        DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrl),
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
    listener.addTargets('Worker', {
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
      description: 'Loop connections worker control API (staging).',
      defaultIntegration: new HttpAlbIntegration('AlbIntegration', listener, { vpcLink }),
    });
    // The control endpoints and the health check, all through the same private integration.
    for (const path of ['/telegram/login/start', '/telegram/login/code', '/telegram/login/password', '/telegram/login/cancel', '/telegram/disconnect']) {
      httpApi.addRoutes({ path, methods: [HttpMethod.POST], integration: new HttpAlbIntegration(`R${path.replace(/\//g, '_')}`, listener, { vpcLink }) });
    }
    httpApi.addRoutes({ path: '/healthz', methods: [HttpMethod.GET], integration: new HttpAlbIntegration('RHealth', listener, { vpcLink }) });

    // The worker URL the web tier uses (set LOOP_CONNECTIONS_WORKER_URL to this).
    new CfnOutput(this, 'WorkerUrl', { value: httpApi.apiEndpoint, description: 'LOOP_CONNECTIONS_WORKER_URL for the web tier' });
    new CfnOutput(this, 'WorkerControlSecretArn', { value: workerControl.secretArn, description: 'Read this once to set LOOP_CONNECTIONS_WORKER_SECRET in the web tier' });
  }
}
