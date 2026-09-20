# Connections worker — AWS staging deployment runbook

The connections worker (Teams/Telegram durable observation) deploys through GitHub Actions with
GitHub OIDC — the same model as the Brain infrastructure. **No local AWS credentials, no local CDK,
no PowerShell deploy.** Staging only: account `065148797865`, `us-east-1`. Production is unreachable
from this workflow (the role, the account guards and the CDK app all refuse any other account).

## One-time bootstrap (administrator; done once)

The pipeline must not create the identity it uses, so this is done by hand, once:

1. **Deploy the deploy identity.** In `065148797865` / `us-east-1`, deploy
   `infra/connections/access/github-deploy-access.yaml` as CloudFormation stack
   `LoopConnections-staging-github-access` (termination protection on). It creates the role
   `loop-connections-github-deploy`, which only the `connections-staging` GitHub environment may
   assume and which may only assume the CDK bootstrap roles (deploy, file-publishing,
   image-publishing, lookup). It references the existing GitHub OIDC provider (the Brain identity
   created it); it does not make a second. Copy the `DeployRoleArn` output.
   *(CDK must already be bootstrapped in this account — it is, from the Brain setup.)*

2. **Create the `connections-staging` GitHub environment** (repo Settings → Environments → New
   environment → `connections-staging`):
   - Required reviewer: Matt.
   - Deployment branches: `main` only.
   - Environment **variable** `CONNECTIONS_STAGING_DEPLOY_ROLE_ARN` = the `DeployRoleArn` from step 1.

## Deploy (each time)

Run the **connections-infra-deploy** workflow (Actions → connections-infra-deploy → Run workflow):
- `action: diff` first — installs, runs the worker + infra tests, checks the account, `cdk synth`,
  and shows the diff. Creates nothing.
- `action: deploy` + `confirm: deploy loop-connections-staging` — same checks, then applies. The
  environment's required reviewer must approve the run before AWS is touched.

The deploy builds the worker container image and creates: the VPC, the Fargate service, the internal
ALB, the HTTPS HTTP API (VPC Link), and the Secrets Manager entries. Note the stack **Outputs**:
`WorkerUrl` and `WorkerControlSecretArn`.

## After the first deploy

1. **Populate the two UNSET secrets** (Secrets Manager, `065148797865` / `us-east-1`), value field only:
   - `loop/connections/staging/connection-key` → `openssl rand -base64 32`
   - `loop/connections/staging/database-url` → the staging Neon `DATABASE_URL`
   - `loop/connections/staging/conversation-secret` and `.../worker-control` are auto-generated; read
     `worker-control`'s value once for the next step.
2. **Apply the migrations** to the staging Neon DB: `20260925000000_source_connections` and
   `20260926000000_source_observations`.
3. **Set the web (Netlify staging) env**: `LOOP_CONNECTION_PROVIDERS=TELEGRAM`,
   `LOOP_CONNECTIONS_WORKER_URL=<WorkerUrl>`, `LOOP_CONNECTIONS_WORKER_SECRET=<worker-control value>`;
   redeploy web. (The web tier holds no session-sealing key.)
4. **Force a new Fargate deployment** so the task picks up the populated secrets.
5. **Connect**: Loop → Connections → Telegram → Connect → phone → code → (2FA) → Ready.

Disconnect revokes at Telegram and clears the stored session. Teams remains a first-class tile for
its own adapter, added later.
