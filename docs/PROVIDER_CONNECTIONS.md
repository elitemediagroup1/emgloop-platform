# Provider Connections

Sprint 2 establishes **provider connection management** — how an organization
connects to external providers — **without any live integration**. It builds on
the provider abstraction (\`PROVIDER_PHILOSOPHY.md\`) and the Sprint 1
\`ProviderConnection\` model.

## What a Provider Connection Is

A \`ProviderConnection\` is a tenant's connection to one external provider in one
category. It records *that* a connection exists and *how to reach it* — never raw
secrets.

| Field | Meaning |
|-------|---------|
| \`organizationId\` | tenant boundary |
| \`category\` | \`AI\` / \`VOICE\` / \`SMS\` / \`EMAIL\` / \`PAYMENT\` / \`CALENDAR\` |
| \`provider\` | vendor id, e.g. \`anthropic\`, \`twilio\`, \`telnyx\`, \`stripe\` |
| \`status\` | \`PENDING\` / \`CONNECTED\` / \`ERROR\` / \`DISCONNECTED\` |
| \`externalAccountId\` | the account id at the provider |
| \`credentialsRef\` | **reference** to secrets in a secrets manager (never raw) |
| \`config\` / \`scopes\` | connection settings and granted scopes |

## Multiple Providers per Organization

The model supports **many connections per organization**, including more than one
provider in the same category. The unique key is
\`(organizationId, category, provider)\`, so an org can connect, for example,
both Twilio and Telnyx under \`SMS\`, choosing one as the default via
\`OrganizationDNA.providerDefaults\`.

This enables:

- **Per-tenant choice** — different organizations use different providers.
- **Failover / multi-provider** — more than one provider per category.
- **Migration** — connect a new provider, switch the default, retire the old.

## Lifecycle (architecture, not implemented)

\\\`\\\`\\\`
PENDING  ->  CONNECTED  ->  (in use)
   |             |--------> ERROR (health check fails) --> reconnect
   +--------------------->  DISCONNECTED (operator removes)
\\\`\\\`\\\`

- **Connect:** operator initiates (OAuth or API-key entry done by the user, not
  auto-filled by the platform); credentials are written to the secrets manager
  and only a \`credentialsRef\` is stored.
- **Health check:** the provider adapter's \`healthCheck\` validates connectivity;
  status is updated. (No live calls in Sprint 2.)
- **Webhooks:** inbound provider events land in \`IntegrationEvent\` as a
  normalized, idempotent envelope (see \`EVENT_BUS.md\`).

## Security

- Secrets are **never** stored raw in the database — only references.
- Connection actions respect roles/permissions (typically \`Admin\`+).
- All connection changes are audited (\`AuditLog\`).
- The platform never enters a user's financial/credential data on their behalf;
  users complete credential entry and OAuth themselves.

## Sprint 2 Scope

Connection *management* architecture only: the model already exists from Sprint
1; Sprint 2 documents lifecycle, multi-provider support, and the
default-selection link to Organization DNA. **No provider is integrated or
called.**

## Candidate Providers (not integrated)

AI: Anthropic, OpenAI, Google. Voice: ElevenLabs. Transcription: Deepgram,
Google. SMS/telephony: Twilio, Telnyx. Payments: Stripe, Square. Calendar:
Google, Microsoft. Email: Gmail/Microsoft 365 (sync), SendGrid/Mailgun/Amazon
SES (transactional). See \`PROVIDER_PHILOSOPHY.md\`.
