# Manager-authorized creator mail sources

Matt's November 2 direction distinguishes two connection scopes:

- Connect `matt@elitemediagroup.io`, `charlie@elitemediagroup.io` and
  `francesca@elitemediagroup.io` once each as shared staff sources for the whole creator roster.
- During each creator's onboarding, a manager connects that creator's assigned
  `@emgtalentgroup.com` Gmail account. Creators do not configure these connections in their portal.

The implementation supports these scopes generically per organization. It does not hard-code
EMG addresses or create mailboxes, Google accounts, staff logins, or grants from their names.
The three named addresses must actually be authorized in Google before coverage exists.

## Implemented authorization boundary

`ManagedGoogleMailbox` stores each source separately from the existing private per-person
`GoogleConnection`. A STAFF source is organization-wide and has no creator association; a CREATOR
source has one organization-scoped CreatorProfile association. Uniqueness prevents one email from
being added repeatedly per creator and one creator from holding multiple assigned connections.
Creator invitations/login binding are independent; a manager can prepare a source before invitation.

Only active OWNER, ADMIN and MANAGER memberships can manage or read these sources. Explicit
`googleWorkspace` or `managedMailboxes` denies apply. This is not an administrator bypass over the
employee's private Mail or its digests: a separate shared-purpose Google authorization is required.
Staff grants may be managed by other currently authorized managers in the same organization.

Each connect explicitly confirms its STAFF/CREATOR purpose. Google authorization requests only
identity and `gmail.readonly`, with offline access and without cumulative capability grants. Actual
broader scopes are refused, not retained as read-only by description. The existing signature-first
Google ID-token verifier checks the nonce and verified address; the address must exactly match the
intended mailbox, and creator assignments are rechecked against the manager-maintained profile.

State and nonce are stored only as hashes. State is one-use, ten-minute and bound to organization,
manager, exact browser session, mailbox and assignment generation. State shares the existing callback
URI through a purpose-prefixed dispatch; no new Google redirect URI or login mechanism is added.
An expired/replayed/wrong-session callback, changed assignment, disconnect or offboard cannot attach
a late grant. Scoped foreign keys and generation compare-and-set support those checks.

Refresh tokens use the existing encrypted sealer/key with mailbox-specific associated data, distinct
from a person's private connection. Access tokens and mail bodies remain transient. Inventory and
audit projections contain no credential; audits also omit addresses and source content. A manager-side
read primitive refreshes credentials without another login and rechecks scope after refresh and after
reading. It is not a public API or background capture job.

Disconnect deletes Loop's credential and invalidates pending attempts. It does not revoke the whole
Google app grant, which might also back a private connection. The private disconnect's existing
global yes/no grant guard now also recognizes these managed sources. Managers may additionally
remove the app grant in Google's account controls. IAM disable/remove/demotion clears the author's
managed credentials transactionally. Changing a creator's assigned address does the same; changing
it back does not revive an old token. Creator preference saves preserve the manager's assignment.

## Current limits

This change implements manager-side authorization, inventory, disconnect, lifecycle fencing and
the read primitive. It does not implement scheduled managed-mailbox ingestion, history backfill,
cross-mailbox message deduplication, creator/brand attribution or automatic publication into #411's
tiles. No existing private token is silently copied into the shared store. No Google account has been
authorized, no production migration run and no live email read by this development work.

The intended capture scope includes Inbox, Sent and relevant archived conversation history so
outbound pitches, substantive replies and negotiations can be distinguished. Each creator should
eventually receive only their own minimized summaries, combining shared staff and assigned-mailbox
evidence. Those consumers remain unbuilt here; existing explicitly shared thread summaries continue
to use their existing authorization and worker.

## Commission this authorization change

1. Review the additive `20261102170000_managed_google_mailboxes` migration, including the scoped
   session index, foreign keys, source-kind and credential/read-only checks. Apply it to staging
   using the protected migration workflow. Migrations remain manual, never Netlify build steps.
2. Deploy the web change to staging with the existing Google client and encryption key. No new
   dependency, OAuth client secret, key, callback URI or AWS worker setting is introduced.
3. As a manager, open Creator Hub. Authorize each shared staff address once from the roster panel.
   On a creator's manager record, save their assigned mailbox reference, then authorize that exact
   account in the Assigned creator Gmail panel. Wrong-account responses must be refused.
4. Verify state replay/wrong-session refusal, cross-organization isolation, disconnect, offboarding,
   assignment-change invalidation and unchanged private connections. Inspect actual inventory and
   audit rows without exposing sealed credentials. Then repeat deployment/authorization in production.
5. Capture and publication require the separately unfinished consumer work above. A connected badge
   alone is not evidence of populated tiles, complete coverage or accurate stage classification.

## Validation

The focused connection/creator/provider regressions pass, including the three named staff accounts
coexisting with an assigned creator mailbox, and a credential refreshing without a second OAuth code
exchange. The migration was exercised in disposable embedded PostgreSQL (PGlite) for scoped foreign
keys, unique source scope, normalized addresses, read-only scopes, credential shape and cascades.
This is not a full native Prisma integration or live Google acceptance test.
