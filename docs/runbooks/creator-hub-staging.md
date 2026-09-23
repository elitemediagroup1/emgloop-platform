# Creator Hub — staging deployment and demo seed

## Deployment order (Matt; each step is a workflow or a Netlify setting, in this order)

1. **Merge the Creator Hub PR** to `main`. The `connections-staging` environment allows deployments
   from `main` only, so nothing below can run from the branch.
2. **Deploy the media signer:** Actions → **connections-infra-deploy** → `action: diff` (read it: one
   private S3 bucket, one Lambda, one `/media/sign` route on the existing control API), then
   `action: deploy` + `confirm: deploy loop-connections-staging`, and approve the run. The stack now
   outputs `MediaBucketName` and `MediaSignerUrl`; `WorkerUrl` is unchanged.
3. **Turn media storage on for the web tier:** Netlify → site `emgloop2` → Environment variables →
   add `LOOP_MEDIA_STORAGE` = `aws` scoped to the **staging** branch context only. The signer is
   reached through the `LOOP_CONNECTIONS_WORKER_URL` / `LOOP_CONNECTIONS_WORKER_SECRET` pair staging
   already has; no bucket name, no AWS credential and no new secret reach Netlify.
4. **Apply the migration:** Actions → **connections-migrate-staging** → `confirm: migrate
   loop-connections-staging`. It applies `20260930000000_creator_hub_foundation` (additive only) to the
   staging Neon database. Production migrations stay on `Deploy Prisma Migrations`, untouched.
5. **Seed the demo** (below).
6. **Fast-forward the `staging` branch** to `main` (Netlify builds `staging--emgloop2.netlify.app`
   from it). Until step 4 has run, do not point `staging` at this code: the Work OS detail pages read
   the new tables.


One workflow puts everything Matt and Charlie need to test the Creator Hub end to end into the
**staging** database. It never touches production: it reads only the staging secret
(`loop/connections/staging/database-url`) through the staging OIDC role, and the script itself
refuses unless `LOOP_SEED_TARGET=staging` **and** the database host is `*.neon.tech` or local.
Production is also on Neon, so the host check is not the boundary — the secret path and the human
assertion are. Never point this script at a production URL by hand.

## Run it

Actions → **creator-demo-seed-staging** → Run workflow (branch with the Creator Hub code), with:

| Input | Value |
|---|---|
| `confirm` | exactly `seed loop-connections-staging` |
| `organization_slug` | the staging organization |
| `owner_email` | an ACTIVE OWNER or ADMIN in that organization (Matt); the seed is recorded as them |
| `creator_email` | the creator's login — must not already be an ACTIVE non-creator member |
| `creator_name` | default `Denise Rivera` |
| `editor_email` | optional: an ACTIVE EMG member (Charlie) who becomes the creator's default editor |
| `app_url` | default `https://staging--emgloop2.netlify.app` |
| `dry_run` | `true` to report what would be created and write nothing |

The `connections-staging` environment's reviewer approves the run. Prerequisites: the Creator Hub
migration is applied to staging (**connections-migrate-staging**) and
`CONNECTIONS_STAGING_MIGRATE_ROLE_ARN` is set on the environment (docs/runbooks/connections-aws-staging.md).
That environment was created with deployment branches limited to `main`, so the seed runs from `main`
once the Creator Hub PR has merged, or after Matt widens the rule to the branch.

## What it creates (once; a rerun creates nothing that already exists)

- A PERSON Party for the creator, established `MANUAL`, and a `TALENT_REPRESENTATION` relationship.
- A `CREATOR` login by invitation, a CreatorProfile bound to it (handle `@denise.rivera`, Instagram
  marked `SEEDED_DEMO`, TikTok and YouTube not connected, payouts not set up, rate card visible).
- CRM: **Kona — product video** (Confirmed, $3,500) with campaign **Kona Product Video** (ACTIVE,
  brief and terms) and deliverables **Reel 1 of 2** (creator + EMG + Kona's approval + published; edited
  only, due in 4 days) and **Reel 2 of 2** (creator + EMG + published; unedited accepted, due in 18
  days); and **Sculpey — holiday series** (Pitching, brand hidden from the creator, no campaign).
- Evidence, all `source = SEEDED_DEMO`: 12 weekly Instagram audience snapshots (91,000 → 103,400
  followers), 12 weekly account-level performance rows, and five compensation entries (two expected
  for Kona, one paid, one available, one received by EMG).
- The **Creator production** work type.

Everything marked `SEEDED_DEMO` is demo evidence: the analytics and earnings pages say so.

## How the creator enters

The run's **job summary** (not the log) holds a one-time accept-invite link, valid 14 days. Anyone who
can read the run can read it — send it to the creator promptly. They open it, set a name and password
on `/crm/accept-invite`, sign in at `/crm/login`, land on Loop Home, and start at
`/app/creator/content`. If the creator login was already ACTIVE, no link is issued and the summary says
to sign in with the existing password. Rerunning while the invitation is still pending replaces it
with a fresh link; a DISABLED or removed member at that email is refused, never resurrected.

## How Matt and Charlie enter

With their existing logins at `/crm/login`. The EMG side is the **Creators** item in the admin
navigation; a production requested by the creator appears as Work OS work assigned to the default
editor. Nothing about their accounts is changed by the seed.
