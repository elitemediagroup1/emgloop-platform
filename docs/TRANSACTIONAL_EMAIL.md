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
