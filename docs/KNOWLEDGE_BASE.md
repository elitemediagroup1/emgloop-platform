# Organization Knowledge Base

Every organization has a **Knowledge Base (KB)**: the source of truth AI
Employees consult **before** responding. The KB is what makes AI answers
accurate, on-brand, and consistent across channels — and it is per-organization,
so a pizzeria's menu never bleeds into a law firm's intake answers.

## Purpose

- Ground AI Employees in the business's real facts (hours, services, prices,
  policies, areas).
- Reduce hallucination by retrieving authoritative content at answer time.
- Keep answers consistent across phone, SMS, email, and chat.
- Make knowledge editable by the business without code changes.

## Future Knowledge Sources

The architecture supports ingesting many source types over time:

- **PDFs** (brochures, contracts, handbooks)
- **SOPs** (standard operating procedures)
- **Menus** (restaurants, pizzerias, fast food)
- **Price Lists** (services, parts, packages)
- **FAQs**
- **Policies** (cancellation, refund, privacy, warranty)
- **Service Areas** (zip/region coverage, delivery zones)
- Plus future sources: websites, spreadsheets, CMS, and provider catalogs.

## Pipeline

\\\`\\\`\\\`
source (PDF / SOP / menu / ...) 
   -> ingest (parse + normalize)
   -> chunk
   -> embed (vector representation)
   -> index (per-organization store)
   -> retrieve (at answer time, scoped to org + employee)
   -> ground the AI response
\\\`\\\`\\\`

Retrieval is always scoped by \`organizationId\` (hard tenant isolation) and
further narrowed by the AI Employee's knowledge scope and permissions.

## Data Model Direction

Introduce per-organization KB tables (documented here; implementation scheduled —
see \`ARCHITECTURE_REVIEW.md\`):

- \`KnowledgeSource\` — a registered source (\`organizationId\`, \`type\`, origin/uri,
  status, \`metadata\`). Types map to the source list above.
- \`KnowledgeDocument\` — a normalized document derived from a source.
- \`KnowledgeChunk\` — retrievable chunk with its embedding reference and
  provenance back to the document and source.

Embeddings use a provider-agnostic interface (the embedding/AI provider is
swappable), and the vector store is an infrastructure detail behind a retrieval
interface. The Loop **owns the knowledge and the retrieval logic**, not the
vector database vendor.

## Provider Abstraction

Embedding generation and (optionally) hosted retrieval are reached through
provider interfaces, consistent with \`PROVIDER_PHILOSOPHY.md\`. Swapping the
embedding model or vector store must not change module or AI Employee code.

## Governance

- **Freshness:** sources can be re-ingested; stale chunks are superseded.
- **Provenance:** every retrieved chunk traces to a document and source so
  answers can cite where they came from.
- **Access control:** an AI Employee only retrieves from the KB scope it is
  permitted to use.
- **Privacy:** KB content is tenant-isolated and never shared across
  organizations.

## How AI Employees Use It

At answer time, an employee retrieves the most relevant chunks for the customer's
intent, grounds its response in them, and (where appropriate) cites or defers.
If the KB lacks an answer and the action is sensitive, the employee escalates per
its escalation rules rather than guessing.
