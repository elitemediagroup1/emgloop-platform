# EMG Loop — Platform Constitution

This document defines the non-negotiable principles of the EMG Loop platform.
Every architectural decision, schema change, and feature must be consistent with
it. When in doubt, this document wins.

## What EMG Loop Is

EMG Loop is an **AI-first operating system for customer-facing businesses**. It is
the intelligence and orchestration layer that sits on top of any appointment- or
order-based business and runs the customer relationship: capturing leads, booking
appointments, taking orders, answering phones and texts with AI agents,
maintaining a unified customer timeline, automating follow-up, and surfacing
behavioral intelligence.

## What EMG Loop Is Not

- It is **not a CRM**. A CRM is a system of record for contacts. EMG Loop is a
  system of action and intelligence. CRM-style storage is a small subset of it.
- It is **not single-industry**. It is industry-agnostic from day one.
- It is **not coupled to any vendor**. No HubSpot. No direct Twilio. No lock-in.

## The Principles

1. **AI-first, not CRM-first.** Intelligence and autonomous action are the core,
   not an add-on. The data model treats signals, conversations, and agents as
   first-class citizens.

2. **Industry-agnostic from day one.** The core schema is generic. Verticals
   (home services, salons, barbershops, medical, restaurants, pizzerias, law
   firms, ...) are expressed through configuration and JSON \`attributes\` /
   \`metadata\`, never through forked core tables.

3. **Multi-tenant SaaS architecture.** Every tenant-scoped row carries an
   \`organizationId\`. Tenant isolation is enforced at the data-access layer.

4. **Provider-agnostic integrations.** AI, voice, SMS, email, payments, and
   calendars are accessed only through narrow interfaces. Swapping a provider
   must never require changes to business logic.

5. **Own the intelligence, not the infrastructure.** We do not rebuild
   telephony, LLMs, or payment rails. We own the orchestration, the data, the
   workflows, and the behavioral intelligence on top of them.

6. **ServicesInMyCity is the first data source, not the whole product.** It seeds
   real data and validates the model. The architecture must never assume it is
   the only source.

7. **Foundation over polish.** The first goal is a foundation that will not need
   to be rebuilt when we add ServicesInMyCity ingestion, AI phone agents,
   appointment booking, restaurant ordering, salon scheduling, and future EMG
   websites. Pretty UI comes later.

## Capability Surface (target)

Appointment booking, lead management, AI phone agents, AI SMS agents, AI order
taking, customer timelines, workflows, analytics, and future behavioral
intelligence — all multi-tenant and provider-agnostic.

## Amending This Constitution

Changes require an explicit decision recorded in a pull request that updates this
file and \`docs/ARCHITECTURE.md\` together. Principles 1-6 are considered stable
and should change only with strong justification.
