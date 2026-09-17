# Runbook: the Brain staging environment on AWS (Loop Brain Staging, `065148797865`)

**Status (2026-09-17): the accounts exist; NO BRAIN INFRASTRUCTURE HAS BEEN CREATED.**
- **Done by Matt (confirmed 2026-09-17):**
  - the AWS Organization; its management account is **EMG Loop Production, `670682108352`**;
  - the member account **Loop Brain Staging, `065148797865`**, region `us-east-1`;
  - the IAM Identity Center organization instance, and Matt's `AdministratorAccess` to Loop Brain
    Staging (console sign-in verified);
  - Cost Explorer, initialized from the management account (AWS says data can take up to 24 hours);
  - a Lambda concurrency increase to 1,000, **requested and pending**. The account is at 10.

  No IAM user or access key exists, and no Brain resource was created by hand.
- **Not done yet:**
  - CloudTrail (Loop Brain Staging shows no trail) and the budget;
  - the GitHub deploy identity and the `brain-staging` environment;
  - the CDK bootstrap, staging Neon and any deployment.
- **Who does it:** Matt, in the AWS, GitHub and Neon consoles. Claude has no AWS or Neon access and has
  created nothing.
- **Where AWS commands run: AWS CloudShell.** Open it from the console while signed in to the account
  the step names, with the console in **us-east-1**.
  - It uses that console session's short-lived credentials, so no key ever sits on a laptop.
  - It already has the AWS CLI, Node.js, npm, git, jq and psql.
  - Before every step that creates something, check the account:

    ```sh
    aws sts get-caller-identity --query Account --output text
    ```

  A laptop works too (step 8); then add `--profile loop-brain-staging` to the commands.
- **The target is fixed in code.** `infra/brain/lib/target.ts` pins the stack to `065148797865` /
  `us-east-1`, and the CDK app refuses credentials for any other account. The deploy workflow checks the
  role ARN and the credentials' account before it compares or applies anything.
- **What it builds:** `docs/architecture/brain-aws-foundation.md`, whose §14 is the pre-deployment
  report.

**Order and gates:**
- **Parts 1–5 are setup.** Steps 4 (the trail) and 14 (the bootstrap) create resources and need Matt's
  go-ahead; do step 4 first.
- **Part 6 deploys the Brain stack.** It needs Matt's explicit deployment authorization, and it waits
  for a Lambda quota of at least 118 (step 13).
- **Part 7 changes a Loop (Netlify) deployment** and needs its own authorization.
- **Part 8 is the dark test.**

**Rules that hold throughout:**
- **Never create an IAM user or an access key.** People use IAM Identity Center; GitHub uses OIDC.
- **Never point anything in this runbook at production Neon.** Never branch production for staging:
  a branch is a copy of production data.
- **Secret values** (database passwords, the doorbell private key) are typed or pasted only into the
  system that keeps them (Neon, Secrets Manager, Netlify). They never go into chat, a ticket, GitHub,
  a file in the repository or shell history.
- **Provider keys (Anthropic, OpenAI) are not part of this runbook.** Their secrets stay
  placeholders, and no role can read them.

---

## Part 1 — Organization governance (management account `670682108352`)

1. **Organization and accounts — DONE (Matt).**
   - The management account is **EMG Loop Production, `670682108352`**. Only steps 2–5 act here, and
     none of them creates Brain resources.
   - The member account is **Loop Brain Staging, `065148797865`**. Every other step works there.

2. **Group the account** (not yet confirmed; step 3 needs it). In **AWS Organizations → AWS
   accounts → Actions → Create new**, create the organizational unit `Workloads` under Root. Move Loop
   Brain Staging into it.

3. **Guardrails (service control policy)** (recommended before step 14).
   1. Go to **Policies → Service control policies → Enable**.
   2. Choose **Create policy**, name it `loop-workloads-guardrails`, and paste the policy below.
   3. **Attach** it to `Workloads` (not to Root).

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "StayInOrganization", "Effect": "Deny", "Action": "organizations:LeaveOrganization", "Resource": "*" },
       { "Sid": "NoLongLivedUserCredentials", "Effect": "Deny",
         "Action": ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"], "Resource": "*" },
       { "Sid": "KeepTheTrail", "Effect": "Deny",
         "Action": ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail"], "Resource": "*" },
       { "Sid": "UsEast1Only", "Effect": "Deny",
         "NotAction": ["iam:*", "sts:*", "organizations:*", "account:*", "sso:*", "identitystore:*",
                       "budgets:*", "ce:*", "cur:*", "health:*", "support:*", "trustedadvisor:*",
                       "cloudfront:*", "route53:*", "route53domains:*", "waf:*", "shield:*",
                       "globalaccelerator:*", "pricing:*", "notifications:*"],
         "Resource": "*",
         "Condition": { "StringNotEquals": { "aws:RequestedRegion": "us-east-1" } } }
     ]
   }
   ```

   - **The `"*"` resources are deliberate:** each statement denies the action everywhere in the OU.
   - **Why it matters here:** a guardrail binds even an administrator of Loop Brain Staging. The CDK
     deploy path is effectively one (step 9).

4. **Organization trail** (required before step 14). The staging account has no trail today. One
   trail for the whole organization is the governance choice:
   - member accounts can see it but cannot stop, change or delete it;
   - accounts added later are covered automatically.

   In the **CloudTrail** console of `670682108352`, in **us-east-1**, choose **Trails → Create trail**:
   - **Trail name:** `emg-loop-organization-trail`.
   - **Enable for all accounts in my organization:** on. Trails created in the console log every
     enabled Region.
   - **Storage location:** a new S3 bucket (in the management account).
   - **Log file SSE-KMS encryption:** on, with a new KMS key, alias `emg-loop-organization-trail`
     (about $1 a month).
   - **Log file validation:** on.
   - **SNS notification** and **CloudWatch Logs:** off.
   - **Events:** management events only, API activity **Read** and **Write**. No data events, Insights
     events or network activity events.

   Then, in CloudShell in **Loop Brain Staging**, the trail must be listed as an organization trail:

   ```sh
   aws cloudtrail describe-trails --region us-east-1 \
     --query "trailList[].[Name,IsOrganizationTrail,IsMultiRegionTrail,HomeRegion]"
   ```

   - **Cost:** AWS's pricing page says one copy of management events is free, but not how that
     applies to member accounts. Expect cents of S3 storage plus the key; check the first bill.
   - **Later:** move the log bucket to a dedicated log-archive account.

5. **One central budget** (management account). In **Billing and Cost Management → Budgets → Create
   budget**, choose **Customize → Cost budget**:
   - **Name:** `loop-brain-staging-monthly`.
   - **Amount:** monthly, recurring, fixed **$100**.
   - **Scope:** filter **Linked account = Loop Brain Staging (`065148797865`)**.
   - **Alerts:** 50%, 80% and 100% of actual cost, and 100% of forecasted cost, to Matt's address.

   If the linked-account filter does not list the account yet, wait for Cost Explorer data. **This is
   the only budget:** leave `BRAIN_STAGING_BUDGET_EMAIL` unset (step 11), or the stack would create a
   second one, of $25.

## Part 2 — People's access (IAM Identity Center)

6. **Identity Center — DONE (Matt).**
   - The organization instance is enabled in **us-east-1**.
   - Matt signs in to Loop Brain Staging with `AdministratorAccess` through the access portal.
   - **Confirm** that MFA is required: **Settings → Authentication → MFA**, "every time they sign in".
   - Keep `AdministratorAccess` sessions at 1 hour, and use them for the setup steps in this runbook
     only.

7. **Create `LoopBrainOperator`** (recommended before Part 6), for day-to-day stop and rollback
   without admin rights.
   1. Under **Permission sets**, create `LoopBrainOperator` (custom), session 1 hour: the AWS managed
      `ReadOnlyAccess` plus the inline policy below.
   2. Under **AWS accounts → Loop Brain Staging → Assign users**, assign Matt `LoopBrainOperator`.

   The inline policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ssm:PutParameter",
         "Resource": "arn:aws:ssm:us-east-1:065148797865:parameter/loop/brain/staging/*" },
       { "Effect": "Allow",
         "Action": ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"],
         "Resource": "arn:aws:lambda:us-east-1:065148797865:function:loop-brain-staging-*" },
       { "Effect": "Allow", "Action": "lambda:UpdateEventSourceMapping", "Resource": "*",
         "Condition": { "StringLike": { "lambda:FunctionArn": "arn:aws:lambda:us-east-1:065148797865:function:loop-brain-staging-*" } } },
       { "Effect": "Allow", "Action": "scheduler:UpdateSchedule",
         "Resource": "arn:aws:scheduler:us-east-1:065148797865:schedule/default/loop-brain-staging-*" },
       { "Effect": "Allow", "Action": ["secretsmanager:PutSecretValue"],
         "Resource": "arn:aws:secretsmanager:us-east-1:065148797865:secret:loop/brain/staging/neon-*" }
     ]
   }
   ```

   - `lambda:UpdateEventSourceMapping` takes no resource-level ARN, so the function-ARN condition
     scopes it.
   - `scheduler:UpdateSchedule` may also need `iam:PassRole` for the schedule's role. Add it for that
     one role ARN if the console asks.

8. **A laptop instead of CloudShell** (optional). With AWS CLI v2:

   ```sh
   aws configure sso            # profile name: loop-brain-staging; account 065148797865; region us-east-1
   aws sso login --profile loop-brain-staging
   aws sts get-caller-identity --profile loop-brain-staging --query Account --output text   # must print 065148797865
   ```

## Part 3 — The GitHub deploy identity (in Loop Brain Staging)

9. **Create the OIDC provider and the deploy role from the committed template.** Do this once, as
   `AdministratorAccess`, in CloudShell in Loop Brain Staging (us-east-1).
   - **The template:** `infra/brain/access/github-deploy-access.yaml`, checked by
     `infra/brain/test/access.test.ts`.
   - **Take it from a merged `main` commit**, so what runs is what was reviewed:

    ```sh
    aws sts get-caller-identity --query Account --output text      # must print 065148797865 — stop otherwise
    MAIN_SHA=<a merged main commit that contains the template>
    curl -fsSL -o github-deploy-access.yaml \
      "https://raw.githubusercontent.com/elitemediagroup1/emgloop-platform/${MAIN_SHA}/infra/brain/access/github-deploy-access.yaml"
    aws cloudformation deploy --region us-east-1 \
      --stack-name LoopBrain-staging-github-access \
      --template-file github-deploy-access.yaml \
      --capabilities CAPABILITY_NAMED_IAM
    aws cloudformation update-termination-protection --region us-east-1 \
      --stack-name LoopBrain-staging-github-access --enable-termination-protection
    ```

    It creates exactly two things:
    - **the IAM OIDC identity provider** `token.actions.githubusercontent.com`, for audience
      `sts.amazonaws.com`. No thumbprint: IAM checks GitHub's certificate against its trusted CAs;
    - **the role `loop-brain-github-deploy`:**
      - 1-hour sessions;
      - trusted only for the token subject
        `repo:elitemediagroup1/emgloop-platform:environment:brain-staging`;
      - allowed only `sts:AssumeRole` on the CDK deploy, file-publishing and lookup roles (step 14).

    **Why a separate stack, deployed by hand:**
    - the pipeline must not manage the identity it runs as;
    - this template needs neither the CDK bootstrap nor assets.

    **What it amounts to:** the CDK deploy role can change *any* stack in this account through
    CloudFormation's administrator execution role. Whoever can run `brain-infra-deploy` is therefore
    effectively an administrator of Loop Brain Staging. The controls are step 11 (who can run it),
    step 3 (what nobody here can do) and step 4 (the record).

    **If the repository is renamed or transferred,** GitHub switches it to its immutable token-subject
    format and this trust stops matching. That fails closed; update the subject in a reviewed PR.

10. **Check it:**

    ```sh
    aws cloudformation describe-stacks --region us-east-1 --stack-name LoopBrain-staging-github-access \
      --query "Stacks[0].[StackStatus,EnableTerminationProtection,Outputs]"
    aws iam get-role --role-name loop-brain-github-deploy --query "Role.AssumeRolePolicyDocument"
    ```

    Expect:
    - `CREATE_COMPLETE` and `true`;
    - `DeployRoleArn` = `arn:aws:iam::065148797865:role/loop-brain-github-deploy`;
    - the trust policy exactly as in the template.

11. **Create the GitHub environment.** Go to the repository's **Settings → Environments → New
    environment**. The name is part of the trust, so it must be exactly `brain-staging`.

    | Setting | Value |
    |---|---|
    | Required reviewers | `elitemediagroup1` |
    | Prevent self-review | **Off.** Matt is the only reviewer; with it on, no run could be approved |
    | Allow administrators to bypass configured protection rules | **Off** |
    | Wait timer | 0 |
    | Deployment branches and tags | **Selected branches and tags:** branch `main` only; no tag rule |
    | Variable `BRAIN_STAGING_DEPLOY_ROLE_ARN` | `arn:aws:iam::065148797865:role/loop-brain-github-deploy` (not a secret) |
    | Variable `BRAIN_STAGING_ALARM_EMAIL` | the address for alarm email (optional; AWS sends a link to confirm) |
    | Variable `BRAIN_STAGING_BUDGET_EMAIL` | **unset.** The budget is step 5 |
    | Environment secrets | **none** |

    `brain-infra-deploy` checks the account three times:
    1. before asking for credentials, it refuses a role outside `065148797865`;
    2. after, it refuses credentials for any other account (`allowed-account-ids`, then an explicit
       `sts get-caller-identity` check);
    3. the CDK app refuses as well.

12. **Add nothing else to GitHub.** No AWS secret, and no key anywhere. Also recommended: a ruleset on
    `main` that requires a pull request and blocks force pushes, because the environment deploys
    whatever `main` holds.

## Part 4 — Account preparation (in Loop Brain Staging)

13. **Lambda concurrency.** The stack reserves 18 concurrent executions: authorizer 5, dispatcher 5,
    interactive worker 5, durable worker 2, sweeper 1.
    - Lambda lets functions reserve only what leaves 100 unreserved, so the account limit must be at
      least **118**. It is 10 today, and an increase to 1,000 is pending.
    - **The applied limit is what counts,** not the request's status:

      ```sh
      aws lambda get-account-settings --region us-east-1 \
        --query "AccountLimit.[ConcurrentExecutions,UnreservedConcurrentExecutions]"
      ```

    - **Part 6 waits** until the first number is 118 or more.
    - **Step 14 does not wait:** the bootstrap creates no function.

14. **Bootstrap CDK** once. **NOT DONE. It creates resources, so it waits for Matt's go-ahead and for
    step 4.** Run it in CloudShell in Loop Brain Staging, as `AdministratorAccess`, **from the home
    directory, not from a checkout of this repository**:

    ```sh
    cd ~ && ls cdk.json 2>/dev/null                                  # must print nothing
    aws sts get-caller-identity --query Account --output text      # must print 065148797865 — stop otherwise
    npx --yes aws-cdk@2.1142.0 bootstrap aws://065148797865/us-east-1 --termination-protection
    aws cloudformation describe-stacks --region us-east-1 --stack-name CDKToolkit \
      --query "Stacks[0].[StackStatus,EnableTerminationProtection]"
    aws ssm get-parameter --region us-east-1 --name /cdk-bootstrap/hnb659fds/version --query Parameter.Value
    ```

    Expect `CREATE_COMPLETE`, `true` and `"32"`.

    - **Why not from `infra/brain`:** in a directory with `cdk.json`, `cdk bootstrap` synthesizes the
      app even when the environment is given. The Brain app fails without its built bundles ("Cannot
      find asset").
    - **The CLI version:** `aws-cdk@2.1142.0` is the one `infra/brain` pins.
    - **On a laptop:** the same command works from any directory without `cdk.json`, with
      `--profile loop-brain-staging`.

    **Where:** Loop Brain Staging (`065148797865`), `us-east-1` only. Nothing is created in the
    management account.

    **What it creates:** one CloudFormation stack, `CDKToolkit`, from bootstrap template version 32
    (the one `aws-cdk` 2.1142.0 carries; the Brain stack needs version 6 or later). Its resources:

    | Resource | Name |
    |---|---|
    | S3 bucket for the function zips and the template. Versioned, public access blocked, TLS-only bucket policy, encrypted with the AWS-managed S3 key | `cdk-hnb659fds-assets-065148797865-us-east-1` |
    | ECR repository for image assets. It stays empty: the Brain has none | `cdk-hnb659fds-container-assets-065148797865-us-east-1` |
    | IAM role CloudFormation uses to create the stack's resources | `cdk-hnb659fds-cfn-exec-role-065148797865-us-east-1` |
    | IAM role the CLI assumes to deploy | `cdk-hnb659fds-deploy-role-065148797865-us-east-1` |
    | IAM role that uploads the zips | `cdk-hnb659fds-file-publishing-role-065148797865-us-east-1` |
    | IAM role that would upload images (unused) | `cdk-hnb659fds-image-publishing-role-065148797865-us-east-1` |
    | IAM role for read-only lookups (the CLI uses it to read the deployed template) | `cdk-hnb659fds-lookup-role-065148797865-us-east-1` |
    | SSM parameter recording the bootstrap version | `/cdk-bootstrap/hnb659fds/version` |

    - **The roles' trust:** the deploy, file-publishing and lookup roles trust principals in this
      account, which is how step 9's role reaches them.
    - **No customer-managed KMS key:** for a new bootstrap the CLI chooses the AWS-managed S3 key.
    - **No customization:** the default qualifier `hnb659fds`, and no `--trust` of another account.
    - **Termination protection:** `--termination-protection` keeps `CDKToolkit` from being deleted by
      mistake.
    - **Cost:** under a cent a month. Each deployed version uploads about 38 MB of zips, and an empty
      repository costs nothing.
    - **The CLI prints a warning** that the default execution policy is `AdministratorAccess`. That is
      the trade-off below.

    **Trade-off:** the CloudFormation role has administrator rights inside this single-purpose
    account, within the Part 1 guardrails.
    - Only CloudFormation can assume it.
    - The GitHub deploy role (step 9) can assume only the deploy, file-publishing and lookup roles.
    - Deployment still needs Matt's approval in the `brain-staging` environment.

    To narrow it, bootstrap with `--cloudformation-execution-policies <a customer-managed policy ARN>`
    instead. That is a hardening step before production.

## Part 5 — The staging database (Neon)

15. **Create the project.** In the Neon console choose **New project**:
    - **Name:** `loop-staging`.
    - **Postgres version:** as production.
    - **Region:** **AWS US East 1 (N. Virginia)**.

    It must be a new project, **never a branch of production**.

16. **Migrate it.** Run this from a checkout of `main`: on Matt's machine, or in CloudShell after
    `git clone --depth 1 https://github.com/elitemediagroup1/emgloop-platform && cd emgloop-platform`.
    It applies the migrations already on `main`; it creates none.

    ```sh
    read -rs STAGING_DIRECT_URL   # paste the project's DIRECT (non-pooled) owner URL; nothing echoes
    export STAGING_DIRECT_URL
    DATABASE_URL="$STAGING_DIRECT_URL" npx --yes prisma@5.22.0 migrate deploy --schema packages/database/prisma/schema.prisma
    DATABASE_URL="$STAGING_DIRECT_URL" npx --yes prisma@5.22.0 migrate status --schema packages/database/prisma/schema.prisma
    ```

    `prisma@5.22.0` is the version the repository uses. An unpinned `npx prisma` outside an installed
    checkout would fetch a different major version.

    The status must show 36 migrations applied and none pending. Before pasting, check the URL's host
    is the **staging** project's.

17. **Create the restricted roles** by following `docs/runbooks/brain-database-roles.md`, steps 2–4,
    with `DIRECT_DATABASE_URL="$STAGING_DIRECT_URL"`. Passwords are set interactively with
    `\password`.

18. **Put the three connection URLs into Secrets Manager.** This can only be done after Part 6
    creates the secrets. In the **Secrets Manager** console open `loop/brain/staging/neon-worker`,
    choose **Retrieve secret value → Edit → Plaintext**, and replace the placeholder with:

    ```json
    {"url":"postgresql://loop_brain_worker:<password>@<POOLED host>/<database>?sslmode=require&sslaccept=strict"}
    ```

    Repeat for `neon-dispatcher` (`loop_brain_dispatcher`) and `neon-sweeper` (`loop_brain_sweeper`).
    - Use the **pooled** host. Percent-encode any special character in the password.
    - **TLS is enforced.** The functions refuse a URL without `sslmode=require`, and any `sslaccept`
      other than `strict`: Prisma 5 otherwise accepts any server certificate. They add
      `sslaccept=strict` and `connection_limit=1` when the URL omits them.
    - Until a secret holds a URL, that function connects to nothing and fails as "not configured".
    - Afterwards, `unset STAGING_DIRECT_URL`.

## Part 6 — Deploy (ONLY with Matt's explicit authorization)

**Before step 19, all of these hold:**
- step 4: the organization trail is logging;
- step 5: the budget exists;
- steps 9–11: the deploy identity and the `brain-staging` environment exist;
- step 13: the applied Lambda limit is 118 or more;
- step 14: `CDKToolkit` is `CREATE_COMPLETE`;
- Part 5: step 18 can follow the deployment at once.

19. **Diff.** Go to **GitHub → Actions → brain-infra-deploy → Run workflow**, choose branch `main` and
    action `diff`, and approve the environment.
    - Before comparing, the workflow checks that the deploy role and the credentials are both in
      `065148797865`. The CDK app refuses any other account as well.
    - Read the diff against the foundation record: §4 (resources), §5 (IAM), §6 (secrets and
      parameters). **Stop if it differs.**

20. **Deploy.** Run the same workflow with action `deploy` and confirmation text
    `deploy loop-brain-staging`, then approve.
    - Record the outputs `DoorbellUrl` and `WorkerSigningKeyArn`.
    - **Then do step 18 at once.** Until the sweeper's secret holds a URL, every 5-minute sweep fails
      as "not configured" and raises the `sweeper-errors` alarm.
    - If `BRAIN_STAGING_ALARM_EMAIL` is set, confirm the subscription from the email AWS sends.
    - The deployment leaves everything closed: no ring key pinned, no trusted caller, the worker
      switch `false`, the AI floor off, and the Loop base URL `UNSET`.
    - **If the first deployment fails** (for example, a Lambda limit below 118), CloudFormation rolls
      it back and deletes what it created. The keys, secrets and log groups are kept on update and
      on stack deletion, but not when their own creation is rolled back (`RetainExceptOnCreate`).
      CloudFormation deletes secrets without a recovery window, so the fixed names are free again.
      Fix the cause and run the workflow again.

21. **Check.**
    - In CloudFormation, `LoopBrain-staging` must be `CREATE_COMPLETE` with termination protection on.
    - The provider secrets must still hold `{"state":"UNSET",…}`.
    - The stack must contain no budget (the budget is step 5).
    - The step 4 trail must show the deployment's CloudFormation calls.

## Part 7 — Wire a staging Loop to it (a Netlify change: needs its own authorization)

**The staging Loop deployment:**
- is a Netlify deploy context that uses the staging database (Part 5) as its `DATABASE_URL`;
- holds **no provider key** (no Anthropic or OpenAI variable).

**Never set any of these on production.**

22. **The doorbell key pair**, on Matt's machine, in a private temporary directory:

    ```sh
    umask 077; cd "$(mktemp -d)"
    openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out doorbell.key
    openssl ec -in doorbell.key -pubout -out doorbell.pub
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/doorbell/public-keys \
      --type String --overwrite --value "$(jq -cn --rawfile pem doorbell.pub '{"loop-doorbell-staging-1": $pem}')"
    ```

    Set these on the staging Loop context:

    | Variable | Value |
    |---|---|
    | `LOOP_BRAIN_DOORBELL_SIGNING_KEY` | the contents of `doorbell.key` (secret) |
    | `LOOP_BRAIN_DOORBELL_KEY_ID` | `loop-doorbell-staging-1` |
    | `LOOP_BRAIN_DOORBELL_URL` | the `DoorbellUrl` output |
    | `LOOP_BRAIN_DOORBELL_ISSUER` | `loop-web-staging` |
    | `LOOP_BRAIN_DOORBELL_SUBJECT` | `netlify-staging` |

    Then delete the directory: `rm -rf "$PWD"`.

23. **Trust that caller on AWS:**

    ```sh
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/doorbell/trusted-issuers --type String --overwrite --value loop-web-staging
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/doorbell/trusted-callers --type String --overwrite --value netlify-staging
    ```

24. **Let Loop trust the workers.** Export the public half of the signing key (the private half cannot
    leave KMS):

    ```sh
    aws kms get-public-key --profile loop-brain-staging --key-id alias/loop-brain-staging-worker-signing \
      --query PublicKey --output text | base64 --decode | openssl pkey -pubin -inform DER -out worker.pem
    jq -cn --rawfile pem worker.pem '{"worker-2026-1": $pem}'
    ```

    Set these on the staging Loop context:

    | Variable | Value |
    |---|---|
    | `LOOP_BRAIN_WORKER_PUBLIC_KEYS` | the JSON printed above |
    | `LOOP_BRAIN_WORKER_ISSUERS` | `loop-brain-staging` |
    | `LOOP_BRAIN_WORKER_SUBJECTS` | `worker-interactive,worker-durable` |

25. **Tell the workers where Loop is** (https only):

    ```sh
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/loop/internal-base-url --type String --overwrite --value https://<staging-loop-host>
    ```

## Part 8 — The dark test

**Prerequisites.** Parts 1–7 are done, plus the following, **not all of which exist yet**:
- **A synthetic organization and user** in the staging database. There is no seed for the Brain dark
  test yet.
- **Loop accepts Brain work only when AI is activated** for that organization and task:
  - the `LOOP_AI_*` floor on the staging Loop context;
  - ACTIVE stored controls in the staging database.

  **No tool writes stored controls yet** (B3 §17 plans a reviewed operations workflow). Activating
  staging calls no provider:
  - the runtime contains no provider client;
  - no role can read a provider secret;
  - the staging Loop holds no provider key.

  It is still Matt's decision.
- **A Brain task registered for a real subject.** Case Explanation is the only product task.

**Steps.**

26. **Open the worker**, for the test only:

    ```sh
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/worker/enabled --type String --overwrite --value true
    aws ssm put-parameter --profile loop-brain-staging --name /loop/brain/staging/ai/floor --type String --overwrite \
      --value '{"enabled":true,"organizations":["<staging org id>"],"tasks":["case.explanation"],"providers":[],"killSwitches":[]}'
    ```

27. **Run and expect:**

    | Test | Expected |
    |---|---|
    | Submit one Case Explanation job from the staging Loop | the job ends FAILED `COMMIT_REFUSED`; step `commit.result` failure `OWNER_GATE_UNAVAILABLE`; no `ai_invocations` row; CloudWatch shows `dispatch.dispatched`, `worker.commit_boundary` and `worker.job_failed` |
    | Submit again with the same idempotency key | the same job; nothing runs twice |
    | Send `POST <DoorbellUrl>` with no token, an expired token and a reused token | 401 / 403; `DoorbellRefused` rises; nothing is queued |
    | Set `worker/enabled` to `false`, then submit | CANCELLED `KILL_SWITCH` (`worker-switch`) |
    | Set worker reserved concurrency to 0, submit, wait, restore | the job stays ACCEPTED, then runs after the restore |
    | Wait 5 minutes after a job whose ring was blocked (doorbell key removed) | the sweeper recovers it |

28. **Close again:** `worker/enabled` back to `false`, and the floor back to
    `{"enabled":false,"organizations":[],"tasks":[],"providers":[],"killSwitches":[]}`.

## Stop, kill and roll back

Run these in CloudShell in Loop Brain Staging, with the console in us-east-1. On a laptop, add
`--profile loop-brain-staging`. Effects are in foundation record §12.

```sh
# Stop all work at the next boundary (5 s)
aws ssm put-parameter --name /loop/brain/staging/worker/enabled --type String --overwrite --value false
# Break glass: no worker runs at all
aws lambda put-function-concurrency --function-name loop-brain-staging-worker-interactive --reserved-concurrent-executions 0
aws lambda put-function-concurrency --function-name loop-brain-staging-worker-durable --reserved-concurrent-executions 0
# Stop queues feeding workers (messages kept)
aws lambda list-event-source-mappings --function-name loop-brain-staging-worker-durable --query 'EventSourceMappings[].UUID'
aws lambda update-event-source-mapping --uuid <uuid> --no-enabled
# Refuse every ring
aws ssm put-parameter --name /loop/brain/staging/doorbell/public-keys --type String --overwrite --value '{}'
# Stop recovery sweeps
aws scheduler get-schedule --name loop-brain-staging-sweep     # copy its target and flexible window
aws scheduler update-schedule --name loop-brain-staging-sweep --state DISABLED --schedule-expression 'rate(5 minutes)' --flexible-time-window Mode=OFF --target '<the target JSON>'
```

**Roll back to the previous version.** Re-run `brain-infra-deploy` from the previous `main` commit.

**Remove the environment:**
1. Turn off termination protection on `LoopBrain-staging`.
2. Delete the stack. Either run `aws cloudformation delete-stack --region us-east-1 --stack-name
   LoopBrain-staging`, or, from `infra/brain` after `npm run bundle`, `npx cdk destroy
   LoopBrain-staging`.
3. The keys, secrets and log groups outlive the stack (`RetainExceptOnCreate`) until deleted by hand.
   KMS keys have a 7–30 day waiting period, and secrets a 7–30 day recovery window.
4. Drop the Neon roles per `brain-database-roles.md`.
5. Remove the staging Loop variables.
6. Only when retiring staging entirely, also remove the deploy identity and the bootstrap: turn off
   their termination protection, then delete `LoopBrain-staging-github-access` and `CDKToolkit`.
   Empty the assets bucket first.
