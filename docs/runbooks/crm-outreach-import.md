# CRM outreach import — production commissioning runbook (Slice 5, PR B)

**Status:** see the "Commissioning state" block at the end. **Production import execution is NOT
commissioned:** the workflow offers only `validate`, `inventory`, `record-config` and `dry-run`. The
command refuses anything else for the production target, and the import service refuses a non-local
APPLY on its own.

**Who does what:**
- **Matt:** every step in AWS (CloudShell, signed in through Identity Center to `080891698678`,
  **us-east-1**), every GitHub environment variable, every upload, and every workflow dispatch.
- **The `connections-production` environment today** (read 2026-10-07):
  - **Branch policy:** deployments from `main` only.
  - **Required reviewers: none.** Anyone with write access who dispatches from `main` runs in
    production at once.
  - **Recommended before the first real run:** add Matt as a required reviewer (Settings →
    Environments → `connections-production` → Required reviewers). That also gates the migration and
    other production workflows.
- **Claude:** has no AWS access and cannot dispatch workflows; it reads run logs and the review
  summaries.

**Rules:**
- Never put a source file, a review file or a contact value in the repository, a ticket, chat, a
  workflow input or a log.
- Never create an IAM user or an access key.
- The deploy and migrate roles are never widened for this import.

---

## Part 1 — The private source area and its identity (once)

1. **Check the account** in CloudShell:

   ```sh
   aws sts get-caller-identity --query Account --output text   # must print 080891698678
   ```

2. **Deploy the access stack** from the repository at `main`. Upload the file into CloudShell
   (Actions → Upload file), or `git clone` the public parts:

   ```sh
   aws cloudformation deploy \
     --region us-east-1 \
     --stack-name LoopCrmImport-production-source-access \
     --template-file crm-import-source-access.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --tags app=loop component=crm-import env=production
   aws cloudformation update-termination-protection --region us-east-1 \
     --stack-name LoopCrmImport-production-source-access --enable-termination-protection
   aws cloudformation describe-stacks --region us-east-1 \
     --stack-name LoopCrmImport-production-source-access --query 'Stacks[0].Outputs'
   ```

   It creates exactly three resources:
   - **The bucket `loop-crm-import-080891698678`:**
     - private: every public-access block on, owner-enforced ownership, no ACLs;
     - SSE-S3, versioned, TLS-only, and retained if the stack is deleted;
     - lifecycle: non-current source and config versions expire after 90 days; review artifacts
       after 90 days; incomplete uploads after 1 day.
   - **Its policy:** deny any request without TLS.
   - **The role `loop-crm-import-github-production`:**
     - assumable ONLY by `repo:elitemediagroup1/emgloop-platform:environment:connections-production`;
     - `s3:GetObject` and `s3:GetObjectVersion` on `crm-import/source/*` and `crm-import/config/*`;
     - `s3:PutObject` on `crm-import/review/*`;
     - nothing else: no list, no delete, no secret, no database, no deploy, no migration.

3. **Verify** before going on:

   ```sh
   B=loop-crm-import-080891698678
   aws s3api get-public-access-block --bucket $B
   aws s3api get-bucket-encryption --bucket $B
   aws s3api get-bucket-versioning --bucket $B
   aws s3api get-bucket-lifecycle-configuration --bucket $B
   aws iam get-role --role-name loop-crm-import-github-production --query 'Role.AssumeRolePolicyDocument'
   aws iam list-role-policies --role-name loop-crm-import-github-production
   ```

4. **Optional: object-level audit.** The organization trail records management events. To also
   record who read or wrote each object, add an S3 data-event selector for this bucket to the trail
   (Lake or trail advanced selectors). It costs per event; the volume here is tiny.

## Part 2 — The `connections-production` environment (once)

Add three **environment variables** (not secrets) in Settings → Environments →
`connections-production`:

| Variable | Value |
|---|---|
| `CRM_IMPORT_ROLE_ARN` | `arn:aws:iam::080891698678:role/loop-crm-import-github-production` |
| `CRM_IMPORT_BUCKET` | `loop-crm-import-080891698678` |
| `CRM_IMPORT_ORGANIZATION_SLUG` | the production organization the directory belongs to (its slug) |

The workflow refuses to run unless the role and bucket are exactly these, and unless the dispatched
organization equals the pinned slug.

**The identifier key.** The workflow passes the repository secret `COGNITIVE_HASH_SECRET` to the
import step only. This is the same mechanism the Gmail cycle uses. It must be the **same value the
production web app uses**, because exact Contact Point matching compares keyed hashes.
- **Nobody types or prints it.**
- **The dry run proves it:** it refuses with `HASH_KEY_MISMATCH` if any existing Contact Point was
  hashed under a different key. It prints a one-way `keyFingerprint`, never the key.

## Part 3 — Uploading a source and a configuration (every import)

1. **Export** the final structured directory to the canonical CSV of
   `docs/architecture/crm-outreach-import.md` §2. A spreadsheet is exported, never read by the importer.
2. **Hash** it locally, and keep the hash:

   ```sh
   sha256sum outreach-YYYY-MM-DD.csv
   ```

3. **Upload** it, as a human, from CloudShell or the console, signed in through Identity Center:

   ```sh
   aws s3 cp outreach-YYYY-MM-DD.csv s3://loop-crm-import-080891698678/crm-import/source/outreach-YYYY-MM-DD.csv --sse AES256
   aws s3api head-object --bucket loop-crm-import-080891698678 --key crm-import/source/outreach-YYYY-MM-DD.csv \
     --query '{version: VersionId, bytes: ContentLength, modified: LastModified}'
   ```

4. **The reviewed configuration** (`crm-outreach-import-config.v1`: creator aliases, routes, stage
   mapping) goes to `crm-import/config/<name>.json` the same way, with its own SHA-256.

## Part 4 — Running it

Actions → **CRM Outreach Import** → Run workflow, from `main`. If required reviewers are set on
`connections-production`, approve the gate when asked.

**Naming a source:** letters, digits, `.`, `_` and `-`, ending `.csv`. Use **no run of 7 or more
digits**: an ISO date is fine, `outreach-2026-10-07.csv`; `outreach-20261007.csv` is refused, because
provenance never holds anything shaped like a phone number.

| mode | inputs | writes |
|---|---|---|
| `validate` | `source_key`, `expected_source_sha256` | nothing |
| `inventory` | `source_key`, `expected_source_sha256` | the inventory detail to the review prefix |
| `record-config` | `config_key`, `expected_config_sha256`, `actor_user_id` (an OWNER/ADMIN's Loop user id) | the reviewed aliases and routes (governed, audited, append-only) |
| `dry-run` | all of the above | an import run and its entries; the review artifacts to the review prefix; **no canonical CRM record** |

Every mode also needs:
- `organization`, which must equal the pinned slug;
- `importer_version`, which is `crm-outreach-import.v1`;
- `confirm`: `crm import <mode> <organization>`.

**Reading the results:**
- **The run's summary** carries the importer's structured lines: codes, counts, ids, hashes, the dry
  run's id, `configFingerprint`, `planDigest` and `keyFingerprint`.
- **The review artifacts** are under `s3://loop-crm-import-080891698678/crm-import/review/run-<GitHub run id>/`.
  Download them in CloudShell:

  ```sh
  aws s3 cp --recursive s3://loop-crm-import-080891698678/crm-import/review/run-<id>/ ./review/
  ```

  `crm-import-review-PROTECTED-*.csv` holds addresses, numbers, titles and notes. Open it only on a
  trusted machine, and delete local copies after review.

## If the dry run refuses with `HASH_KEY_MISMATCH`

The workflow's `COGNITIVE_HASH_SECRET` is not the key the organization's existing Contact Points were
written under (the web app's). Exact matching cannot work, so nothing is planned.
- **Usual cause:** the repository secret differs from the production web app's value.
- **Fix:** set the repository secret to the web app's value, by typing it only into GitHub's secret
  form, never anywhere else. Then dispatch again. The run prints `keyFingerprint`, a one-way digest;
  compare it with the fingerprint the web app's writes record.
- **Do not work around it:** never bypass it and never re-key the stored Contact Points.

## Part 5 — What is NOT here

Production import execution:
- APPLY and approval run **local/test only** today.
- Commissioning them needs a separate, reviewed change after the real dry run has been reviewed and
  the stage mapping approved. **The first controlled import needs Matt's explicit approval of the
  real dry-run results.**

---

## Commissioning state (overwrite, don't append)

- **Implemented:** PR B: access template, workflow, the command's production target, inventory, and
  the hash-key check.
- **Deployed:** **no.** Parts 1 and 2 are Matt's.
- **Source uploaded:** **no.** The final structured source has not been provided (`FINAL_SOURCE_REQUIRED`).
- **Dry run in production:** **not run.**
- **APPLY:** **not commissioned; not approved.**
- **Import proven:** **no.**
