# Runbook: the Brain staging environment on AWS (`loop-brain-staging`)

**Status (2026-09-17): prepared, NOTHING CREATED.**
- **Who does it:** Matt, in the AWS and Neon consoles and on his own machine. Claude has no AWS or
  Neon access and has created nothing.
- **What it builds:** `docs/architecture/brain-aws-foundation.md`, whose §14 is the pre-deployment
  report.

**Order and gates:**
- Parts 1–5 are account and database setup.
- **Part 6 creates resources and needs Matt's explicit deployment authorization.**
- Part 7 changes a Loop (Netlify) deployment and **needs its own authorization**.
- Part 8 is the dark test.

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

## Part 1 — Organization and account (management account)

1. **Enable Organizations.** Sign in to the current account (it stays the management account) with an
   administrator (not root, once Identity Center exists). Open **AWS Organizations**. If there is no
   organization, choose **Create an organization** (all features).

2. **Create the workload account.** Go to **AWS accounts → Add an AWS account → Create an AWS
   account**:
   - **Account name:** `loop-brain-staging`.
   - **Email:** a new mailbox or alias Matt controls, used by no other AWS account.
   - **IAM role name:** leave `OrganizationAccountAccessRole`.

   Note the **account ID** it shows. Every `<ACCOUNT_ID>` below is this number, never the
   management account's.

3. **Group it.** Go to **AWS accounts → Actions → Create new** organizational unit `Workloads` under
   Root. Move `loop-brain-staging` into it.

4. **Guardrails (service control policy).**
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

   These `"*"` resources are deliberate: each statement denies the action everywhere in the OU.

5. **Audit trail.** In **CloudTrail → Trails → Create trail**:
   - **Name:** `loop-organization-trail`.
   - **Enable for all accounts in my organization:** on.
   - **Storage:** a new S3 bucket.
   - **Events:** management events, read and write.

   The first copy of management events carries no CloudTrail charge; S3 storage is cents.

6. **Cost alarm.** In **Billing and Cost Management → Budgets → Create budget**, choose a
   **monthly cost budget**:
   - **Amount:** $25.
   - **Scope:** filtered to **Linked account = loop-brain-staging**.
   - **Alerts:** at 50%, 80% and 100% (actual), to Matt's address.

   The stack can also create its own budget (Part 6); one budget is enough.

## Part 2 — People's access (IAM Identity Center)

7. **Set up Identity Center.**
   1. Open **IAM Identity Center** in **us-east-1** and choose **Enable** (organization instance,
      Identity Center directory).
   2. Under **Users**, create Matt's user. Require MFA: **Settings → Authentication → MFA**, "every
      time they sign in".
   3. Under **Permission sets**, create:
      - `AdministratorAccess` (predefined), session 1 hour. Setup only.
      - `LoopBrainOperator` (custom), session 1 hour: the AWS managed `ReadOnlyAccess` plus the inline
        policy below, for day-to-day stop and rollback without admin rights.
   4. Under **AWS accounts → loop-brain-staging → Assign users**, assign Matt both permission sets.

   The `LoopBrainOperator` inline policy (replace `<ACCOUNT_ID>`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ssm:PutParameter",
         "Resource": "arn:aws:ssm:us-east-1:<ACCOUNT_ID>:parameter/loop/brain/staging/*" },
       { "Effect": "Allow",
         "Action": ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"],
         "Resource": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:loop-brain-staging-*" },
       { "Effect": "Allow", "Action": "lambda:UpdateEventSourceMapping", "Resource": "*",
         "Condition": { "StringLike": { "lambda:FunctionArn": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:loop-brain-staging-*" } } },
       { "Effect": "Allow", "Action": "scheduler:UpdateSchedule",
         "Resource": "arn:aws:scheduler:us-east-1:<ACCOUNT_ID>:schedule/default/loop-brain-staging-*" },
       { "Effect": "Allow", "Action": ["secretsmanager:PutSecretValue"],
         "Resource": "arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:loop/brain/staging/neon-*" }
     ]
   }
   ```

   `lambda:UpdateEventSourceMapping` takes no resource-level ARN, so the function-ARN condition scopes
   it. Changing `scheduler:UpdateSchedule` may also need `iam:PassRole` for the schedule's role; add
   it for that one role ARN if the console asks.

8. **Set up the CLI on Matt's machine** (AWS CLI v2):

   ```sh
   aws configure sso            # profile name: loop-brain-staging; region us-east-1
   aws sso login --profile loop-brain-staging
   aws sts get-caller-identity --profile loop-brain-staging   # Account must be <ACCOUNT_ID>
   ```

## Part 3 — GitHub deploys without keys (in `loop-brain-staging`)

9. **Trust GitHub's identity provider.** Signed in to `loop-brain-staging` as `AdministratorAccess`,
   go to **IAM → Identity providers → Add provider**:
   - **Type:** OpenID Connect.
   - **Provider URL:** `https://token.actions.githubusercontent.com`.
   - **Audience:** `sts.amazonaws.com`.

10. **Create the deploy role.** Go to **IAM → Roles → Create role → Web identity**, pick that provider
    and audience, then finish with **no** permissions. Name it `loop-brain-github-deploy`.

    Then **Trust relationships → Edit** and replace the policy with:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
          "StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": "repo:elitemediagroup1/emgloop-platform:environment:brain-staging"
          }
        }
      }]
    }
    ```

    Add this inline policy, named `assume-cdk-bootstrap-roles`. CDK deploys by assuming its bootstrap
    roles, so the deploy role can do nothing else:

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Action": "sts:AssumeRole",
        "Resource": [
          "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-deploy-role-<ACCOUNT_ID>-us-east-1",
          "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-file-publishing-role-<ACCOUNT_ID>-us-east-1",
          "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-lookup-role-<ACCOUNT_ID>-us-east-1"
        ]
      }]
    }
    ```

11. **Create the GitHub environment.** In the repository's **Settings → Environments → New
    environment**, create `brain-staging`:
    - **Required reviewers:** Matt.
    - **Deployment branches:** selected branches, `main` only.
    - **Environment variables:**
      - `BRAIN_STAGING_DEPLOY_ROLE_ARN`: the role's ARN (not a secret).
      - `BRAIN_STAGING_ALARM_EMAIL` and `BRAIN_STAGING_BUDGET_EMAIL` (optional; leave unset for no
        subscription or budget).

12. **Add nothing else to GitHub.** No AWS secret, and no key anywhere.

## Part 4 — Account preparation

13. **Lambda concurrency.** The stack reserves 15 concurrent executions, and AWS keeps 100
    unreserved, so the account limit must be at least 115. New accounts often start at 10. Check:

    ```sh
    aws lambda get-account-settings --profile loop-brain-staging --query AccountLimit.ConcurrentExecutions
    ```

    If it is below 115, open **Service Quotas → AWS Lambda → Concurrent executions → Request increase**
    and ask for 1000. Wait for approval before Part 6.

14. **Bootstrap CDK** once, from an up-to-date `main` checkout, as `AdministratorAccess`:

    ```sh
    cd infra/brain && npm install
    npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 --profile loop-brain-staging
    ```

    This creates the `CDKToolkit` stack: an assets bucket and the roles named in step 10.

    **Trade-off:** its CloudFormation role has administrator rights inside this single-purpose
    account, within the Part 1 guardrails. To narrow it, pass
    `--cloudformation-execution-policies <a customer-managed policy ARN>` instead. That is a later
    hardening step.

## Part 5 — The staging database (Neon)

15. **Create the project.** In the Neon console choose **New project**:
    - **Name:** `loop-staging`.
    - **Postgres version:** as production.
    - **Region:** **AWS US East 1 (N. Virginia)**.

    It must be a new project, **never a branch of production**.

16. **Migrate it.** On Matt's machine, from `main`:

    ```sh
    read -rs STAGING_DIRECT_URL   # paste the project's DIRECT (non-pooled) owner URL; nothing echoes
    export STAGING_DIRECT_URL
    DATABASE_URL="$STAGING_DIRECT_URL" npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
    DATABASE_URL="$STAGING_DIRECT_URL" npx prisma migrate status --schema packages/database/prisma/schema.prisma
    ```

    The status must show 36 migrations applied and none pending. Before pasting, check the URL's host
    is the **staging** project's.

17. **Create the restricted roles** by following `docs/runbooks/brain-database-roles.md`, steps 2–4,
    with `DIRECT_DATABASE_URL="$STAGING_DIRECT_URL"`. Passwords are set interactively with
    `\password`.

18. **Put the three connection URLs into Secrets Manager.** This can only be done after Part 6
    creates the secrets. In the **Secrets Manager** console open `loop/brain/staging/neon-worker`,
    choose **Retrieve secret value → Edit → Plaintext**, and replace the placeholder with:

    ```json
    {"url":"postgresql://loop_brain_worker:<password>@<POOLED host>/<database>?sslmode=require"}
    ```

    Repeat for `neon-dispatcher` (`loop_brain_dispatcher`) and `neon-sweeper` (`loop_brain_sweeper`).
    - Use the **pooled** host, with the same query parameters production's pooled `DATABASE_URL` uses.
      The functions add `connection_limit=1` themselves.
    - Until a secret holds a URL, that function connects to nothing and fails as "not configured".
    - Afterwards, `unset STAGING_DIRECT_URL`.

## Part 6 — Deploy (ONLY with Matt's explicit authorization)

19. **Diff.** Go to **GitHub → Actions → brain-infra-deploy → Run workflow**, choose branch `main` and
    action `diff`, and approve the environment. Read the diff against the foundation record: §4
    (resources), §5 (IAM), §6 (secrets and parameters). **Stop if it differs.**

20. **Deploy.** Run the same workflow with action `deploy` and confirmation text
    `deploy loop-brain-staging`, then approve.
    - Record the outputs `DoorbellUrl` and `WorkerSigningKeyArn`.
    - Then do step 18.
    - The deployment leaves everything closed: no ring key pinned, no trusted caller, the worker
      switch `false`, the AI floor off, and the Loop base URL `UNSET`.

21. **Check.** In CloudFormation, `LoopBrain-staging` must be `CREATE_COMPLETE` with termination
    protection on. The provider secrets must hold `{"state":"UNSET",…}`.

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

All of these use the `loop-brain-staging` profile; effects are in foundation record §12.

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
2. `npx cdk destroy LoopBrain-staging --profile loop-brain-staging`.
3. The retained keys, secrets and log groups stay until deleted by hand: KMS keys have a 7–30 day
   waiting period, secrets 7–30 days.
4. Drop the Neon roles per `brain-database-roles.md`.
5. Remove the staging Loop variables.
