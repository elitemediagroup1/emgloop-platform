# Connections worker — AWS production deployment runbook

The connections worker (Teams/Telegram durable observation) deploys to production the same way it
deploys to staging: the `connections-infra-deploy` workflow, GitHub OIDC, no local AWS credentials,
no local CDK. Same stack shape, same guards, a different account. Read
`connections-aws-staging.md` first; this runbook says only what differs.

**Status (2026-09-24): Parts 1–5 are done** — the production workload account `080891698678` exists
with the OIDC provider, both access stacks (termination protection on), the organization trail verified,
the three operator secrets, and the `connections-production` environment with its four variables.
**Parts 6 (step 11, production migrations) onward have not been done.** Read the workflow run
histories, not this line, for what has actually run.
- **Who does it:** Matt, in the AWS, GitHub, Netlify and Neon consoles. Claude has no AWS access.
- **Where AWS commands run:** AWS CloudShell, signed in to the account each step names, console in
  **us-east-1**. Before every step that creates something, check the account:

  ```sh
  aws sts get-caller-identity --query Account --output text
  ```

- **The management account (`670682108352`) is governance only** (`brain-aws-staging.md` Part 1).
  It hosts the Organization, the trail, Identity Center and the central budgets — never a workload.
  The CDK app refuses it by name (`infra/connections/lib/target.ts`), the workflow refuses it by
  name, and no step below creates anything in it except the account itself and the Identity Center
  assignment.
- **The production account id is `080891698678`** (the dedicated production workload account,
  created 2026-09-24). It is pinned in the production migrations workflow
  (`deploy-prisma-migrations.yml`) and set as the GitHub environment variable
  `CONNECTIONS_PRODUCTION_ACCOUNT_ID` (step 10); the migrations workflow refuses to run unless the
  two agree. The CDK deploy reads the variable as context `productionAccount`, requires 12 digits,
  and refuses the management and staging ids.

**Rules that hold throughout** (the staging and Brain runbooks' rules, plus one):
- Never create an IAM user or an access key. People use Identity Center; GitHub uses OIDC.
- Secret values are typed only into the system that keeps them (Secrets Manager, Netlify, Neon).
  Never into chat, a ticket, GitHub, a file in the repository or shell history.
- **Never reuse a staging secret value in production**, and never point production at staging Neon
  or staging at production Neon.

---

## Part 1 — The production workload account (in the management account)

1. **Create the account.** In the management account: **AWS Organizations → AWS accounts → Add an
   AWS account → Create an AWS account**.
   - **Account name:** a name that says what it is, e.g. `Loop Production`.
   - **Email:** a dedicated address Matt controls (it becomes the root user, which is never used).
   - **IAM role name:** leave the default (`OrganizationAccountAccessRole`).
   Note the new 12-digit account id. It is the value of `CONNECTIONS_PRODUCTION_ACCOUNT_ID` (step 10).

2. **Move it into the `Workloads` OU** (`brain-aws-staging.md` Part 1, steps 2–3). The service
   control policy `loop-workloads-guardrails` attached to that OU then binds this account too:
   us-east-1 only, no IAM users or keys, stays in the Organization, keeps the trail. If the OU or
   the policy was never created, do those two steps first — they are the guardrail this account
   inherits, and they cost nothing.

3. **The organization trail** (`brain-aws-staging.md` step 4) covers accounts added later
   automatically. In CloudShell **in the new account**, confirm it is listed:

   ```sh
   aws cloudtrail describe-trails --region us-east-1 \
     --query "trailList[].[Name,IsOrganizationTrail,IsMultiRegionTrail,HomeRegion]"
   ```

4. **Budget.** The production stack creates its own account-level cost budget (150 USD a month by
   default, notifying at 80% and 100% of actual spend) — step 9. A second, central budget in the
   management account filtered to this linked account is optional and would duplicate it.

## Part 2 — People's access (IAM Identity Center, in the management account)

5. In **IAM Identity Center → AWS accounts → the new account → Assign users or groups**, assign
   Matt the existing `AdministratorAccess` permission set (1-hour sessions, MFA on every sign-in,
   as in `brain-aws-staging.md` step 6). Sign in to the new account through the access portal and
   confirm `aws sts get-caller-identity` prints the new id. Use these sessions for the setup steps
   in this runbook only.

## Part 3 — CDK bootstrap (in the production account)

6. Once, as `AdministratorAccess`, in CloudShell **from the home directory, not from a checkout**:

   ```sh
   cd ~ && ls cdk.json 2>/dev/null                                  # must print nothing
   aws sts get-caller-identity --query Account --output text      # must print the PRODUCTION id — stop otherwise
   npx --yes aws-cdk@2.1142.0 bootstrap aws://<PRODUCTION_ACCOUNT_ID>/us-east-1 --termination-protection
   aws ssm get-parameter --region us-east-1 --name /cdk-bootstrap/hnb659fds/version --query Parameter.Value
   ```

   Default qualifier `hnb659fds` — the one `lib/target.ts` pins for both stages; no `--trust`, no
   custom key. It creates the `CDKToolkit` stack: the assets bucket, the container-assets ECR
   repository (which, unlike the Brain's, WILL hold the worker image), the five bootstrap roles and
   the version parameter — the same table as `brain-aws-staging.md` step 14, with this account's id.

## Part 4 — The GitHub identities (in the production account)

7. **Create the GitHub OIDC provider.** Both access templates *reference* the provider
   `token.actions.githubusercontent.com` in the deploying account; neither creates it. In staging
   the Brain deploy identity (`infra/brain/access/github-deploy-access.yaml`) created it. In the
   production account nothing has, so create exactly one, as `AdministratorAccess`:

   ```sh
   aws sts get-caller-identity --query Account --output text      # must print the PRODUCTION id — stop otherwise
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   aws iam list-open-id-connect-providers
   ```

   - **URL** `https://token.actions.githubusercontent.com`, **audience** `sts.amazonaws.com`, no
     thumbprint (IAM checks GitHub's certificate against its trusted CAs; if an older CLI insists
     on `--thumbprint-list`, use the console instead: **IAM → Identity providers → Add provider →
     OpenID Connect**, same URL and audience).
   - IAM allows one provider per issuer per account. If the list already shows it, do not create a
     second.
   - Expect the ARN `arn:aws:iam::<PRODUCTION_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`
     — the one the templates below reference through `AWS::AccountId`.

8. **Deploy the two access stacks from a reviewed commit, with `Stage=production`.** The templates
   take ONE parameter, `Stage`; everything stage-specific (the GitHub environment the trust admits,
   the role name, the one secret the migrations role may read) comes from the template's `StageMap`,
   and the account is the one the stack is deployed in. Same CloudShell session:

   ```sh
   aws sts get-caller-identity --query Account --output text      # must print the PRODUCTION id — stop otherwise
   SHA=<a merged main commit that contains the parameterized templates>
   BASE="https://raw.githubusercontent.com/elitemediagroup1/emgloop-platform/${SHA}/infra/connections/access"

   curl -fsSL -o github-deploy-access.yaml "${BASE}/github-deploy-access.yaml"
   aws cloudformation deploy --region us-east-1 \
     --stack-name LoopConnections-production-github-access \
     --template-file github-deploy-access.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides Stage=production
   aws cloudformation update-termination-protection --region us-east-1 \
     --stack-name LoopConnections-production-github-access --enable-termination-protection
   aws cloudformation describe-stacks --region us-east-1 \
     --stack-name LoopConnections-production-github-access --query "Stacks[0].Outputs"

   curl -fsSL -o github-migrate-access.yaml "${BASE}/github-migrate-access.yaml"
   aws cloudformation deploy --region us-east-1 \
     --stack-name LoopConnections-production-migrate-access \
     --template-file github-migrate-access.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides Stage=production
   aws cloudformation update-termination-protection --region us-east-1 \
     --stack-name LoopConnections-production-migrate-access --enable-termination-protection
   aws cloudformation describe-stacks --region us-east-1 \
     --stack-name LoopConnections-production-migrate-access --query "Stacks[0].Outputs"
   ```

   They create exactly two roles, nothing else:
   - `loop-connections-github-deploy-production` — trusted only for the token subject
     `repo:elitemediagroup1/emgloop-platform:environment:connections-production`; allowed only
     `sts:AssumeRole` on this account's four CDK bootstrap roles (deploy, file-publishing,
     image-publishing, lookup). Copy the `DeployRoleArn` output.
   - `loop-connections-migrate-github-production` — same trust; allowed only to read the secret
     `loop/connections/production/database-url`. Copy the `MigrateRoleArn` output. The
     **Deploy Prisma Migrations** workflow assumes it (step 11).

   `infra/connections/test/access.test.ts` and `test/migrate-access.test.ts` prove that
   `Stage=staging` (the default) renders exactly the identities already deployed in staging, and
   that `Stage=production` renders trust for `connections-production` only. **What it amounts to**
   is the same as for the Brain: whoever can run `connections-infra-deploy` for production is
   effectively an administrator of the production account. The controls are the environment's
   required reviewer (step 10), the OU guardrail (step 2) and the trail (step 3).

## Part 5 — Operator secrets (Secrets Manager, production account, us-east-1)

9. Create these BEFORE the first deploy. The stack **references** them; it never creates them, and
   the worker fails closed at boot without the sealing key, so a missing one crashes the first task
   and rolls the deploy back. Enter values in the console or CloudShell — never paste a real value
   into chat, a PR, an issue or a log.

   ```sh
   aws sts get-caller-identity --query Account --output text      # must print the PRODUCTION id — stop otherwise
   aws secretsmanager create-secret --region us-east-1 --name loop/connections/production/telegram \
     --secret-string '{"api_id":"REPLACE","api_hash":"REPLACE"}'     # the Telegram application production presents (my.telegram.org)
   aws secretsmanager create-secret --region us-east-1 --name loop/connections/production/connection-key \
     --secret-string "$(openssl rand -base64 32)"                     # NEW. Never the staging value.
   aws secretsmanager create-secret --region us-east-1 --name loop/connections/production/database-url \
     --secret-string 'REPLACE_WITH_PRODUCTION_NEON_DIRECT_URL'        # the production database, DIRECT endpoint (not -pooler)
   ```

   - `connection-key` seals every stored Telegram session. It is generated fresh here; a session
     sealed under staging's key cannot be opened under this one, and that is the point (Part 8).
   - `database-url` is the production Neon database the web tier uses — the worker writes
     `SourceConnection`/`SourceObservation` rows there. Use the **direct** endpoint.
   - `loop/connections/production/ai` is needed ONLY to activate AI content triage (Part 9). Create
     it then, as a JSON document `{"anthropic_api_key":"…"}`, with keys issued for production. Add
     `"openai_api_key"` only when OpenAI is commissioned (Part 9): its terms decision and recorded
     policy come first, and the key must exist before `CONNECTIONS_PRODUCTION_AI_PROVIDERS` lists it.
   - `conversation-secret` and `worker-control` are generated by the deploy itself — do not create
     them.

## Part 6 — The GitHub environment `connections-production`

10. Repository **Settings → Environments → New environment**. The name is part of the OIDC trust,
    so it must be exactly `connections-production`.

    | Setting | Value |
    |---|---|
    | Required reviewers | `elitemediagroup1` (Matt) |
    | Prevent self-review | **Off** (Matt is the only reviewer; with it on, no run could be approved) |
    | Allow administrators to bypass configured protection rules | **Off** |
    | Deployment branches and tags | **Selected branches:** `main` only; no tag rule |
    | Variable `CONNECTIONS_PRODUCTION_ACCOUNT_ID` | the 12-digit production account id (step 1) |
    | Variable `CONNECTIONS_PRODUCTION_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output (step 8) |
    | Variable `CONNECTIONS_PRODUCTION_ALERT_EMAIL` | **required:** the address the cost budget and the worker-down alarm notify |
    | Variable `CONNECTIONS_PRODUCTION_AI_ORG_ID` | leave unset until Part 9 |
    | Variable `CONNECTIONS_PRODUCTION_AI_PROVIDERS` | optional; unset means `anthropic` (Part 9). Listing a provider never approves it |
    | Variable `CONNECTIONS_PRODUCTION_AI_TASKS` | optional; unset means `telegram.content.triage` (Part 9) |
    | Variable `CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN` | the `MigrateRoleArn` output (step 8); read by **Deploy Prisma Migrations** (step 11) |
    | Environment secrets | **none** |

    These are variables, not secrets: an account id, two role ARNs, an address, an organization id
    and two optional lists. `connections-infra-deploy` reads exactly eleven `CONNECTIONS_*` variables across
    both stages and `Deploy Prisma Migrations` exactly two (`…_ACCOUNT_ID`, `…_MIGRATE_ROLE_ARN`);
    neither reads a GitHub secret at all (`test/access.test.ts` and `test/migrate-access.test.ts`
    check the lists).

    The workflow refuses to proceed for production when `CONNECTIONS_PRODUCTION_ACCOUNT_ID` is
    unset, not 12 digits, equal to the staging account or equal to the management account, or when
    `CONNECTIONS_PRODUCTION_ALERT_EMAIL` is empty — all before any credential is requested.

11. **Production migrations.** The connections tables (`SourceConnection`, `SourceObservation` and
    later ones) reach production only through the **Deploy Prisma Migrations** workflow
    (`.github/workflows/deploy-prisma-migrations.yml`). Since #330 it is production-aware the
    same way the deploy is: **Actions → Deploy Prisma Migrations → Run workflow**, branch `main`,
    `confirm: migrate loop-connections-production` (exact phrase; surrounding whitespace, repeated
    inner whitespace and letter case forgiven), then approve the `connections-production`
    environment gate — the gate comes first, so a mistyped phrase is found after approval and the
    retry needs a fresh approval. It checks that
    `CONNECTIONS_PRODUCTION_ACCOUNT_ID` equals the pinned `080891698678` and that
    `CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN` is a role in that account, takes OIDC credentials for
    that role bounded to that account, checks them again with STS, reads only
    `loop/connections/production/database-url` (masked, never printed), validates the schema, prints
    `migrate status` (informational: that command exits non-zero while migrations are pending, so
    the step is allowed to fail), runs `prisma migrate deploy` (the gate), and prints
    `migrate status` again (must pass). The log names the database and host, never the
    credentials. It reads no GitHub secret:
    the repository secret `DIRECT_DATABASE_URL` is no longer a migration path (the read-only
    `read-*` probes still use it). `connections-migrate-staging` never touches production. Check the
    migration state in that workflow's run history, not in a document. Until the tables exist, the
    production worker is healthy but each observation sweep fails gracefully.

## Part 7 — Deploy

12. **Actions → connections-infra-deploy → Run workflow**, branch `main`:
    - `stage: production`, `action: diff` first. It installs, runs the worker and infra tests,
      resolves the stage (account, role, address), checks the role ARN is in the production account,
      takes OIDC credentials bounded to that account, checks them again with STS, bundles, `cdk
      synth`, and shows the diff. Creates nothing.
    - `stage: production`, `action: deploy`, `confirm: deploy loop-connections-production`. Same
      checks, then applies. The environment's required reviewer approves the run before AWS is
      touched.

    The deploy builds the worker image and creates `LoopConnections-production`: the VPC (one NAT),
    the Fargate service, the internal ALB, the HTTPS HTTP API (VPC Link), the two generated secrets,
    the private media bucket and its signer — exactly staging's shape — plus what production
    requires: an SNS topic subscribed to the alert address, the monthly cost budget
    (`loop-connections-production-monthly`, 150 USD unless `-c monthlyBudgetUsd` says otherwise)
    and the alarm `loop-connections-production-worker-down` (no healthy target behind the load
    balancer for five minutes; missing data counts as down). Every resource is tagged
    `loop:stage=production`. Termination protection is on.

    **After the first deploy:**
    - **Confirm the SNS subscription.** AWS emails "Subscription Confirmation" to the alert address;
      until it is confirmed, the alarm notifies nobody. The budget emails need no confirmation.
    - Expect one ALARM and then one OK email during the first minutes: the alarm exists before the
      first task passes its health check.
    - Note the stack **Outputs**: `WorkerUrl`, `WorkerControlSecretArn`, `MediaBucketName`,
      `MediaSignerUrl`.


    **If the first deploy rolls back** (`ECS Deployment Circuit Breaker was triggered`, "Essential
    container in task exited", `ROLLBACK_COMPLETE`) — this happened on 2026-09-24:

    - **Read the cause first.** The worker writes exactly one line before it exits with code 1:
      CloudWatch Logs → log group `LoopConnections-production-WorkerLogs…` → stream
      `connections-worker/worker/<task id>` → `{"event":"worker_fatal","name":"NotConfigured",
      "message":"connections worker not configured: <SETTING> (…)"}`. The setting is named, the
      value never is. (The 2026-09-24 rollback left no log at all: the log group was created with
      a DESTROY policy and went down with the stack. Since #332 both log groups are retained.)
      A `name` other than `NotConfigured` carries no message; its meaning is in the worker source.
    - **The worker refuses to boot when** (`apps/connections-worker/src/config.ts`): `TELEGRAM_API_ID`
      is not a positive integer; `LOOP_CONNECTION_SECRET_KEY` does not decode from base64 to exactly
      32 bytes (a hex string, a short key, or the console's default *key/value* JSON all fail); or any
      of the six injected settings is blank. Of these, the operator-provided values are the
      `telegram` secret (JSON with `api_id` and `api_hash`) and `connection-key` (a plain base64
      string, stored as **plaintext**, not key/value). Check their shape without printing them:

      ```sh
      aws secretsmanager get-secret-value --region us-east-1 --secret-id loop/connections/production/connection-key --query SecretString --output text \
        | tr -d '\n' | base64 -d 2>/dev/null | wc -c        # must print 32
      aws secretsmanager get-secret-value --region us-east-1 --secret-id loop/connections/production/telegram --query SecretString --output text \
        | jq -c '[keys, (.api_id|type), (.api_id|tostring|test("^[1-9][0-9]*$")), (.api_hash|type), (.api_hash|tostring|length)]'
        # expect [["api_hash","api_id"],"string",true,"string",32]
      ```

      A wrong `connection-key` is replaced, not repaired — nothing has been sealed under it yet:
      `aws secretsmanager put-secret-value --region us-east-1 --secret-id loop/connections/production/connection-key --secret-string "$(openssl rand -base64 32)"`.
      A wrong `telegram` value is re-entered the same way with the JSON document from step 9.
    - **Delete the two generated secrets before the retry.** They are created with a RETAIN policy
      (CloudFormation reported them `DELETE_SKIPPED`), so they still exist with their fixed names,
      and the retry's `Create` of the same names fails with "already exists". Safe **only** while no
      Telegram session has been authorized and no observation written in production — both are
      true after a failed first deploy — and never afterwards:

      ```sh
      aws secretsmanager delete-secret --region us-east-1 --secret-id loop/connections/production/conversation-secret --force-delete-without-recovery
      aws secretsmanager delete-secret --region us-east-1 --secret-id loop/connections/production/worker-control --force-delete-without-recovery
      ```
    - **Remove the failed stack** so the retry can create it again. The stack was created with
      termination protection, which also blocks CDK's own delete-and-recreate of a
      `ROLLBACK_COMPLETE` stack:

      ```sh
      aws cloudformation update-termination-protection --region us-east-1 --stack-name LoopConnections-production --no-enable-termination-protection
      aws cloudformation delete-stack --region us-east-1 --stack-name LoopConnections-production
      aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name LoopConnections-production
      ```
    - Then dispatch `connections-infra-deploy` again: `diff`, then `deploy` with the phrase.
      A retained log group from the failed attempt stays behind (empty after its month of
      retention); delete it from the console when convenient.

13. **Set the web (Netlify production) environment** — production context only:
    `LOOP_CONNECTION_PROVIDERS=TELEGRAM`, `LOOP_CONNECTIONS_WORKER_URL=<WorkerUrl output>`,
    `LOOP_CONNECTIONS_WORKER_SECRET=<the generated worker-control value, read once from Secrets
    Manager at WorkerControlSecretArn>`. Redeploy the web tier. The web tier holds no
    session-sealing key and no AWS credential. (Creator media on the production signer is the
    Creator Hub's own runbook decision — `LOOP_MEDIA_STORAGE` — not part of this one.)

## Part 8 — Telegram must be authorized fresh in production

A Telegram session connected on staging **cannot** be opened in production, and nothing here tries
to copy one. Three separate reasons, any one of which is sufficient:
- **A different sealing key.** Stored sessions are sealed under the stage's `connection-key`
  (step 9). Production's key is generated fresh; a staging ciphertext is undecryptable under it.
- **A different organization and user.** A connection is bound to the organization and user ids
  that authorized it. Production's ids are production's, not staging's.
- **A different database.** The worker reads and writes the stage's own Neon database; staging's
  rows do not exist in production's.

So, in production: **Loop → Connections → Telegram → Connect → phone → code → (2FA) → Ready.**
Disconnect revokes at Telegram and clears the stored session, as in staging.

## Part 9 — Enable AI content triage (production)

Same mechanism as staging (`connections-aws-staging.md`, "Enable AI content triage"), with the
production names: create `loop/connections/production/ai` (step 9), set
`CONNECTIONS_PRODUCTION_AI_ORG_ID` on the `connections-production` environment to the real
production organization id (looked up in production data; never committed), and re-run
`connections-infra-deploy` with `stage: production`. **Create the secret before setting the
variable.** With the variable unset, no `LOOP_AI_*` reaches the worker and AI stays off. With the
variable set and the secret missing, AI also stays off -- but the task definition references a
secret that does not exist, tasks cannot start, and the deployment circuit breaker rolls the deploy
back: a loud failure, not a quiet one. To turn AI off, clear the variable and re-deploy.

`CONNECTIONS_PRODUCTION_AI_PROVIDERS` (default `anthropic`) and `CONNECTIONS_PRODUCTION_AI_TASKS`
(default `telegram.content.triage`) are optional variables on the same environment, with the same
format and synth-time validation as staging's; leave them unset for the Anthropic-only triage
described here. **Listing `openai` does not approve it** -- it only makes it callable. OpenAI in
production needs (1) a recorded `openai` provider policy through Record AI Provider Policy after the
data-terms decision, and (2) the `openai_api_key` field in `loop/connections/production/ai` BEFORE the
variable lists `openai`; without the field the task cannot start and the deploy rolls back. OpenAI
has not been commissioned in production.

**Then record the provider policy (G2) -- nothing is sent without it.** Since 2026-09-24 the stack no
longer sets `LOOP_AI_PROVIDER_TERMS_CONFIRMED` and nothing reads it; the approval is a stored control.
Run Actions → **Record AI Provider Policy** with `stage: production`, `provider: anthropic`,
`ceiling: COMMUNICATION_CONTENT`, `state: ACTIVE`, a reason naming the data terms reviewed (training,
retention, region), who reviewed them and when, and `confirm: record ai-provider-policy production`.
It runs in the `connections-production` environment (Matt as required reviewer) through the production
migrations role, reads only `loop/connections/production/database-url`, and prints the policies before
and after. Order: (1) Deploy Prisma Migrations (it carries `20261003000001_ai_provider_policy_controls`),
(2) record the policy, (3) deploy the worker. Without the record the worker refuses every triage call as
`POLICY_DENIED` and holds its frontier. `state: KILLED` stops all sends to that provider within 60
seconds, without a deploy.

**Record the operating budget (PR 1) -- optional, and a separate commissioning act.** The operating
budget (`ai_controls`, scope `BUDGET`: daily cost caps per organization and per lane, invocation caps,
breaker) is recorded, not deployed. **Without it production behaviour is unchanged** -- the reviewed
invocation and token caps plus the always-on $25 emergency ceiling (every organization, trailing 24
hours) -- and it is **not required to deploy PR 1**. Order: (1) Deploy Prisma Migrations (it carries
`20261005000000_ai_runtime_capacity`; without it the write is refused as `NOT_MIGRATED`), (2) Actions →
**Record AI Budget** with `stage: production`, `preset: initial`, `settings_json` empty, a one-line
reason naming the decision, and `confirm: record ai-budget production` (same environment, role and
secret as the provider policy; the dry run prints the current and requested budget in dollars before
the write), (3) verify in the closing `read:ai-provider-policy` output: `event=OPERATING_BUDGET
state=RECORDED ... organizationDailyUsd=20.00 emergencyUsd=25.00` (and `STORED_KILL` lines for any KILLED
platform control). The initial figures: $20 per organization per business day, $25 emergency; lanes
FORWARD $8, SYNTHESIS $6, INTERACTIVE $2.50, BACKGROUND $2 (at most 60 calls); FORWARD reserve $1.50;
BACKGROUND defers at $12 of organization spend or 75% of FORWARD used; invocation caps 70 / 10 / 6 per
class, 300 per organization, 360 globally; breaker 10 failures in 60 minutes. To raise limits later,
run it with `preset: custom` and `settings_json` as ONE LINE: the whole budget as a JSON object
(integer micro-dollars); anything above the code maximums ($100/day per organization, $125 emergency)
is refused with its codes printed and nothing written. Workers pick a change up within 60 seconds.
If the status/read output shows `OPERATING_BUDGET state=UNREADABLE`, every AI call is refused; record
corrected figures with this workflow (it replaces the unreadable version).

**The consent re-check inside `WorkItemRepository.detect` landed on `fix/detect-consent-recheck`
(PR #331) and must be on `main`, and in the deployed worker image,
before AI is turned on here.** Before it, a content sweep already in flight when an employee
revoked, or was offboarded, could still write one more derived item after the revoke committed: a
fresh OPEN paraphrase, or a refreshed title and evidence on a row the revoke had just minimized.
`detect` now reads the authorization inside the transaction that would write and refuses — no
create, no update, no observation, no audit — so "no derived item after the authorization ended"
holds at the write itself, not by a worker-side pre-check that would re-open the same window. The
worker logs `detect_refused` with a per-sweep count, never an id.

### Chats intelligence initialization (digest-only hydration)

Same mechanism, bounds, budget reserve and progress signals as staging
(`connections-aws-staging.md`, "Chats intelligence initialization"). With AI on, every production
person whose historical backfill already COMPLETED becomes eligible without re-authorizing; the sweep
writes CHATS digests only (never a WorkItem or a reconciliation) and stops at the budget reserve so
forward triage keeps at least 20 of the 50 daily calls. Order: (1) **Deploy Prisma Migrations** (it
carries `20261004000000_chats_intelligence_hydration`), (2) deploy the worker. Merging deploys the web
tier first; that is safe -- every other content-authorization read and write names only the
pre-existing columns, so nothing on the web path touches the new ones before the migration lands. Watch the `chats_hydration` log
line and **Read Telegram State** (`hydrationState` per authorization) until each reads `COMPLETE`.

## Part 10 — Open governance items (recorded here so they are not mistaken for cleared)

These are not blockers found in the code, the provider or the platform. They are decisions that
belong to Matt and that the repository does not yet hold. Commissioning proceeds on Matt's
instruction of 2026-09-24 (full staging parity, including AI content triage); nothing below is
represented as resolved.

1. **Counterparty consent and Telegram's terms — UNRESOLVED, not legally cleared.** With AI content
   triage on, the worker reads the bodies of messages that other people (the employee's
   counterparties) wrote, transiently, to derive minimized obligations. The repository records only
   the *employee's* own content authorization (`source_content_authorizations`) and the operator's
   recorded provider policy (`ai_controls`, scope `PROVIDER_POLICY` -- the reviewed data class per
   provider; it replaced `LOOP_AI_PROVIDER_TERMS_CONFIRMED` on 2026-09-24). It records nothing
   about counterparties' notice or consent, nothing about Telegram's API terms as they apply to
   this use, and no legal review of either. No technical or provider restriction that prevents
   deployment was identified; that is a different statement from "this is cleared". When a
   decision is made, record it (date, decider, reasoning) in
   `docs/architecture/daily-loop-employee-intelligence.md` §21 and update this item.

2. **What the platform does hold, so the decision is made against facts.** Bodies are never stored;
   what persists is a WorkItem carrying the model's minimized paraphrase (a topic, a next step, a
   grounded deadline) and Telegram's own label for the conversation, employee-private, plus the
   keyed provenance (conversation key, anchor event id, AI invocation id). Revoking content
   authorization closes those items with the `REVOKED` outcome and strips every content-derived
   field in the same transaction; a Telegram connection disconnected for 30 days
   (`WORK_DISCONNECT_GRACE_DAYS`) has its derived items deleted by the worker's retention sweep;
   ending a membership deletes them immediately. Audit rows record the acts, never the content.
