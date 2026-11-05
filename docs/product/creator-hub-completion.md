# Creator Hub completion — coordinated work

Baseline: main `9066b2b2fdc1a66cd441e01a90185d9d85fdb9d8`, reviewed November 5, 2026.

## Product direction

One premium creator experience on Loop's existing design foundation: navy navigation,
light canvas, existing semantic tokens, spacious typography, distinct KPI cards and a
three-stage partnership board. The creator keeps one manual refresh control.
This is the existing authorized Hub, not a parallel demonstration site.

## Completion scope

| Area | Existing foundation | Remaining acceptance |
|---|---|---|
| Home and navigation | Role-bound home, KPI read models, tasks, opportunities | Render and inspect desktop/mobile; prioritize real actions and brand activity |
| Brand intelligence | Three authorized sources, durable evidence, governed OpenAI analysis and relationship synthesis | Finish historical backfill, reconcile the Gmail inventory, validate multi-thread synthesis and Trevon login |
| Content library | Private media, originals, versioned content, image/video cards | Prove upload, retry, download/preview and isolation with configured storage |
| Production | Work OS edit/review rounds, return, change requests, approvals, publication | Exercise creator-to-editor-to-creator lifecycle, concurrent requests and deliverable reconciliation |
| Opportunities | Explicit visibility and creator-safe commercial projections | Prove staff designation, deliverables, due dates, and creator access |
| Analytics | Source-labelled observations, TikTok connection/read path, charts | Verify connections and freshness; preserve unavailable versus zero |
| Earnings | Scoped compensation entries and state totals | Define and implement the payout-request/settlement experience; do not pretend an inert transfer button moves money |
| Profile and onboarding | Invitation binding, declared handles, documents, preferences | Prove profile persistence, invitation lifecycle, document access and revocation |
| Notifications | Preference is saved; profile explicitly says it has no effect yet | Connect real delivery/notifications and verify creator-specific visibility |

## Source-confirmed gaps

- `creator/profile/page.tsx`: payouts setup and non-TikTok connection controls are
  intentionally inert; saved return-notification preference is not connected to delivery.
- `creator/_parts/earnings-body.tsx`: there is no payout rail; Transfer funds is inert.
- `creator-hub-staging.md`: private media/signing configuration requires deployment
  and live acceptance; a checked-in uploader alone is not proof of production storage.
- `creator-self-onboarding.md` includes stale implementation/deployment statements
  about managed Gmail. Reconcile operational documentation after verification.
- The Gmail allowance is a separate governed operating control. The last verified
  production state was 419 source-thread checks and 62 queued, with 24 outreach,
  4 conversation and 3 earlier/paused brands in the manager preview. This is a
  historical snapshot, not a current or complete inventory.

## Verification rules

Use the three authorized Trevon pilot sources only; Francesca stays excluded.
No email sends, production demo seeds, invented metrics, banking credentials in
free-text fields, creator-permission bypass, or automatic increase of dollar caps.
Run unit/contracts and build validation, then inspect real creator and staff flows.
Do not mark complete from CI, a preview, a merge or a green deployment alone.

The local execution environment and live browser were unavailable when this
design work started. GitHub CI and Netlify previews can validate committed code;
rendered visual acceptance and live workflow checks still require restored access.
