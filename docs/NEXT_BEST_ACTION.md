# NEXT_BEST_ACTION.md — Recommendations

Next Best Action (NBA) is a first-class platform service. Given an interaction
and the signals known about a subject, the Brain produces an ordered list of
fully-explained recommendations. Sprint 12 defines the platform contract
(`packages/brain/src/recommendation.ts`); Sprint 11 already ships a working
rules-based engine in `packages/database/src/services/next-best-action.service.ts`.

## Every recommendation includes

- **action** — the NBA kind (see catalog below).
- **reason** — human-readable justification.
- **supportingSignals** — signal keys behind the recommendation.
- **confidence** — 0..1.
- **priority** — low | normal | high | critical.
- **recommendedHuman** — suggested human assignee (optional).
- **recommendedAIEmployee** — suggested AI employee (optional).
- **suggestedWorkflow** — workflow to run (optional).
- **suppressions** — actions explicitly suppressed (e.g. suppress marketing).

## Action catalog

Assign Human, Assign AI, Create Follow-up, Recommend Guide, Book Appointment,
Escalate, Notify Dispatcher, Suppress Marketing, Recommend Product, Recommend
Creator, Recommend Workflow, Recommend Channel, Operational Recommendation.

## Determinism

Sprint 12 NBA is **rules-based**. No AI reasoning. Rules map signals + event
context to actions with deterministic confidence and priority. AI ranking can be
introduced later behind the same `RecommendationEngine` interface.
