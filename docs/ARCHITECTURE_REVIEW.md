# Architecture Review — Sprint 1.5 (Hardening)

A review of the Sprint 1 foundation against the hardened vision in
\`LOOP_MASTER_BLUEPRINT.md\`. The foundation is sound and aligned. This document
lists recommended **structural refinements** to apply before Sprint 2. These are
documented now and implemented later — no schema or feature code changes were
made in this sprint.

## Verdict

The Sprint 1 architecture holds up. It is AI-first, industry-agnostic,
multi-tenant, provider-agnostic, and already models conversations, signals,
workflows, and provider plumbing. The refinements below make the modular,
event-driven, knowledge-grounded, AI-Employee vision explicit in the data model.

## Recommended Foundational Changes (for Sprint 2)

### R1 — Module registry & per-org enablement
Add \`Module\` (global catalog) and \`OrganizationModule\` (per-tenant enablement
with config/status). Makes modules org-enabled rather than implied. Interim:
\`Organization.settings.modules\`. (See \`MODULE_ARCHITECTURE.md\`.)

### R2 — Interaction \`kind\` + timeline spine
Add a \`kind\` enum to \`Interaction\` and treat \`Interaction\` as the canonical
timeline spine, with \`Conversation\`, \`Booking\`, \`Order\`, \`ServiceRequest\`,
review, and payment records linking back to a parent interaction. Guarantees one
unified timeline/inbox with no industry assumptions. (See \`INTERACTION_MODEL.md\`.)

### R3 — Internal event stream
Introduce a first-class internal \`Event\` (\`DomainEvent\`) table/stream with the
canonical envelope, distinct from \`IntegrationEvent\` (which stays as the
normalized inbound-provider envelope). Wire \`Workflow\` triggers to it. (See
\`EVENT_BUS.md\`.)

### R4 — AI Employee generalization
Evolve \`AIAgent\` into an \`AIEmployee\` concept (role, voice, knowledge scope,
permissions object, channels[], allowed module keys, escalation rules, memory
link). Keep \`VoiceProfile\` linkage. (See \`AI_EMPLOYEE_SYSTEM.md\`.)

### R5 — Knowledge base tables
Add \`KnowledgeSource\`, \`KnowledgeDocument\`, \`KnowledgeChunk\` (per-org,
embedding-backed, provenance-tracked) behind a provider-agnostic embedding +
retrieval interface. (See \`KNOWLEDGE_BASE.md\`.)

### R6 — Email as server-side sync
Model email mailbox connections as \`ProviderConnection\` (category \`email\`,
OAuth, tokens by reference) feeding \`Conversation\`/\`Message\`. No Chrome-extension
dependency for core sync. (See \`EMAIL_ARCHITECTURE.md\`.)

### R7 — Provider category for transcription
Add a distinct \`TRANSCRIPTION\` provider category + \`TranscriptionProvider\`
interface (Deepgram/Google STT), separate from voice synthesis, since AI Phone
Agents need both STT and TTS. (See \`PROVIDER_PHILOSOPHY.md\`.)

### R8 — Customer memory store
Add a lightweight per-customer (and per-employee) memory store, complementing the
append-only \`Signal\` stream, to support AI Employee context. (See
\`AI_EMPLOYEE_SYSTEM.md\`.)

### R9 — Permissions model maturity
Formalize the \`Role\`/permissions array and AI Employee permissions into a shared,
deny-by-default permission vocabulary used by both humans and AI Employees.

## Prioritization

| Priority | Items | Why |
|----------|-------|-----|
| **P0 (before Sprint 2 build)** | R2, R3 | Timeline spine + event stream underpin inbox, workflows, analytics. |
| **P1** | R1, R4, R5 | Modules, AI Employees, and knowledge are the core product surface. |
| **P2** | R6, R7, R8, R9 | Channel, provider, memory, and permission depth. |

## Non-Goals Confirmed

No authentication work, no production features, no provider integrations, and no
merge to \`main\` in this sprint. The foundation remains documentation- and
architecture-complete and ready for Sprint 2 implementation.

## Sign-off Checklist for Sprint 2 Kickoff

- [ ] R2 + R3 schema changes drafted as a migration
- [ ] Module registry (R1) modeled
- [ ] AI Employee model (R4) drafted
- [ ] Knowledge base tables (R5) drafted
- [ ] Provider category for transcription (R7) added to \`packages/providers\`
