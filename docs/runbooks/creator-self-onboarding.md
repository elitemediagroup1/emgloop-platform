# Creator self-onboarding and Trevon pilot

Matt's launch decision: manually prepare only Trevon Hill, prove the full journey with him, fix
failures, then allow the other creators to onboard themselves. Do not send the roster invitations
or manually fill their profiles before that acceptance.

## Implemented flow (requires this branch to merge and deploy)

1. From Creator Hub, choose **Invite creator**. The existing Team form opens with Creator selected.
2. Enter their name and intended email. Choose automatic Person identity creation, or select their
   already-established Person. This is the inviter's explicit identity decision, not an inferred
   match. Automatic creation requires identity create/approve in addition to user-invite authority.
3. The existing invitation service sends the recipient a single-use expiring account link. This
   runbook does not authorize sending any particular invitation. Email delivery uses the existing
   sender and configuration. No additional mailbox/platform API is needed for account onboarding.
4. The creator sets their own password and name. The token, not submitted identifiers, controls the
   organization, email, role and Person. Acceptance creates/binds their Hub profile automatically.
5. They land on their own Profile and enter their bio/categories/social handles. At least one handle
   is required by the existing save action. A handle is a declaration, not verified platform access.
   Google employee onboarding remains unchanged for non-Creator invitations.
6. The creator sees only their own Hub. EMG configures and explicitly links relevant brand mail
   behind the scenes; onboarding never exposes Matt's or Charlie's mailbox to the creator.

There is no public registration, automatic email-to-identity merge, representation agreement,
platform-login bypass or automatic platform analytics import. Existing active users are not silently
converted by an invitation. If a Person or profile already exists, explicitly choose it to avoid a
second Person. Inactive/removed users and resends keep the existing IAM lifecycle rules. An existing
manually bound test profile can also be accepted without a new scope in a legacy invitation;
unbound legacy Creator invitations must be reissued with an intended Person.

## Trevon-only acceptance

Trevon's Person and unbound Hub profile were manually created in production on October 30, 2026.
No other creator profile or invitation was created by this work. Do not use production demo seeds.

- Confirm the intended controlled test-login email with Matt. No invitation has been sent by this
  work. Choose Trevon's existing Person on his invitation, not automatic new Person creation.
- Verify the creator login reaches the correct profile and cannot open organization Mail, employee
  sources, other creators or administration. Never bind Matt's administrative login as the Creator.
- Complete handles/profile, sign out and back in, and verify those fields persist.
- Link one appropriate brand conversation from its actual mailbox owner's Loop Mail. Verify a
  successful `creator.brand.update` invocation, correct brand/stage/paraphrase and evidence times,
  then a legitimate source update on the next due refresh. Confirm withdrawal removes it.
- Verify upload → edit request → return → creator approval with real configured private media.
- Mark absent platform analytics and payouts as unavailable; do not fill fabricated metrics.
- Record failures and fix them before inviting the rest of the roster.

The existing production AWS refresh deployment and budget limits still govern summaries. A green
migration or website deploy does not prove the worker ran, email delivery succeeded, or a creator
received the correct AI update. No migration or new environment variable is added by self-onboarding.
