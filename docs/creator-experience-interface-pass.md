# Creator experience interface pass

This branch implements the presentation changes from the November 19 creator audit. It preserves the existing integration and business authorities: no OAuth endpoint, provider client, server action, database schema, data-capture worker, scheduler, permission, or payout calculation is changed.

## Implemented

- Creator-only responsive header: separate compact desktop navigation row, no logo or notification overlap, 44px account target, compact phone branding, and account-menu shortcuts to messages and documents. The shared shell still resolves navigation and permissions.
- Partnership details link directly to a selected detail panel. On phones the selected panel appears before the results, with a back link preserving stage, filter, query, and page. Unselected details do not appear after the entire mobile list.
- Home places real campaign priorities and creator setup before the briefing. Profile fields/handles are read from the existing profile projection. A saved handle is explicitly not a connected account. Setup links do not start authorization or payout actions.
- Plain-language brand activity/check timestamps. Stale summaries remain labeled. The timeline groups repeated readings of the same correspondence date, preserves all distinct saved revisions in Summary history, and never invents emails, signed contracts, or payment events.
- Creator-specific status styling, stronger touch targets, compact headings, consistent primary controls, and reduced-motion handling.
- Content has a primary upload entry point, an open upload panel when requested, a project/deliverable choice before the file, simpler media filters, correct counts for the chosen view, and review-specific empty states. Upload reservation, storage, completion, retry, validation, and payload logic are unchanged.
- Analytics directs disconnected accounts toward Profile instead of offering an unusable refresh. Existing fetch, consent, analysis, budgets, and stored-report behavior remain unchanged. The Facebook empty-report label now names Facebook.
- Profile exposes Meta/YouTube connection details on entry and shows TikTok's actual returned connection state. Existing connection panels, account selection, diagnostic outcomes, scopes, and actions remain in place.
- Task shortcuts distinguish priorities, team messages, and content updates, using existing unread counts. Messaging retains its original server action and brand/submission fields, with shorter privacy guidance and a disclosure for its limits.
- Payment vocabulary is consistent across the overview, state totals, and transaction rows. A payment journey explains the states. Ledger calculations, bank setup, Stripe flows, approval/release/request actions, and transfer behavior are unchanged.
- Agreements/briefs can be reached from setup, the account menu, and partnership details. Documents remain the existing creator-visible projection.

## Deliberately not introduced

These audit suggestions need authoritative data or new backend behavior and should be implemented as a separate reviewed change with Matt:

- Merging Old Town/Old Town Watercraft or other suspected duplicates. Canonical IDs and alias resolution remain unchanged; similar names alone are not enough to merge records.
- New Paid/Affiliate/Product-only opportunity fields, creator-visible contract terms, assigned account-manager deadlines, weekly progress calculations, and deductions/net-pay breakdowns. The interface does not infer these from prose or expose withheld commercial information.
- New email/push reminders, persistent onboarding dismissal, additional notification delivery channels, or new consent scopes.
- A full source-message event timeline. The UI has authorized summary snapshots, not a new permission to expose private source emails. It now distinguishes summary revisions from activity dates rather than fabricating milestones.
- New documents, signatures, analytics trends, or approvals. Existing populated workflows remain available, but no data is seeded into production and no mock action is presented as real.
- New brand-logo fetching, external asset services, MFA, or authentication changes.

## Validation

- Next.js production build completed successfully, including its type validity check and 99 static pages.
- Application/test TypeScript check passed.
- Full web suite: 1,060 passing, 9 failing out of 1,069. The same 9 failures reproduce on unchanged main (`1f20701d432ffbba1d676320b2ee2b2c02d70531`), which has 1,056 passing out of 1,065. No new failing test names.
- All 117 focused provider/domain checks passed for TikTok OAuth, Meta API/security, media storage, creator Stripe payouts, payout rules, and managed creator mail.
- New regression tests cover setup uncertainty/handle-vs-consent, timeline grouping and revision preservation, selected detail URLs/filter context, creator message fields, and empty-filter safety.
- Browser preview used local sample data and the actual header, partnership board, setup component, payment component, and styles. It did not connect to the live backend. Verified Profile navigation at desktop width, no horizontal overflow at 390px and 320px, 44px account target, immediately reachable selected partnership details, and return-to-list behavior.
- Live OAuth, uploads, database-backed authenticated page rendering, signature acceptance, and payments were not performed. Their backend code is unchanged.

## Existing baseline failures

The unchanged main-branch suite fails in: People list identity/filtering, People outreach UX, Relationship linked-opportunity projection, Home presentation constraints, intelligence-on-render constraints, managed mailbox authorization/capture copy, timezone authority constraints, timezone surface constraints, and redesigned CRM person contact labeling. They are outside this creator presentation pass and were not masked or fixed here.

## Release

Review the PR and, where available, the deployment preview before merging. No production configuration, credentials, migration, connection grant, bank authorization, or live deployment was changed during this work.
