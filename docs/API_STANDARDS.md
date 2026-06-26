# API_STANDARDS.md — Provider Standards

Every provider that feeds the Brain MUST declare a standard contract
(`ProviderStandard` in `packages/brain/src/integration-hub.ts`). No
provider-specific business logic may live outside an adapter's normalization.

## Required declarations

- **Authentication** — mechanism (`hmac`, `oauth2`, `api_key`, `none`).
- **Capabilities** — delivery modes, webhook support, polling support, event
  types produced.
- **Webhook Support / Polling Support** — booleans.
- **Normalization** — adapter MUST map to `NormalizedEvent` (`normalizes: true`).
- **Retry Strategy** — max attempts, backoff (none | fixed | exponential), base
  delay.
- **Health Check** — whether `healthCheck()` is implemented.
- **Rate Limits** — requests per minute, if any.
- **Idempotency** — the idempotency key field (e.g. `externalId`).
- **Permissions** — scopes the provider requires.
- **Audit** — whether provider actions are audited.
- **Documentation** — link/path to provider docs.

## Reference implementation

`@emgloop/providers` CallGridProvider (Sprint 11) satisfies this standard:
HMAC authentication, webhook delivery, normalization to `NormalizedEvent`,
idempotency on `(provider, externalId)`, retryable `IntegrationEvent` status,
and a health check. New providers follow the same shape.

## Deployment / schema standard

Schema changes follow:

```
Migration Created -> Reviewed -> Approved -> Applied -> Deploy
  -> Schema Verification -> Health Check
```

Today the Netlify build runs only `prisma generate` (never `migrate deploy`), so
the Sprint 11 runtime schema-compatibility shim remains in place as a safety net.
Adopting `migrate deploy` in the deploy pipeline (against the production database
URL, with verification + health check) is the documented target state and a
tracked follow-up.
