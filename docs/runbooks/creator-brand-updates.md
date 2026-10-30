# Commission creator brand updates

Built on branch `feat/creator-brand-email-updates`, stacked over Creator Hub onboarding #407.
Nothing below has been run in production by this change. TikTok One and manual analytics imports
are separate. No email is sent, and no creator or brand is created by this publication feature.

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
with the existing `domain-reading` class and unchanged organization/global/cost controls. The task's
existing class ceiling is 24 model invocations per day; the operating BACKGROUND lane can be a further
limit. This is a conservative commissioning ceiling, not adequate evidence of roster-wide capacity.
Review measured usage before changing budgets. An unchanged or withheld fingerprint skips the model.
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
