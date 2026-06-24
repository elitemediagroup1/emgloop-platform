# AI Employee System

The **AI Employee** is The Loop's defining abstraction: a configured, role-bound
agent that does real work for an organization across one or more channels. The
same system, configured differently, becomes an HVAC Dispatcher, a Pizza Order
Taker, a Salon Receptionist, a Medical Scheduler, or a Real Estate Assistant.

This generalizes the Sprint 1 \`AIAgent\` + \`VoiceProfile\` models into a complete
employee concept. Implementation is scheduled for later sprints; this document is
the architectural specification.

## An AI Employee Has

| Facet | Description |
|-------|-------------|
| **Role** | Job definition + persona + objectives (e.g. "Dispatcher: triage, qualify, schedule"). Drives the system prompt and allowed actions. |
| **Voice** | The voice identity for phone/voice channels (maps to \`VoiceProfile\`: provider, voice id, language, tuning). |
| **Knowledge** | The slice of the organization Knowledge Base the employee may use to answer (see \`KNOWLEDGE_BASE.md\`). |
| **Permissions** | What the employee may do: which modules, which actions (book, refund, quote), spend/limit caps, data it may read or write. |
| **Channels** | Which channels it works: phone, SMS, email, chat, social. One employee can span several. |
| **Workflows** | The automations it can trigger or participate in (see \`EVENT_BUS.md\`). |
| **Memory** | Per-customer and per-employee memory: prior interactions, preferences, open threads, learned facts. |
| **Escalation Rules** | When and how to hand off to a human (or another employee): conditions, targets, and fallback. |

## Reference Configurations

| AI Employee | Channels | Modules | Notable knowledge | Typical escalation |
|-------------|----------|---------|-------------------|--------------------|
| **HVAC Dispatcher** | phone, SMS | Scheduling, CRM, Estimates | service areas, SOPs, pricing | emergency / out-of-area -> on-call human |
| **Pizza Order Taker** | phone, chat | AI Ordering, Payments | menu, hours, delivery zones | payment failure / complaint -> manager |
| **Salon Receptionist** | phone, SMS | Scheduling, CRM | services, stylists, policies | double-booking / refund -> front desk |
| **Medical Scheduler** | phone, SMS | Scheduling | providers, insurance policy, intake | clinical questions -> staff (never advise) |
| **Real Estate Assistant** | SMS, email, chat | CRM, Scheduling | listings, areas, financing FAQ | offer / legal -> agent |

## Lifecycle of a Handled Interaction

\\\`\\\`\\\`
inbound interaction
   -> employee selected (by channel + routing rules)
   -> understand intent (AI + scoped knowledge + memory)
   -> check permissions
   -> act via allowed modules (book / order / quote / answer)
   -> emit events (every action)
   -> update memory
   -> escalate if a rule fires
\\\`\\\`\\\`

## Permissions & Safety

- Permissions are **deny-by-default**; an employee can only use explicitly
  granted modules and actions.
- Spend, refund, and data-write actions carry caps and may require confirmation
  or human approval.
- Every employee has a **defined human escalation path**. There is no "no
  fallback" state.
- All employee actions are auditable (\`AuditLog\`) and emit events.
- Medical, legal, and financial verticals get guardrails that forbid regulated
  advice and force escalation.

## Memory Model

Two scopes, both append-friendly and privacy-aware:

- **Customer memory** — facts and preferences about a specific customer, built
  from interactions and signals; shared across employees of the organization.
- **Employee memory** — operating context for the employee (recent threads,
  learned patterns) within tenant boundaries.

Memory is grounded by, and never overrides, the Knowledge Base and permissions.

## Data Model Direction

Generalize \`AIAgent\` toward an \`AIEmployee\` concept (or extend \`AIAgent\`) with:
role, linked \`VoiceProfile\`, knowledge scope, a permissions object, an array of
channels, allowed module keys, escalation rules, and a link to a memory store.
See \`ARCHITECTURE_REVIEW.md\` for the recommended foundational change.

## Relationship to Other Systems

- **Interaction model** — employees handle any interaction kind via one interface.
- **Knowledge base** — employees ground answers in org knowledge before responding.
- **Event bus** — employee actions emit events that drive workflows and analytics.
- **Modules** — an employee's reach is the set of modules + actions it is permitted.
- **Providers** — voice/AI/telephony are resolved through provider adapters.
