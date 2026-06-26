# INTEGRATION_HUB.md — Integration Subsystem

The Integration Hub is the permanent subsystem through which every provider feeds
the Brain. Sprint 11 implemented the first slice (registry, capabilities, webhook
verification, retry, normalization) for CallGrid; Sprint 12 documents the full
hub surface and the per-subsystem roadmap
(`packages/brain/src/integration-hub.ts`).

## Subsystems and status (Sprint 12)

| Subsystem | Status |
| --- | --- |
| Provider Registry | implemented (@emgloop/providers) |
| Provider Capabilities | implemented |
| Webhook Manager | implemented (verify + route) |
| Credential Manager | scaffolded (ProviderContext.credentials) |
| OAuth Manager | planned |
| Vault | planned |
| Health Monitor | scaffolded (healthCheck contract) |
| Retry Queue | implemented (IntegrationEvent status + retry) |
| Rate Limiter | planned |
| Normalization | implemented (NormalizationEngine) |
| Provider Diagnostics | scaffolded |
| Provider Health | scaffolded |

## How providers plug in

Every provider is an adapter that implements the provider interface and registers
into the Provider Registry. The adapter ONLY translates the provider's wire format
into the platform's `NormalizedEvent` (no business logic). From there, every
provider flows through the identical pipeline:

```
Adapter -> Normalization -> Integration Event -> Brain -> ... -> CRM/Analytics/Portals
```

This means adding a provider never touches business code — see `API_STANDARDS.md`
for the contract each adapter must declare.
