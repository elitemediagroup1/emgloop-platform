# Transactional Email Runbook (Resend)

EMG Loop sends two transactional emails: **user invitations** and **password
reset** links. Delivery uses [Resend](https://resend.com) through the shared
`@emgloop/providers` email abstraction.

> This runbook covers **outbound transactional email** only. Inbound mailbox
> sync (Gmail / Microsoft 365 OAuth) is a separate future integration described
> in `docs/EMAIL_ARCHITECTURE.md` and is unrelated to this flow.

## Architecture

```
auth / CRM server action
  -> apps/web/src/lib/email/email-service.ts   (thin, server-only)
       -> @emgloop/providers ResendEmailProvider (implements EmailProvider)
            -> Resend Node SDK -> Resend API
```

- `ResendEmailProvider` lives in `packages/providers/src/adapters/resend-email.provider.ts`
  and implements the existing `EmailProvider` interface. Provider-specific code
  stays inside the providers package.
- `apps/web/src/lib/email/email-service.ts` is the only module auth/CRM import.
  It exposes exactly two functions and never lets Resend leak into other code.
- `apps/web/src/lib/email/templates.ts` holds the HTML + plain-text templates
  (no template framework).

## Public API

```ts
sendInviteEmail({ to, name?, inviteUrl })
sendPasswordResetEmail({ to, name?, resetUrl })
```

## Required environment variables

These are configured in Netlify and read server-side via `process.env`. Never
hardcode them and never expose them to the browser.

| Variable | Required | Example |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | `re_xxx` (secret) |
| `LOOP_EMAIL_FROM` | yes | `Loop <loop@emgloop.com>` |
| `LOOP_EMAIL_REPLY_TO` | optional | `matt@elitemediagroup.io` |
| `NEXT_PUBLIC_APP_URL` | yes | `https://app.emgloop.com` |

### Reply-To behavior

`LOOP_EMAIL_REPLY_TO` is optional. When set, it is attached as the message
Reply-To. When missing, Reply-To is simply omitted; the service does not crash.

## Flows wired

- **Invite** — `apps/web/src/crm/admin-actions.ts` (`inviteUserAction`). After the
  existing `createInvitation` call, the service sends the invite email using the
  **plaintext** token (only the token hash is stored). Invite link:
  `${NEXT_PUBLIC_APP_URL}/crm/accept-invite?token=...`.
- **Password reset request** — `apps/web/src/auth/actions.ts`
  (`requestResetAction`). The email is sent **only inside the user-found branch**,
  so anti-enumeration is preserved: when the account does not exist, nothing is
  sent and nothing is revealed. Reset link:
  `${NEXT_PUBLIC_APP_URL}/crm/reset-password?token=...`.

Existing token generation, hashing, storage, expiry, duplicate-invite handling,
and the generic response are all unchanged.

> **Follow-up (out of scope for this PR):** there is currently no
> `/crm/accept-invite` page consuming `findInvitationByToken` /
> `acceptInvitation`. The invite link points at that conventional path; the
> acceptance page must be built in a subsequent PR for end-to-end onboarding.

## Missing-configuration behavior

- **Production** (`NODE_ENV=production`): if `RESEND_API_KEY` or
  `LOOP_EMAIL_FROM` is missing, the service **throws** a clear configuration
  error. It never pretends an email was sent.
- **Non-production**: it logs a safe warning and **skips** sending so unrelated
  pages keep working. No secrets, tokens, or URLs are logged.

If Resend returns an error, the service throws a server error without exposing
provider internals or token-bearing content, and does not mark the email sent.

## Logging policy

Only operational messages are logged. The service never logs API keys,
invite/reset tokens, or complete token-bearing URLs.

## Safe testing

1. Set the four env vars (use a Resend test/sandbox key).
2. Trigger an invite from the CRM users screen, or request a reset from
   `/crm/forgot-password`.
3. Confirm the email arrives; verify the CTA link uses `NEXT_PUBLIC_APP_URL`.
4. To test missing-config safely, unset `RESEND_API_KEY` in a **non-production**
   environment and confirm the flow logs a warning and continues without error.

Do not commit real keys. Do not paste tokens or full reset/invite URLs into
logs, tickets, or chat.

## Invitation URL format

Invitation emails link to the invitation acceptance route:

```
${NEXT_PUBLIC_APP_URL}/crm/accept-invite?token=<plaintext invitation token>
```

The plaintext token appears **only** in the URL query string and in the server-side
form submission that accepts the invitation. It is never logged. Only the hashed
token (`hashToken(token)`) is stored, matching the existing invitation storage.

The password reset email links to the existing reset route:

```
${NEXT_PUBLIC_APP_URL}/crm/reset-password?token=<plaintext reset token>
```

Both routes and their `token` query parameter were confirmed against the actual
Next.js app router source (Next 14, synchronous `searchParams`).

## Invitation acceptance route

Route: `/crm/accept-invite` (server component, `apps/web/src/app/crm/accept-invite/page.tsx`).
Server action: `acceptInviteAction` in `apps/web/src/auth/actions.ts`.

The page derives all invitation details (email, organization, role) from the token
server-side via `iam.findInvitationByToken(hashToken(token))`. Client form fields
cannot influence which invitation is accepted; only the full name and password are
taken from the form.

### States handled

- **Valid** — shows the invited email, organization name (if available) and role,
  plus a form (full name, password, confirm password) and the primary button
  "Create account and join EMG Loop".
- **Missing token** — treated as an invalid link.
- **Invalid / revoked / already accepted** — `findInvitationByToken` only returns
  `PENDING` invitations, so revoked and already-accepted links resolve to a generic
  "invalid or no longer active" message with no internal details. The user is
  directed to sign in or to request a new invitation.
- **Expired** — when `expiresAt` is in the past, an "expired" message is shown and
  the user is directed to ask an administrator for a new invitation.
- **Submission failure** — validation errors (missing name, password too short,
  passwords do not match) redirect back to the form with a safe `error` message on
  the query string; the token is preserved so the form still works. Provider and
  database internals are never shown.

### Acceptance behavior

On a valid submission the action:

1. Re-validates the token server-side and checks expiry.
2. Reuses the existing user record created at invite time (looked up by
   organization + email) so a single invitation can never create more than one
   account. If no record exists it creates one from the stored invitation's
   organization and role.
3. Hashes the password with the existing `hashPassword` (scrypt) and stores it via
   the existing auth repository, then activates the user.
4. Marks the invitation `ACCEPTED` via `acceptInvitation`. Because the status leaves
   `PENDING`, reopening the same link cannot create a second account.
5. Establishes a normal session using the existing `login()` helper (no second
   session system) and redirects to `/crm`. If session creation cannot complete,
   the user is redirected to `/crm/login` with a success message.

Password policy: minimum 8 characters, matching the existing password reset flow.

## Delivery-failure behavior

Invitation creation and email delivery are intentionally **not** wrapped in a
distributed rollback (the repository does not provide one). For this integration:

- `createInvitation` (and the invite-time user record) may remain valid even if the
  Resend send fails.
- A delivery failure surfaces as a clear server-side error to the admin action; the
  invitation is not silently reported as delivered.
- The admin can revoke and reissue, or resend, using the existing invitation
  management. Error handling never creates a duplicate invitation automatically.

Missing configuration follows the existing rule: in production a missing
`RESEND_API_KEY` throws a clear server error (never a false "sent"); in
non-production it logs a safe warning and skips sending without exposing secrets or
tokens.

## Manual end-to-end test (must be executed by a human; not yet run)

1. As an admin, invite an alternate email address from the CRM users screen.
2. Confirm the email arrives from `Loop <loop@emgloop.com>`.
3. Confirm replies target `matt@elitemediagroup.io`.
4. Click the invite CTA and confirm it opens `/crm/accept-invite`.
5. Enter a full name and a password (>= 8 chars, matching confirmation).
6. Submit and confirm the account is created under the correct organization and
   role.
7. Confirm the invitation now shows as accepted.
8. Confirm you are signed in (or can sign in) as the new user.
9. Reopen the same invite link and confirm it can no longer create another account
   (shows invalid / no longer active).
10. Trigger a password reset for the same user, confirm the reset email arrives, and
    confirm its link completes a successful reset at `/crm/reset-password`.

## Public access-request intake (Request Access)

The public login page (`/crm/login`) shows a **Request Access** button instead
of linking unknown visitors to `/crm/accept-invite`. It opens a modal that
collects an access request and sends it to EMG operations for manual review.

Submitting the public form does **not** create a user, session, or invitation,
does not assign a role, does not grant access, does not reveal whether an email
already exists, and does not redirect to `/crm/accept-invite`. It is an intake
notification only. After a human approves, an admin issues an invitation through
the **existing** invite flow, which is unchanged.

### Flow

```
Public request (modal)
-> apps/web/src/app/crm/login/access-request-action.ts  (server action; validates + rate-limits)
-> apps/web/src/lib/email/email-service.ts  sendAccessRequestEmail(...)
-> @emgloop/providers ResendEmailProvider
-> Resend
-> notification delivered to LOOP_ACCESS_REQUEST_TO
```

### New public API

```ts
sendAccessRequestEmail({ fullName, email, company, accessType, submittedAt })
```

- **To:** `process.env.LOOP_ACCESS_REQUEST_TO` (never hardcoded in the provider adapter).
- **From:** `process.env.LOOP_EMAIL_FROM` (reused).
- **Reply-To:** the requester's submitted email, so the EMG team can reply directly.
- **Subject:** `Loop access request — {Access Type} — {Full Name}` (built from validated/normalized values to prevent header injection).

### New required environment variable

| Variable | Required | Example |
| --- | --- | --- |
| `LOOP_ACCESS_REQUEST_TO` | yes (production) | `hello@elitemediagroup.io` |

The existing variables remain required: `RESEND_API_KEY`, `LOOP_EMAIL_FROM`,
`LOOP_EMAIL_REPLY_TO` (optional), `NEXT_PUBLIC_APP_URL`. Do not commit real keys.

### Missing configuration

Same policy as the rest of the service: in **production** a missing
`LOOP_ACCESS_REQUEST_TO` throws a clear server error (never a false "sent"); in
**non-production** it logs a safe warning and skips sending. The modal only shows
success when the email was actually delivered; otherwise it shows
"We couldn't submit your request right now. Please try again." and preserves the
entered values.

### Spam / abuse protection

- **Honeypot** hidden field: if populated, the server returns a generic success without sending.
- **Timing check:** a form-render timestamp is included; submissions completed unrealistically fast are silently no-op'd.
- **Rate limit:** best-effort in-memory per-IP throttle in the server action. The
  repository has no shared rate-limit utility, and serverless instances do not
  share memory, so this is a smallest-safe deterrent rather than a durable limit.
  A future sprint can move this to a shared store if needed.
- **Generic responses:** the form never reveals whether an email/organization
  already exists, and never surfaces provider/database internals.

### Logging policy

Only sanitized operational logs (request received, access type, success/failure
category). The access-request email body, secrets, and tokens are never logged.

### Data storage

v1 does not persist access requests to a database (no suitable auditable intake
model exists yet). The request is validated, emailed to `LOOP_ACCESS_REQUEST_TO`,
and confirmed on-screen. It never touches the Invitation table and never creates a
user. A future sprint may add an in-app Access Requests queue.

### Manual live test (must be executed by a human; not yet run)

1. Set `LOOP_ACCESS_REQUEST_TO`, `RESEND_API_KEY`, `LOOP_EMAIL_FROM` (and optionally `LOOP_EMAIL_REPLY_TO`) in the preview environment.
2. Open `/crm/login`, click **Request Access**, complete and submit the form.
3. Confirm a notification arrives at `hello@elitemediagroup.io`.
4. Confirm **From** is `Loop <loop@emgloop.com>` and **Reply** targets the requester's email.
5. Confirm no user, session, or invitation was created.
