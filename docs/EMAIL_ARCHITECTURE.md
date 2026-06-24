# Email Architecture

Email is a first-class channel in The Loop. Email synchronization is
**server-side** and built on **Gmail and Microsoft 365 OAuth**. It must work
identically on desktop and mobile.

## Decision (AD-8)

> **Core email synchronization uses server-side Gmail and Microsoft 365 OAuth.**
> Email capture is **NOT** designed around a Chrome extension.

A Chrome extension may exist **later, only for productivity features** (e.g.
in-Gmail shortcuts). It must never be required for core email sync. The reason is
simple: a browser extension only works in a desktop browser, while businesses
read and send email on phones and tablets too. Server-side sync is the only
approach that supports desktop and mobile **equally**.

## How It Works

\\\`\\\`\\\`
business mailbox (Gmail / Microsoft 365)
   -> OAuth consent (user grants access to their mailbox)
   -> server-side sync service (tokens stored by reference)
   -> normalize messages into the Interaction / Conversation model
   -> emit events (message.received / message.sent)
   -> available everywhere (web + mobile), independent of any browser
\\\`\\\`\\\`

- **Inbound:** the sync service pulls (or receives push notifications for) new
  mail via the provider API and converts each message into the universal
  interaction model.
- **Outbound:** sending goes through the same OAuth-connected mailbox (or a
  transactional email provider for system mail), so replies thread correctly.
- **Threading:** provider message/thread ids map to \`Conversation\` and
  \`Message\` so email threads join the unified timeline.

## OAuth & Security

- OAuth connections are stored as \`ProviderConnection\` rows (category \`email\`),
  with **tokens stored by reference** to a secrets manager, never raw in the DB.
- Scopes are least-privilege and per-organization.
- All access is tenant-isolated on \`organizationId\`.
- Token refresh and revocation are handled server-side.
- Onboarding email connection is a user-initiated OAuth flow (not automated on a
  user's behalf).

## Provider Abstraction

Two distinct concerns, both provider-agnostic:

1. **Mailbox sync** (Gmail API, Microsoft Graph) — for two-way customer email on
   a business's own mailbox.
2. **Transactional sending** (SendGrid, Mailgun, Amazon SES) — for
   system-generated mail (reminders, receipts) via the \`EmailProvider\` interface.

Either side can be swapped without touching modules or AI Employees.

## Relationship to Other Systems

- **Universal Inbox** — synced email appears alongside SMS, calls, and chat.
- **Interaction model** — email is just another interaction kind/channel.
- **Event bus** — every sent/received email emits an event.
- **AI Employees** — an employee with the email channel can read and respond to
  email, grounded in the Knowledge Base.

## Explicitly Out of Scope Now

Authentication and the actual sync implementation are **not** built in this
sprint. This document fixes the architectural direction so later implementation
does not need rework.
