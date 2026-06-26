# SIGNAL_REGISTRY.md — First-class Signals

A **Signal** is a structured, evidence-backed assertion about a customer or
organization. Sprint 12 promotes signals to a first-class registry
(`packages/brain/src/signals.ts`) where every definition carries full metadata.

## Signal definition fields

- **key** — stable identifier (e.g. `emergency_intent`).
- **type** — INTENT | SENTIMENT | CHURN_RISK | LIFECYCLE | VALUE | PREFERENCE | CUSTOM.
- **label / description** — human-readable.
- **priority** — low | normal | high | critical.
- **baseConfidence** — deterministic confidence floor (0..1).
- **defaultLifespan** — expiry and/or decay half-life.
- **defaultVisibility** — private | network | platform (Trust-enforced).
- **allowedUses** — routing | recommendation | workflow_trigger | analytics |
  personalization | revenue_attribution.
- **sourceProviders** — providers permitted to source the signal (`*` = any).
- **supportingEvents** — loop event types that can trigger it.

A signal **instance** adds: organization, subject, confidence, priority,
visibility, evidence[], observedAt, lifespan, sourceProvider, and value.

## Production catalog (Sprint 12)

Homeowner, Pet Owner, Emergency Intent, Business Owner, Creator, Caregiver,
Wedding Planning, Insurance Shopper, HVAC Need, High Value Lead, Repeat Customer,
Revenue Opportunity.

All detection is **deterministic** in Sprint 12. No AI scoring.

## Relationship to the Sprint 11 enrichment engine

The deterministic engine that actually derives signals from events lives in
`packages/database/src/services/signal-registry.ts` (Sprint 11) and is unchanged.
The Brain registry is the catalog/contract those detectors and any future
detectors align to, so the platform has one authoritative definition of WHAT
signals exist and HOW they may be used.
