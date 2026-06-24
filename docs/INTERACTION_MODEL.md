# Universal Interaction Model

Every customer interaction, on every channel, in every industry, fits **one
architecture**. This is what lets The Loop offer a single timeline, a single
inbox, and a single automation surface regardless of vertical.

## The Core Idea

An **Interaction** is any meaningful touch between a customer and the business.
We never assume what kind of business it is. A phone call, an SMS, an email, a
chat, a reservation, an appointment, an order, a form submission, a review, and a
payment are all Interactions sharing a common envelope, with kind-specific detail
held separately.

## Universal Envelope

Every interaction carries the same top-level shape:

| Field | Meaning |
|-------|---------|
| \`organizationId\` | tenant boundary |
| \`locationId\` | optional branch scope |
| \`customerId\` | who (nullable until identified) |
| \`kind\` | what kind of interaction (see taxonomy below) |
| \`channel\` | how it arrived (phone, sms, email, chat, web, social, in_person) |
| \`direction\` | inbound / outbound / internal |
| \`status\` | lifecycle state for that kind |
| \`occurredAt\` | when |
| \`provider\` + \`externalId\` | provider attribution, no vendor coupling |
| \`attributes\` | **kind- and vertical-specific detail (JSON)** |
| \`metadata\` | system/integration detail (JSON) |

The rule: **shared fields are industry-neutral; everything industry- or
kind-specific lives in \`attributes\`.** We never add a column like
\`tableNumber\` or \`caseType\` to the core — those are attributes.

## Interaction Kind Taxonomy

| Kind | Examples across verticals |
|------|---------------------------|
| \`PHONE_CALL\` | HVAC dispatch call, salon booking call, law intake call |
| \`SMS\` | appointment reminder reply, order status text |
| \`EMAIL\` | quote request, document exchange |
| \`CHAT\` | website chat, social DM |
| \`RESERVATION\` | restaurant table, salon chair |
| \`APPOINTMENT\` | dental cleaning, real-estate showing, service visit |
| \`ORDER\` | pizza order, fast-food order, retail order |
| \`FORM_SUBMISSION\` | contact form, lead form, intake form |
| \`REVIEW\` | Google/Yelp review, post-visit rating |
| \`PAYMENT\` | invoice paid, deposit, tip |

The taxonomy is extensible. New kinds are added as enum values; no structural
change is required because detail lives in \`attributes\`.

## How It Maps to the Schema

The Sprint 1 schema already encodes this philosophy:

- **\`Interaction\`** is the channel-agnostic timeline envelope (channel +
  direction + provider attribution + \`payload\`/\`metadata\`).
- **\`Conversation\` + \`Message\`** capture threaded dialogue kinds (phone, SMS,
  email, chat) with AI or human actors.
- **\`Booking\`** covers \`RESERVATION\` and \`APPOINTMENT\` (with \`partySize\`,
  calendar linkage, JSON \`items\`).
- **\`Order\`** covers \`ORDER\` (fulfillment type, money, JSON line \`items\`).
- **\`ServiceRequest\`** covers lead-style \`FORM_SUBMISSION\` and quoting.
- Reviews and payments attach as interactions/events with detail in
  \`attributes\` (Reviews/Payments modules formalize them).

### Recommended refinement (see ARCHITECTURE_REVIEW.md)

Introduce an explicit \`kind\` enum on \`Interaction\` and treat \`Interaction\` as the
**spine** of the timeline, with \`Conversation\`, \`Booking\`, \`Order\`,
\`ServiceRequest\`, review, and payment records linking back to a parent
interaction. This guarantees one unified timeline and one inbox feed without
industry-specific assumptions.

## Identity Resolution

Interactions may arrive before the customer is known (anonymous call, new email).
The model allows \`customerId\` to be null and resolved later by matching phone,
email, or external id — then back-linking prior interactions to the unified
\`Customer\`.

## Why This Matters

Because every interaction shares one envelope:

- The **Universal Inbox** can merge all channels into one feed.
- The **customer timeline** is a single ordered stream.
- **Workflows** can trigger on any interaction kind uniformly.
- **AI Employees** handle any channel through the same interface.
- Adding a vertical never requires new interaction plumbing.
