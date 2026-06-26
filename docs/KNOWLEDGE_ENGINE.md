# KNOWLEDGE_ENGINE.md — Governed Knowledge

The Knowledge Engine (`packages/brain/src/knowledge.ts`) defines how the platform
stores and governs reusable knowledge — guides, policies, answers, and playbooks
the Brain and AI Employees can draw on. Sprint 12 is **architecture only**; there
is no AI generation.

## Knowledge object lifecycle

`draft -> approved -> deprecated`. Transitions are explicit and audited.

## Every knowledge object declares

- **title / body** — the content.
- **status** — draft | approved | deprecated.
- **version** — bumped on each edit.
- **owner** — user id or `system`.
- **confidence** — 0..1.
- **visibility** — private | network | platform.
- **lifespan** — optional expiry.
- **allowedOrganizations** — orgs permitted to use it (`*` = platform-wide).
- **allowedAIEmployees** — AI employees permitted to use it.
- **relatedWorkflows** — workflow ids this knowledge supports.
- **topics** — tags for retrieval.
- **audit** — append-only trail.

## Access

`KnowledgeEngine` exposes `get`, `search`, and `transition`. Implementations
enforce allowed organizations / AI employees and never return cross-tenant
private knowledge (governed by the Trust layer).
