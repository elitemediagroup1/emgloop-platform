# Website Provider — Website Intelligence (Sprint 14)

The Website Provider is EMG Loop's **second live ingestion source** (after CallGrid).
Where CallGrid gives the Brain a sense for phone calls, the Website Provider gives it
a sense for **every EMG-owned website**. Website activity becomes structured Brain
events that flow through the exact same pipeline as calls.

## Architecture

\`\`\`
Website
  ↓  Website Provider Adapter   (packages/providers/src/adapters/website.provider.ts)
  ↓  Normalization Engine       (packages/database/src/repositories/normalization.repository.ts)
  ↓  Integration Event
  ↓  Brain  →  Identity Resolution  →  Memory  →  Signal Detection  →  Intent
  ↓  Next Best Action  →  Workflow  →  CRM  →  Analytics  →  Revenue Attribution
\`\`\`

No website-specific business logic lives outside the adapter. Everything enters
through the Provider Layer, exactly like CallGrid.

## Supported properties

The provider is generic across every InMyCity property. Initially supported:

- \`servicesinmycity\`
- \`careinmycity\`
- \`petsinmycity\`
- \`consumersupporthelp\`

Any future property plugs in with no code duplication — the adapter keys on a
\`property\` field, never on a hard-coded site.

## Endpoint

\`\`\`
POST /api/webhooks/website
GET  /api/webhooks/website   (liveness probe; returns capabilities)
\`\`\`

A single delivery may carry ONE event (\`{ event, ... }\`) or a BATCH
(\`{ events: [ ... ] }\`) so a site can flush a whole session at once.
Webhooks are verified with HMAC-SHA256 (\`x-emg-signature\`) using
\`WEBSITE_WEBHOOK_SECRET\`; unsigned deliveries are accepted only when the
connection is configured with \`allowUnsigned\` (sandbox / reviewer mode).

### Example payload

\`\`\`json
{
  "property": "servicesinmycity",
  "event": "appointment_requested",
  "id": "evt_123",
  "occurred_at": "2026-06-26T15:00:00Z",
  "email": "jane@example.com",
  "page": "/hvac/financing",
  "city": "Austin",
  "category": "hvac",
  "session_id": "sess_abc",
  "visitor_id": "vis_xyz"
}
\`\`\`

## Event types

Page Viewed · Guide Viewed · Search Performed · ZIP Search · City Search ·
Category Search · CTA Click · Phone Click · Email Click · Form Started ·
Form Submitted · Appointment Requested · Newsletter Signup · Chat Started ·
Chat Completed · Resource Download · Quiz Started · Quiz Completed ·
Planner Started · Planner Saved · Planner Printed · Video Played ·
External Link Click · Affiliate Click · Session Started · Session Ended ·
Error Encountered

Each maps to a canonical \`web.*\` loop event type (see
\`packages/providers/src/adapters/website.provider.ts\` → \`WEBSITE_EVENT_MAP\`).

## Identity

Website activity creates no Customer (no Person in People). Anonymous activity
stays anonymous: the visitor and session ids the site reports are kept on each
event as facts, and journeys are counted per visitor (or per session when there is
no visitor id). An email or phone submitted in a form is kept on that event too,
and is never matched against People. Someone becomes a Person only through
governed identity resolution.

Customers created by earlier versions of ingestion (anonymous visitor profiles
with \`externalId = web-visitor:<id>\`, and leads created from a form's email or
phone) remain as they were; nothing merges into them.

## Signals

Website behaviour produces deterministic signals via the Signal Registry,
including: Research Intent, Comparison Shopper, Buying Intent, Appointment Intent,
Download Intent, Newsletter Subscriber, High Value Prospect, Returning Visitor,
Highly Engaged, Commercial Buyer, Pet Owner, Caregiver, Wedding Planning,
Moving Soon. Each signal carries confidence, evidence (metadata), timestamp,
source, and owning organization.

## Two senses, one Brain

Because website signals join the same signal pool the Next Best Action engine
reads, recommendations now reflect **both** senses. Example: a customer who shows
buying intent on the website and then calls is flagged as a high-confidence,
sales-ready lead.

## Where it surfaces

- **CRM** — website events appear in the customer Timeline and a dedicated
  **Website** tab (recent pages, searches, forms, CTAs, sessions).
- **Analytics** — Website Intelligence widgets: Top Landing Pages, Top Searches,
  Top CTAs, Session Sources, Top Cities, Top Categories, Most Common Journeys,
  Website Signal Breakdown — all derived from Brain events, not embedded GA.
- **Integrations** — the Website provider appears as a connected ingestion source
  with health, last event, and event counts, exactly like CallGrid.

## Guarantees

- Idempotent on \`provider + externalId\`.
- No new dependencies. No third-party analytics SDK. First-party only.
- No changes to Brain / CRM architecture, auth, permissions, or repository
  patterns — purely additive event types + signal rules.
