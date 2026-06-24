# Organization DNA

**Organization DNA** is the inheritable identity of a tenant — the single source
of truth for who the business is and how it communicates. AI Employees **inherit
Organization DNA** and may override specific facets, so the whole platform speaks
and behaves consistently with the business.

DNA is industry-agnostic: an HVAC company, a pizzeria, a salon, and a law firm
all have DNA; only the *values* differ.

## Facets

| Facet | What it holds |
|-------|---------------|
| **Brand** | Name variants, colors, logo references, taglines, positioning. |
| **Voice** | Voice/tone identity for written and spoken channels. |
| **Business hours** | Weekly hours + exceptions (also surfaced per \`Location\`). |
| **Locations** | The org's \`Location\` records (branches, geo, per-site hours). |
| **Industry** | The \`IndustryType\`, used to select vertical defaults. |
| **Knowledge sources** | Default KB sources the org's AI grounds on. |
| **Communication style** | Formality, greeting style, do/don't phrasing. |
| **Compliance rules** | Regulated-vertical guardrails, disclaimers, do-not-say. |
| **Escalation rules** | Default human-handoff conditions and targets. |
| **AI defaults** | Default model, temperature, persona scaffolding. |
| **Provider defaults** | Preferred provider id per category (AI/voice/SMS/...). |

## Data Model

\`OrganizationDNA\` (one per organization) stores each facet as a typed or JSON
field: \`brand\`, \`voice\`, \`communicationStyle\`, \`businessHours\`,
\`knowledgeSources\`, \`complianceRules\`, \`escalationRules\`, \`aiDefaults\`,
\`providerDefaults\`, plus \`industry\` and a \`version\` for change tracking.
Locations live in the existing \`Location\` model; DNA references them rather than
duplicating them.

See \`DATA_MODEL.md\` for fields and \`packages/shared/src/identity.ts\` for the
\`OrganizationDNAShape\` type.

## Inheritance Model

\\\`\\\`\\\`
Organization DNA  (brand, voice, hours, style, compliance, escalation, defaults)
        |  inherited by
        v
   AI Employee  --(may override specific facets, e.g. its own voice/persona)-->
        |  bounded by
        v
   Permissions + Capabilities  (what it is allowed to do)
\\\`\\\`\\\`

Resolution order for any AI Employee setting: **employee override -> Organization
DNA -> platform default**. Compliance and escalation rules are *additive* — an
employee can tighten them but never weaken the organization's compliance floor.

## Why DNA Matters

- **Consistency** — every channel and every AI Employee sounds like one business.
- **Speed** — new AI Employees inherit a complete identity instantly.
- **Safety** — compliance and escalation are defined once, centrally, and
  enforced everywhere.
- **Industry-agnostic** — the same structure captures any vertical's identity.

## Relationship to Other Systems

- **AI Employees** (\`AI_EMPLOYEE_SYSTEM.md\`) inherit DNA.
- **Knowledge base** (\`KNOWLEDGE_BASE.md\`) is referenced via \`knowledgeSources\`.
- **Providers** (\`PROVIDER_PHILOSOPHY.md\`) are selected via \`providerDefaults\`.
- **Capabilities** (\`CAPABILITIES.md\`) gate what DNA-driven employees can do.
