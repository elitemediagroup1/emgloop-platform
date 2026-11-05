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
| Notifications | Existing Work OS in-app records; creator feed/read marker and preference wired in the current follow-through | Validate real-Postgres privacy/lifecycle checks and creator Tasks after deployment |

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


## November 5 verification and reliability follow-through

- Main `2932a74ead3b62a3b0058fd7d475d3d6540b3e7f` deployed successfully on
  Netlify deploy `6aecbb36403e232ca423d81a`.
- PR #441 passed 107 creator/shell contracts and 11 actual Postgres lifecycle,
  isolation and constraint tests (none skipped).
- The live manager board renders and expands relationship summaries and history.
  Expanded stages need the full board width to remain readable in manager layouts.
- Capture observed 553 source-thread checks, 57 queued, and 76 outreach / 6 conversation /
  4 negotiation brands, plus 5 earlier/paused brands. These are an incomplete historical
  snapshot from a manager preview, not reconciled creator acceptance.
- Budget version 6 (`operating.creator-pilot.25.4`) was recorded at 12:04 p.m. Eastern.
  At 12:48 p.m. Eastern the status page reported $2.02 organization spend today and
  271 creator task runs (240 answered, 31 output-invalid). The $25 ceiling remains.
  Capture reported TASK_CIRCUIT_OPEN. Do not bypass validation or raise this safeguard
  to force a backfill through rejected model output.
- Upload reliability changes renew the existing pending reservation after expiry,
  recheck creator ownership/current editor assignment, preserve the reservation during
  retries, retry confirmation without resending confirmed bytes, refuse invalid stored
  files and prevent sequential resurrection of failed uploads. Failed URL signing no
  longer attaches the deliverable. Matching pending deliverable reservations can be
  recovered after a lost response. Concurrent reservations and browser reload recovery
  for independent content remain separate verification concerns.
- Creator login, mobile rendering, real configured storage, notifications, platform
  integrations and payment setup still require the acceptance work listed above.


## Creator login and classification correction

Trevon's real CREATOR session was verified on November 5. Home shows 93 outreach,
7 conversations, 4 negotiating labels and 5 earlier/paused brands. The manual refresh
request succeeds; fresh AI completion is not thereby established. History expands,
GOING is absent, staff capture controls are hidden, and manager access redirects to Home.
The uploader is available, but no artificial production media was created.

Matt identified the active-deal labels as incorrect. The follow-through gates active
publication on an explicit accepted paid partnership qualification. Legacy
unqualified labels fall back to Conversations; original evidence/history is retained.
Active Deals requires an accepted brief or contract, or an approved payable tied to the agreed partnership. Negotiations remain in Conversations. Introductory calls, requests for scope/budget, unsolicited offers and affiliate-only
arrangements do not establish an active deal. Later cancellations/deferments supersede
old offers. Existing unchanged outreach skips reanalysis; only old active labels need
the classifier upgrade. Synthesized relationships cannot invent qualification absent
from their accepted source basis. No AI budget or retry safeguard changes.

TikTok is waiting for developer approval, as confirmed by Matt. The UI explains approval
and setup requirements without claiming account access or approval. The in-app notification
feed reuses Work OS and sends no external messages. Payout rail selection remains open.
