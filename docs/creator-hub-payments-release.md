# Creator Hub audit and bank payments release

This release builds on merged #466. It does not replace the Gmail or social intelligence systems.
It adds current creator priorities, private questions/replies in Work OS, explicitly shared EMG
contacts, reviewed brand aliases, clearer coaching status, mobile navigation and approved ACH payouts.

## Operator steps, in order

1. Review the single release PR and its checks. Matt performs the merge and GitHub Actions manually.
2. After merge, run **Deploy Prisma Migrations** against the intended database. The new migration is
   `20261117190000_creator_payouts`. Do not run a seed. Netlify generates Prisma but does not migrate.
3. Deploy the merged commit to Netlify. The build stamps its nonsecret deploy context into both the
   Next server and the payout scheduled function. No `CONTEXT` runtime environment variable is needed.
4. On Admin → Creator Hub → Trevon, share the actual EMG contacts and review any brand aliases.
   Example syntax: `verified alias = canonical company name`, one per line. Verify the companies
   really are the same. Never merge an agency and its advertiser. These settings cannot be edited
   through the creator's profile form. Alias changes invalidate affected relationship evidence.
5. Check **AI review health** on that same admin page. Only closed gateway failure codes appear.
   Correct a missing task activation or provider configuration within the existing controls; do not
   raise budgets. Accepted earlier reviews may remain visible only for the same authorized source
   identity, clearly labeled as earlier, until a new valid review is ready.
6. Validate the seven creator pages using the authorized Trevon login. Compare Home and Tasks
   priorities, ask/reply privately with an authorized test question, verify mobile menu and sign-out,
   historical brand updates, real video thumbnails, recent/history labels and audience populations.
   An old September MyMedic proposal is earlier evidence, not a new November assignment. Confirm
   GOING remains absent unless separately supported Trevon evidence has been accepted.

## Plaid setup

Plaid Link verifies the selected US checking/savings account. Plaid Transfer performs an outbound
ACH credit from EMG's funded Plaid Ledger. QuickBooks can remain the accounting record; it is not
itself the funding bank or payout rail. This implementation does not debit creators, create ads,
post content, automatically approve earnings, or automatically fund the Ledger.

First confirm Plaid approves EMG's exact agency-to-creator payout business model for Transfer.
Do not treat a general Plaid account, sandbox access, Auth access or a submitted application as
production Transfer approval. Register and verify EMG’s business funding account in Plaid. Managers then initiate funding from the creator’s backend record in Loop; the amount is fixed to that recorded earning and the source bank is fixed in server configuration.

Set these server-only Netlify values with **Functions** scope. Leave all production Plaid settings
empty until approved. Do not put keys in `NEXT_PUBLIC_*`, the repository, a screenshot or this chat.
Different deploy contexts use different credentials and encryption keys.

| Key                          | Sandbox preview                           | Production after approval                            |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `LOOP_PLAID_ENV`             | `sandbox`                                 | `production`                                         |
| `PLAID_CLIENT_ID`            | Plaid client ID                           | Plaid client ID                                      |
| `PLAID_SECRET`               | Sandbox secret                            | Production secret                                    |
| `LOOP_PLAID_TOKEN_KEY`       | New random 32-byte key, base64            | Different new random 32-byte key, base64             |
| `LOOP_PLAID_ORGANIZATION_ID` | The authorized test organization          | EMG's organization ID                                |
| `LOOP_PLAID_REDIRECT_URI`    | Exact preview `/app/creator/earnings` URL | `https://app.emgloop.com/app/creator/earnings`       |
| `LOOP_PLAID_LEDGER_ID`       | Sandbox ledger if applicable              | Explicit approved and funded EMG Ledger ID           |
| `LOOP_PLAID_LIVE_APPROVED`   | Empty                                     | `true` only after approval and end-to-end validation |

Register the exact redirect URI in Plaid Dashboard → API/Allowed redirect URIs. Complete required
bank OAuth registration/approval in Plaid. OAuth returns to Payments and resumes the same short-lived
Link session. Configure single-account selection for Transfer; the server also rejects multiple
selections, a foreign account ID, non-US currency and non-checking/savings accounts. The server
verifies the account against `/accounts/get`; it never trusts browser metadata as bank authority.

The encryption key must be retained securely. Do not rotate or delete it while encrypted bank
connections remain; first disconnect/revoke those Items or implement an explicit key migration.
Loop stores only the account mask and encrypted provider credentials, not account/routing numbers.

Production builds reject sandbox configuration. Preview builds reject live configuration even if
live credentials are accidentally supplied. Sandbox approvals use `SEEDED_DEMO` and never contribute
to real earnings. No production bank connection, approval, funding or payment was performed by the agent.

## Sandbox acceptance

Use [Plaid Sandbox Studio](https://dashboard.plaid.com/developers/sandbox), recommended by
[Plaid's sandbox-custom-users README](https://github.com/plaid/sandbox-custom-users). No real personal
or banking data in fixtures. Mocks/disposable Postgres do not substitute for these provider tests.

- Authorized creator connects one synthetic USD checking account, including an OAuth return if supported.
- Wrong creator, expired/reused Link session and forged account IDs fail. Only the mask is displayed.
- Manager records a small pending test earning with its unique invoice/earning reference and net USD amount. It is not withdrawable.
- Manager explicitly requests funding from EMG’s configured business bank. Repeated clicks must create only one deposit sweep.
- Pending, posted or settled funding is not yet available. Advance the sandbox deposit to `funds_available`; then the manager separately marks the creator amount available. Verify the available Ledger balance covers all other reserved creator amounts.
- Test two concurrent releases with enough funding for only one: at most one can become available.
- A creator cannot release an earning, fund the EMG pool or bypass the manager’s pending state.
- Repeating the same reference cannot create a second approval. A creator cannot self-approve.
- Manager can cancel an unrequested approval or one the provider definitively declined/failed. Cancellation cannot race a request into a second payout.
- Creator explicitly requests that approved amount to the displayed mask; double clicks reserve once.
- Advance sandbox events through pending/posted/settled/returned and confirm the stored/visible states.
- Simulate a lost create response. Reconciliation must use the same authorization; no second transfer.
- Disconnect is blocked while requests are pending/reviewing. Provider removal failures can be retried.
- Reassignment/offboarding blocks new processing and withdraws creator access. The bounded sweep
  revokes stale bank Items; existing transfers are reconciled without requiring the old account token.
- No real earnings totals, real bank account or production money are changed by sandbox tests.

## Live use and recovery

The manager’s **Record pending earning** form creates a **new PENDING** compensation entry for the creator’s net USD earning. Recording remains available before Plaid is enabled (after the migration); the payment rail stays disabled.
Use a stable unique earning/invoice reference; do not re-enter an amount already recorded as available
or paid elsewhere. Approval is protected by the dedicated `creatorPayouts:update` permission,
active OWNER/ADMIN/MANAGER membership and organization binding; explicit permission DENY wins.
Recording, funding instructions, manager releases, cancellations and creator requests write audit records. No AI can approve a payout.

Managers use **Move EMG funds** to deposit the recorded amount from the fixed EMG funding account into the fixed Ledger. No browser-supplied amount or bank ID is accepted. Deposits have durable intent, a stable idempotency key, leases, sweep validation and bounded reconciliation. A timeout with no confirmed sweep ID is held for review, not blindly retried.

**Mark available for withdrawal** is a separate manager action. It checks the provider’s current available Ledger balance against all other reserved creator amounts in a Serializable transaction. If this earning has a funding instruction, its sweep must be `funds_available`, not merely submitted or settled. A subsequently failed/returned funding sweep withdraws an unrequested available amount back to pending. Funding never automatically releases a creator balance.

Only the creator can request a released approval bound to their current login. A Serializable transaction
reserves the whole approved entry. Partial withdrawals, FX, PayPal, Venmo, instant rails, automated
QuickBooks posting and unattended bank-to-Ledger funding are not included in this release.

`creator-payout-sync` runs every ten minutes on the published deploy, bounded to ten payouts, ten funding sweeps and ten bank authorization checks per invocation, with a shared time budget. It processes recorded creator requests and explicit manager funding instructions, polling `/transfer/get` and `/transfer/sweep/get`. It never invents a funding instruction or marks an earning available on its own.
It does not create requests. Settled payments are checked for later returns for ninety days.
Pending payments have no promised arrival date. The provider's `settled` credit status is the only
successful-payment proof; `posted` is still processing. A later return removes it from paid totals
and holds it for EMG review.

Unknown payout outcomes, authorization failures and returned payouts remain reserved for review. Unknown funding outcomes never release a balance and are not automatically debited again. The source EMG funding account, Ledger and requesting manager are pinned to the recorded funding instruction; changing environment settings cannot redirect that instruction to another bank.
Never manually mark an ambiguous transfer paid or create a second approval to retry it. Check Plaid
by the stored authorization/transfer ID with an authorized operator. A transfer ID or settled credit
may exist even if the app's first request timed out. Escalate unresolved cases to Plaid support.
Managers may cancel a review only when the persisted provider response proves decline, failure or cancellation. A timeout or return never qualifies. Automatic re-initiation of failed/returned payments is deliberately not enabled. Record an operator
reconciliation decision before any separately authorized corrective payout. A missing response is
not proof that no money moved.

Before creator rollout, verify a deliberately authorized small live payout with EMG and the creator,
then reconcile its settlement against Plaid and the accounting record. This is a human financial
operation, not a deployment or automated test. Do not declare the payout feature production-verified
until that reconciliation and creator-side validation have actually occurred.
