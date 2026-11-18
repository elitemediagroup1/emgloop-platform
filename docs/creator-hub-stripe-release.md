# Creator Hub — Stripe Global Payouts release

## Behavior and boundaries

The existing manager Creator Hub records each creator's net earning under a unique invoice or
reference. Recording is not releasing. A manager separately marks an amount available only after
Loop reads sufficient available USD in EMG's configured Stripe storage FinancialAccount, reserving
other released/in-flight amounts plus a conservative $1.50 fee allowance per payment. That allowance
is a safety ceiling, not a quoted fee or a deduction from creator earnings. Higher estimated fees
hold the payout for review. The creator must explicitly request each released amount.

US recipients and USD ACH only in this release. The creator completes legal identity and bank setup
on Stripe's hosted page, without needing a separate Stripe login. Loop stores no bank/routing
numbers. Setup rechecks current signed creator ownership, same organization/profile/user, unexpired
single-use session, current active ACH capability, and exactly one eligible US/USD bank method.
Incomplete/ambiguous setup stays disconnected with a check-again action for asynchronous capability
activation. Expired hosted links rotate an authenticated single-use session and resume the same
recipient. At most five starts/refreshes per creator per hour. Starting
again creates another scoped recipient; unused ones can be reviewed in the Stripe Dashboard.

Funding is a human Stripe Treasury Dashboard action. This version does not initiate bank debits
from Loop, charge brand customers, import QuickBooks balances, or automatically sweep EMG's bank.
An accounting balance is not available cash. Manager release is still a separate explicit action.

Stripe PayoutIntents use manual confirmation, deterministic per-earning idempotency, an immutable
source FinancialAccount and a bound recipient/method/approved amount. Before confirming, the adapter
checks USD estimated credit/debit, fee allowance and ACH-only routing. Unknown outcomes remain under
review with reservations intact; they are not automatically retried. The scheduled ten-minute worker
reads current status and the bound latest outbound attempt. Posted means funds left Stripe, shown as
"Sent to your bank"; it does not establish receipt. Failed, returned and canceled payments need human
review. No automatic reversal, reroute, retry, or refund is implemented. Paid rows are monitored for
90 days after request. Older returns require Stripe Dashboard reconciliation. No webhook setup is
required for polling; do not assume webhook delivery exists.

## 1. Merge and migrate (Matt)

Wait for all required PR checks, including disposable Postgres payout lifecycle tests. Merge the
single Stripe PR. Use the existing manual **Deploy Prisma Migrations** GitHub workflow for production
at the merged commit. Verify `20261118190000_stripe_creator_payouts` applied. Netlify builds do not run
migrations. Redeploy after migration. Before Stripe is configured, managers can still record pending
earnings but bank setup/release/withdrawal are disabled.

New columns: provider on CreatorPayoutBank/CreatorPayoutLink/CreatorPayout, recipientId on links.
The database proof constraint accepts only PLAID/settled or STRIPE/posted for a sent payout.
Defaults retain PLAID ownership for all existing rows. Do not bulk rewrite provider or encrypted bank
fields. An untouched legacy PENDING earning can switch to Stripe only at manager release; any old
funding/authorization/transfer/bank/request/release reference blocks adoption. Existing Plaid banks
or in-flight rows must be reconciled and disconnected through the legacy provider under operator
control before Stripe setup. The active Stripe worker never processes PLAID rows. This deployment
assumes the previously verified pilot has no real Plaid banks or transfers; recheck before rollout.

## 2. Enable EMG's Stripe product (Matt)

Use EMG's business Stripe account. Request/enable **Treasury and Global Payouts**, confirm EMG's talent
agency/vendor-payout use case is approved, and review its actual pricing. Ordinary card payments or
Connect activation alone is insufficient. Business verification and agreements are owner actions.
Find EMG's US **storage** FinancialAccount ID (`fa_…`) through Stripe's Financial Accounts API or
approved account setup; do not substitute a bank account, Connect account, payments balance or another
business's FinancialAccount. No live eligibility or negotiated price is established by this code.

Live mode requires a restricted `rk_live_…` key; full-access `sk_live_…` keys are rejected. Give the
key Stripe's documented permissions: Recipient Configuration Write; Money Management Financial
Accounts Read; Money Management Payout Methods Write; Money Management Outbound Payments Write;
Money Management Payout Intents Write. Store it directly in Netlify secrets, never in chat or git.

## 3. Sandbox first

In Netlify **Deploy Previews** only, add these secret/runtime variables and redeploy the preview:

| Variable | Sandbox value |
| --- | --- |
| LOOP_STRIPE_PAYOUT_ENV | sandbox |
| LOOP_STRIPE_PAYOUT_SECRET_KEY | Stripe sandbox sk_test_… or rk_test_… |
| LOOP_STRIPE_PAYOUT_TOKEN_KEY | Fresh cryptographically random 32-byte base64 encryption key |
| LOOP_STRIPE_PAYOUT_ORGANIZATION_ID | EMG's real Loop organization ID |
| LOOP_STRIPE_FINANCIAL_ACCOUNT_ID | EMG sandbox storage fa_… |
| LOOP_STRIPE_PAYOUT_RETURN_URL | https://deploy-preview-PRNUMBER--emgloop2.netlify.app/app/creator/earnings |

Generate encryption keys locally with `openssl rand -base64 32` and paste directly into Netlify.
Keep the same key for the life of those encrypted records. Never reuse the production key in previews.
Sandbox and production must use distinct credentials, encryption keys and FinancialAccounts.
Functions/Server scopes are required; use All scopes if your existing build setup requires it.
No client-exposed NEXT_PUBLIC variable is used. Netlify's build-stamped deployment-context guard
rejects live keys in previews and sandbox payouts in production. A local UI run cannot enable live
money. Sandbox approvals live in separate environment-scoped payout rows and do not enter real
earnings totals. Sandbox recipients/balances are mock money, not evidence of live bank eligibility.

With authorized creator/manager sessions:

1. Creator: Payments → Set up bank with Stripe; complete Stripe's sandbox identity/bank flow.
2. Return must show the eligible bank's masked ending; cancel/incomplete/expired or another user's
   callback must not connect. Repeat callback must not mutate again. Disconnect is blocked during an
   in-flight/review/returned payout.
3. Manager: record a distinct test earning. Confirm unavailable funds block release. Fund the sandbox
   storage FinancialAccount using Stripe's documented sandbox mechanism; then explicitly mark available.
4. Creator: request only that earning. Repeated requests must not duplicate the payment. Confirm the
   exact amount, source and destination in Stripe and Loop; pending is not sent.
5. Exercise posted, failed/returned, provider outage/unknown result and scheduled reconciliation.
   A return must retain review/reservation and never issue a second payment automatically.
6. Verify another creator and ordinary staff cannot access bank/payment mutations or records.

Tests currently use strict API fixtures and disposable Postgres. Real Stripe sandbox acceptance,
hosted collection availability, fee-response fields and live account approval are separate release
gates; do not describe them as verified until this checklist has been executed against EMG's account.

## 4. Production activation

After sandbox passes and EMG is approved, add the analogous **Production-only** variables:
`LOOP_STRIPE_PAYOUT_ENV=production`, restricted live key, new production encryption key, real EMG
organization ID, live storage FinancialAccount, and
`LOOP_STRIPE_PAYOUT_RETURN_URL=https://app.emgloop.com/app/creator/earnings`.
Only then set `LOOP_STRIPE_PAYOUT_LIVE_APPROVED=true` and redeploy. Do not put live values in Deploy
Previews or branch overrides. Do not rotate/delete old encryption keys while records depend on them.
Existing Plaid variables are ignored by active payout execution; retain old credentials securely
until all legacy obligations are reconciled. This does not cancel any external Plaid subscription.

Matt funds EMG's Stripe account and approves an agreed small pilot earning; the creator connects their
own bank and requests it. Verify exact provider references and bank receipt before broader rollout.
Do not manufacture earnings or submit a test real transfer without explicit payment authorization.

## Recovery

Missing credentials, wrong deployment context, disabled capabilities, insufficient funds, identity
mismatch, changed amount/source/method, high fees, refusal or API outage fail closed. A manager can
record earnings but cannot release without verified funding. For ambiguous/returned transfers,
reconcile the existing PayoutIntent/latest OutboundPayment in Stripe before any manual ledger action.
Do not delete/recreate an earning to retry or manually mark it paid from an email. Removing
`LOOP_STRIPE_PAYOUT_LIVE_APPROVED` and redeploying disables live calls, including automatic status
reconciliation; continue read-only checks in the Stripe Dashboard until restored. Loop disconnect
removes the local authorization/encrypted reference when no transfer is pending; Stripe retains
financial/identity records under its retention obligations.

## Official references

- https://docs.stripe.com/global-payouts/recipient-creation
- https://docs.stripe.com/global-payouts/send-money
- https://docs.stripe.com/global-payouts/manage-payouts
- https://docs.stripe.com/api/v2/money-management/financial-accounts/object
- https://docs.stripe.com/api/v2/money-management/payout-methods/object
- https://docs.stripe.com/treasury/add-funds
- https://stripe.com/pricing

API requests pin `2026-10-28.endive`. Validate the approved account's API responses in sandbox before
live activation; unknown/missing response fields are not treated as permission to send funds.
