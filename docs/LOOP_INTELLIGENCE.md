# Loop Intelligence — Architecture Blueprint

Sprint 10 — Loop Intelligence Foundation.

This document is the long-term blueprint for the EMG Loop intelligence system.
It defines how every external event enters the platform, how it is normalized,
and how it flows through the Loop intelligence pipeline to produce actionable
insights and automated responses.

---

## 1. Vision

EMG Loop is not a CRM. It is the operating system and intelligence layer behind
every business we own.

Every signal from every source — phone calls, web visits, ads, SMS, AI agents,
human agents, bookings, orders — is normalized into a common language and
routed through a single intelligence engine.

The pipeline:

    External Event
      -> Ingestion (IntegrationEvent)
      -> Normalization (Interaction | Signal | DomainEvent)
      -> Analytics Brain (aggregation, trends, KPIs)
      -> Loop Intelligence (what happened, why, what next)
      -> Workflow Trigger (automated response)

---

## 2. Event Taxonomy

Events are the raw material. Every event has: id, organizationId, source
(provider name: callgrid, ga4, gads, gsc, clarity, stripe), externalId (for
idempotency), eventType (normalized string), occurredAt, receivedAt, payload
(raw JSON), and normalized (boolean).

### Normalized Event Types

Call/Voice: call.inbound, call.outbound, call.answered, call.missed,
call.completed, call.voicemail, call.transferred

Web/Analytics: web.session_start, web.page_view, web.goal_conversion,
web.form_submit

Advertising: ads.impression, ads.click, ads.conversion, ads.lead_form_submit

Search: search.impression, search.click, search.position_change

Payments: payment.initiated, payment.succeeded, payment.failed,
payment.refunded, subscription.created, subscription.canceled

Messaging: sms.inbound, sms.outbound, email.sent, email.delivered,
email.opened, email.clicked, email.bounced, email.unsubscribed

AI Activity: ai.conversation_start, ai.conversation_end, ai.escalation,
ai.booking_created, ai.intent_detected

Internal: crm.customer_created, crm.booking_created, crm.booking_completed,
crm.pipeline_moved, workflow.triggered, workflow.completed

---

## 3. Signal Taxonomy

Signals are derived intelligence — what an event MEANS, not just what happened.
They are append-only, org-scoped, and confidence-scored.

| SignalType          | Source                                  | Description                        |
|---------------------|-----------------------------------------|------------------------------------|
| INTENT              | call.inbound, web.form_submit, ads.lead | Customer seeking a service         |
| SENTIMENT           | call.completed, ai.conversation_end     | Positive/negative/neutral          |
| CHURN_RISK          | booking_canceled, email.unsubscribed    | Customer likely to disengage       |
| UPSELL_OPPORTUNITY  | booking.completed + payments            | Customer likely to buy more        |
| LIFETIME_VALUE      | Aggregate payments                      | Estimated total customer value     |
| NO_SHOW_RISK        | Prior no-show + booking created         | Likely to miss upcoming booking    |
| SATISFACTION        | Post-interaction                        | Customer satisfaction score        |
| LANGUAGE            | Any interaction                         | Communication language detected    |
| TOPIC               | Call transcript, AI conversation        | Subject of interaction             |
| LEAD_VELOCITY       | INTENT to booking.created time          | Speed of lead conversion           |
| RESPONSE_TIME       | Inbound to first response time          | Business responsiveness            |
| SOURCE_ATTRIBUTION  | First-touch + last-touch events         | Channel that acquired customer     |

---

## 4. Interaction Taxonomy

Interactions are customer-facing touchpoints produced by the normalizer.

| Channel   | Event Sources        | Direction          |
|-----------|----------------------|--------------------|
| PHONE     | call.*               | INBOUND/OUTBOUND   |
| SMS       | sms.*                | INBOUND/OUTBOUND   |
| EMAIL     | email.*              | INBOUND/OUTBOUND   |
| WEB_CHAT  | ai.conversation_*    | INBOUND            |
| SOCIAL    | ads.lead_form_submit | INBOUND            |
| OTHER     | Unclassified         | INBOUND            |

Normalizer populates: organizationId, customerId (by email/phone match),
channel, direction, occurredAt, durationSeconds, summary, and metadata
including source, provider, and integrationEventId.

---

## 5. Analytics Taxonomy

### Operational
- Inbound call volume — Interaction (PHONE, INBOUND), Day/Week/Month
- Missed call rate — call.missed / call.inbound, Day/Week/Month
- Average response time — RESPONSE_TIME signal, Day/Week/Month
- Lead volume — INTENT signal count, Day/Week/Month
- Booking rate — Bookings / INTENT signals, Day/Week/Month
- Booking completion rate — completed / created bookings, Month

### Marketing
- Ad impressions/clicks — ads.impression, ads.click, Day/Week/Month
- Organic impressions/clicks — search.impression, search.click, Month
- Web sessions — web.session_start, Day/Week/Month
- Conversion rate — web.goal_conversion / sessions, Month

### Customer
- New customers — crm.customer_created, Day/Week/Month
- Lifetime value — LIFETIME_VALUE signal, All time
- Churn signals — CHURN_RISK signal count, Month
- Source attribution — SOURCE_ATTRIBUTION signal, Month

---

## 6. KPI Definitions

Lead Velocity: COUNT(INTENT signals in period). Target: growing week-over-week.

Pipeline Velocity: AVG time from first INTENT signal to booking completion.
Target: decreasing over time.

Response Time: AVG(RESPONSE_TIME signal metadata.responseSeconds).
Target: under 5 minutes for AI, under 15 minutes for human.

Booking Rate: COUNT(Booking) / COUNT(INTENT Signal) x 100 in period.
Target: improving month-over-month.

AI Resolution Rate: 1 - (ai.escalation / ai.conversation_end) x 100.
Target: above 70%.

Workflow Automation Rate: COUNT(WorkflowRun SUCCEEDED) / COUNT(DomainEvent) x 100.

---

## 7. Cross-Reference Strategy

IntegrationEvent
  -> produces Interaction, Signal, DomainEvent (via normalizer)

DomainEvent
  -> triggers WorkflowRun (via runWorkflowsForEvent)
  -> appears in per-customer activity stream

Signal
  -> feeds Analytics views and Loop Intelligence engine

Interaction
  -> linked to Customer (email/phone match or null)
  -> linked to Conversation (if messaging channel)
  -> feeds Analytics and Intelligence

Cross-reference maintained via:
- externalId on Interaction/Signal/DomainEvent for idempotency
- metadata.source and metadata.provider on all normalized entities
- metadata.integrationEventId linking back to the raw ingest record

---

## 8. Data Lineage

External System
  -> IntegrationEvent (raw, RECEIVED -> PROCESSING -> PROCESSED/FAILED)
  -> NormalizationEngine.normalize(event)
      -> Interaction (the touchpoint)
      -> Signal (the meaning)
      -> DomainEvent (the fact, triggers workflows)
         -> WorkflowRun (automated response)

Analytics reads: Interaction, Signal, Booking, WorkflowRun, DomainEvent
Intelligence reads: Analytics aggregates + Signal stream

Guarantees:
1. Every IntegrationEvent traces to produced Interaction/Signal/DomainEvent.
2. Every workflow trigger traces to the DomainEvent that fired it.
3. Every analytics data point traces to its source Signal or Interaction.
4. Intelligence primitives are append-only. Nothing is deleted.

---

## 9. Intelligence Responsibilities

Layer 1 — What happened?
Descriptive analytics: counts, rates, volumes over time. Computed from real
Neon data via Signal and Interaction aggregations.

Layer 2 — Why did it happen?
Diagnostic: correlation between signals. Example: "Missed call rate spiked
Tuesday — correlates with 3 new CHURN_RISK signals."

Layer 3 — What should happen next?
Prescriptive: scored recommendations from KPI gaps. Example: "Response time
up 40% this week — recommend activating AI Employee for after-hours." These
surface as workflow suggestions, not autonomous actions.

Sprint 10 constraints: no LLM calls, no ML models, no autonomous actions.

---

## 10. Future AI Reasoning Responsibilities

Sprint 11+:
- Natural language analytics queries ("Why did bookings drop last week?")
- LLM-powered signal interpretation (sentiment from call transcripts)
- AI-generated workflow suggestions from performance gaps

Sprint 13+:
- Predictive churn scoring (ML on Signal history)
- Predictive LTV scoring
- Optimal scheduling recommendations

Long-term:
- Cross-organization benchmarking (InMyCity brand network)
- AI-generated business health reports
- Autonomous AI Employee configuration recommendations

The Sprint 10 architecture supports all of these without rework.
Signal-first. Append-only. Org-scoped. Provider-agnostic.

---

## 11. Provider Integration Planning

See docs/integrations/ for per-provider planning documents:

- CALLGRID.md — Call tracking -> Interaction/Signal
- GOOGLE_ANALYTICS_4.md — Web analytics -> Signal/DomainEvent
- GOOGLE_ADS.md — Ad performance -> Signal/DomainEvent
- GOOGLE_SEARCH_CONSOLE.md — Organic search -> Signal
- MICROSOFT_CLARITY.md — Session intelligence -> Signal
- STRIPE.md — Payments -> Interaction/Signal/DomainEvent
- TWILIO.md — SMS/Voice -> Interaction
- TELNYX.md — SMS/Voice -> Interaction
- POSTMARK.md — Email -> Interaction
- ANTHROPIC.md — AI reasoning -> Signal (future)
- OPENAI.md — AI reasoning -> Signal (future)
- ELEVENLABS.md — Voice synthesis (AI Employee, no signals)

---

Last updated: Sprint 10 — Loop Intelligence Foundation.
