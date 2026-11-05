# Commission creator brand updates

The original explicit-thread sharing commissioning steps are below. The managed-mailbox pilot is now
commissioned in production through #421; its capacity follow-up is described in the final section.
TikTok One and manual analytics imports are separate. No email is sent by this publication feature.

## Required changes and order

1. Merge #407 to `main` first; verify its content reached `main`. Review this PR against the resulting
   main before merging it. Matt merges; migration deployment stays human-run.
2. Review the new additive migration `20261029190000_creator_brand_mail_updates` and all other pending
   migrations. It adds one sharing/projection table plus composite unique keys used by its scoped
   foreign keys. Deploy with the existing protected staging migration workflow first. No build migrates.
3. On the staging Netlify deployment set `LOOP_CREATOR_MAIL_SHARING_DECISION` to exactly
   `creator-mail-sharing:2026-10-29:v1`. Append `creator.brand.update` to its existing `LOOP_AI_TASKS`;
   preserve all other task, organization, provider and key settings. Redeploy. Both provider data
   policies must already cover COMMUNICATION_CONTENT if both are enabled. No new AI key is needed.
4. Set the GitHub stage variable `CONNECTIONS_STAGING_CREATOR_MAIL_REFRESH_URL` to
   `https://staging--emgloop2.netlify.app/api/internal/creator-brand-updates`. Run
   `connections-infra-deploy`: diff, inspect, then deploy. The existing Fargate worker hosts the queue
   trigger; no new worker, queue service, IAM permission or secret is created. It uses the existing
   signed web↔worker channel. No Google credential is copied to AWS.
5. With a real creator's intended login active and bound, each staff mailbox owner connects/authorizes
   their OWN Gmail through Connections. Open an intended conversation in Mail, choose the creator and
   established brand/agency, read the disclosure and confirm automatic sharing. Archived mail may be
   linked; SPAM/TRASH/DRAFT evidence is refused, including fresh labels read directly from Gmail.
6. Verify Home AND Opportunities as that creator: a summary/stage/next step under the correct brand,
   source/generation/check timestamps, and a new legitimate message reflected on the next due refresh.
   Check CloudWatch `creator_mail_refresh` counts and the Intelligence invocation ledger. A green deploy
   alone is not an accepted model call or confirmation that a creator saw the correct interpretation.
7. Verify another creator cannot read the update, the mailbox owner can withdraw it, late completion
   cannot restore it, revoked consent and profile rebinding suppress it, and no raw subjects/bodies or
   private IDs appear in creator HTML or logs. Inspect a safe test conversation before real sensitive use.
8. Repeat in production only after staging acceptance. Production uses
   `CONNECTIONS_PRODUCTION_CREATOR_MAIL_REFRESH_URL=https://app.emgloop.com/api/internal/creator-brand-updates`
   and production Netlify decision/task settings. Preserve all existing AWS and Netlify configuration.

## Runtime and limits

AWS owns the durable loop, single-flight execution and retry timing. Its fixed-purpose signed trigger
carries no tenant, user, subject or message. Netlify's existing server retains the governed Google
read-through and AI gateway; that gateway executes the model call under the sharing owner's authority.
Neon holds only the publication scope, current minimized output and provenance. Moving Google/model
execution wholly to AWS would require a separately reviewed credential/runtime commissioning change.

Sources are due every five minutes, scanned every minute. A pass is bounded to 100 sequential endpoint
calls or four minutes, whichever comes first; each endpoint claims at most one due scope. Leases prevent
concurrent duplicate processing. Quotas, model latency, connection failures, queue backlog and budget
refusals can delay an update. The employee CallGrid/Telegram/read paths and their cadence are untouched.

`creator.brand.update` uses Anthropic as primary and OpenAI as availability fallback, in BACKGROUND,
with its own `creator-brand-update` class: at most 60 model invocations, 720,000 input tokens and
72,000 output tokens per organization business day, including repairs and availability fallback. Each
call is still bounded to 12,000 input / 1,200 output tokens. Other domain tasks retain their 24-call
ceiling. Recorded operating lane/cost/shared controls still admit every call. An unchanged accepted
or withheld fingerprint skips the model.
No rejected prose is kept; missing/unsafe output is withheld rather than shown as fact.

Only the latest bounded plain-text evidence is read (up to 20 messages upstream, at most 8×1,800
characters passed to the model). Attachment-only newest messages are unavailable, not an unchanged
conversation. This does not parse attachments or backfill months/years of correspondence. Each new
thread needs explicit linking. Grouping by canonical brand does not merge separate conversations into
one model answer, nor establish a representation relationship or an agreement.

## Pause and withdraw

Unset the Netlify decision reference and redeploy to stop publishing/displaying, or clear the stage's
GitHub refresh URL and redeploy the AWS worker to stop the trigger. A mailbox owner can withdraw an
individual share immediately from their Mail conversation without a deployment. The existing MAIL
content-consent revoke removes that owner's shares. Ordinary AI kill/budget controls still apply.

## Creator summary tiles

Brand updates now renders three collapsed summaries: Outreach, Conversations and Active deals.
Each counts canonical brands once, using the newest source activity across its shared threads.
Outreach means no substantive reply; automated messages are not replies. Conversations require
actual two-way evidence. Active deals require specific negotiation (`NEGOTIATING`) or explicit
agreement (`CONFIRMED`); interest alone is insufficient. Template 2 describes these distinctions.
The tile totals are deterministic counts of accepted current summaries, not another AI reading.
Expand a tile to see brands, then a brand to see its existing model summaries and next steps.
Stale, missing, declined and paused readings are separated from current stage totals. This remains
a bounded view of up to 100 explicitly shared threads, not a count of every Gmail pitch ever sent.
No raw messages or mailbox identifiers are added. Existing authorization and withdrawal checks
remain in the repository. A new template does not backfill unchanged historical summaries.

This change does not discover/link creator threads automatically, add independent managed-mailbox
OAuth, or connect an unconnected mailbox. Each mailbox owner still authorizes and links appropriate
threads. Those ingestion requirements must be commissioned before counts represent actual outreach.


## Managed mailbox pilot capacity recovery (November 4, 2026)

Production #421 saved Trevon’s exact staff keywords: `Trevon Hill`, `Trevon`, `trevonbassmaster`.
Selected sources are Matt, Charlie and Trevon’s assigned mailbox; Francesca stays excluded.
The manager preview displayed accepted BRUNT Workwear outreach after the new keyword scan, and
Cashion Rods appeared as a declined earlier discussion before that scan. Creator-login rendering
has not been separately verified. Subsequent refreshes stopped on `BUDGET_TASK_EXHAUSTED`.

The observed ledger had 24 creator model runs (4 answered, 20 output-invalid), BACKGROUND 52/60
calls and $1.50/$2, with 291 total organization calls and $14.54/$25 cost. A class-only increase
would hit the lane or shared invocation cap shortly afterwards. This change gives only creator
summaries their own task class; recorded operating changes still require the existing operations
workflow after the code is deployed. Nothing automatically records a budget on merge or deployment.

1. Matt merges the capacity PR. Verify Netlify production is serving that commit and the route uses
   `creator-brand-update`. No worker redeploy, migration, provider grant or credential change is needed;
   the existing worker invokes Netlify’s gateway rather than running this model task itself.
2. Run the existing **Record AI Budget** workflow in production with preset **custom**. Use the exact
   JSON in `docs/runbooks/creator-mail-pilot-budget.json` (compact it to one line for `settings_json`).
   Reason: Matt requested creator-pilot recovery within the approved $25/day after observed task,
   background and shared call exhaustion. Confirmation remains `record ai-budget production`.
   Review its dry run/current version; a concurrent budget change must be reviewed, never overwritten.
3. The candidate keeps organization and emergency ceilings at $25, live $4, synthesis $10,
   interactive $2.50, live reserve $1.50, defer thresholds and breaker unchanged. It assigns $6.50
   and 120 calls to BACKGROUND using $4.50 of previously unallocated room; lanes plus reserve sum
   to $24.50. Organization/global invocation caps become 400/480. Creator task allowance is 60;
   other explicitly recorded class caps remain unchanged. Shared token ceilings remain enforced.
4. Verify workflow success and the recorded controls in Intelligence status. Do not repeat the earlier
   version-3 $25 commissioning write, restart the pilot, clear existing readings, change the three
   keywords, add Francesca, or force recorded retry deadlines. Advance normally due steps after the
   new controls are recorded, then verify an accepted current summary. Existing source-wide waits
   can persist until their original due time.

Sixty model calls are not sixty published summaries: validation repairs, refusals, withholding and
shared background work affect throughput. This is finite pilot capacity, not evidence of full-roster
or unbounded continuous service. Budget availability never weakens attribution or publication validation.
