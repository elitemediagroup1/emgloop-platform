# Universal Inbox

The Universal Inbox is a single, unified view of every conversation a business
has with its customers, across every channel. It is made possible by the
universal interaction model: because all channels normalize into one shape, they
can all render in one feed.

## Channels (current and future)

- **Email** (server-side Gmail / Microsoft 365 sync — see \`EMAIL_ARCHITECTURE.md\`)
- **SMS**
- **Calls** (with transcript / summary)
- **Website Chat**
- **Facebook** (Messenger)
- **Instagram** (DMs)
- **WhatsApp**
- **Future channels** (e.g. Google Business Messages, Apple Messages for Business)

New channels plug in without changing the inbox: each channel adapter normalizes
into \`Interaction\` / \`Conversation\` / \`Message\`, and the inbox simply renders the
unified stream.

## Architecture

\\\`\\\`\\\`
channel adapters (email, sms, voice, chat, social)
   -> normalize -> Interaction / Conversation / Message
   -> events (message.received / call.completed / ...)
   -> Universal Inbox feed (one thread per customer/conversation)
   -> AI Employees + humans act from the same surface
\\\`\\\`\\\`

## Key Properties

- **One thread per conversation**, regardless of channel mix; a customer who
  calls then texts then emails is one continuous timeline.
- **Channel-agnostic actions** — reply, assign, snooze, escalate work the same
  everywhere.
- **AI + human collaboration** — AI Employees handle threads and hand off to
  humans (and back) within the same inbox.
- **Tenant-isolated** — an organization only sees its own conversations.
- **Searchable & filterable** by channel, status, assignee, customer, and module.

## Relationship to Other Systems

- **Interaction model** — the inbox is a view over normalized interactions.
- **AI Employees** — operate threads in the inbox per their channel permissions.
- **Event bus** — inbox updates are driven by message/call events.
- **Modules** — Messaging powers SMS/chat; Email architecture powers mail;
  social adapters add social channels.

## Status

Future capability. Documented now so the interaction model, channel adapters, and
event design stay aligned with a single-inbox end state. Not implemented in this
sprint.
