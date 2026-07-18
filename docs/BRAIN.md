# BRAIN.md — The EMG Loop Brain

**Status:** Product blueprint — the source of truth for every future Brain feature.
**Audience:** Executive team, product architecture, engineering leads.
**Supersedes:** the Sprint-12 `@emgloop/brain` package note previously at this path (its
service boundaries and pipeline are absorbed into §14).
**Subordinate to:** `LOOP_MASTER_BLUEPRINT.md` and `PLATFORM_CONSTITUTION.md`. Where any
statement here conflicts with those two, they win. This document is consistent with
`PLATFORM_ARCHITECTURE.md` ("the core product is the Brain").

This is not developer documentation. It is the product definition of the most important
part of EMG Loop. It is written to guide development for years, not one sprint.

---

## 0. How to read this document

Every claim about *current behavior* in this document is grounded in shipped contracts
(`@emgloop/brain`, `@emgloop/intelligence`) and existing platform docs. Every claim about
*future behavior* is marked as design intent, not as something already built. That
discipline is not incidental — it is the product. A blueprint for a system whose first
principle is "never fabricate" may not itself fabricate its own status.

Two words are used precisely throughout:

- **Today** — shipped and verifiable in the codebase.
- **Design intent** — a decision this document makes for the future. Binding as direction,
  not a claim of completion.

---

## 1. Vision

### 1.1 Why the Brain exists

A business owner does not have a data problem. They have an **attention problem**. Every
tool they own — the CRM, the call platform, the ad accounts, the analytics dashboards —
produces more information than any human can read, and none of it tells them the one thing
they actually need: *what changed, why it matters, and what to do about it.*

The Brain exists to answer exactly that question, every day, in the owner's own business
terms, with evidence they can check.

EMG Loop is an AI-first operating system for customer-facing businesses. The Brain is its
core. Everything else in the platform — CRM, Analytics, Workflows, AI Employees, Portals,
Revenue Intelligence, the Marketplace workspaces — is an **interface into the Brain**, not a
standalone product. The Brain is where facts become understanding and understanding becomes
a decision.

### 1.2 The long-term vision

Opening EMG Loop should feel like opening an operating system in the morning, not opening a
report. The owner sees one briefing: revenue, what moved, the risks worth heading off, the
opportunities worth pursuing, and the two or three decisions that deserve their attention
today. They act, or they defer with a reason. The Brain remembers what they decided and
watches what happened. Over quarters, it becomes the single institution that holds the
memory of how the business is actually run.

The end state is not a smarter dashboard. It is an executive partner that has read
everything, forgotten nothing, never guesses, and always shows its work.

### 1.3 The problems it solves

1. **Fragmentation.** Signals live in a dozen vendor systems. The Brain normalizes them into
   one sensor-neutral model and reasons across all of them at once.
2. **Noise.** Dashboards report hundreds of metrics with equal weight. The Brain reports
   **one KPI — revenue — and treats everything else as explanation**, ranked by how much it
   matters.
3. **Opacity.** Analytics tools assert numbers without provenance. Every Brain conclusion
   carries the evidence behind it and the confidence it earned.
4. **Amnesia.** Tools forget every decision the moment it is made. The Brain remembers
   decisions, their rationale, and their outcomes, and learns from the pattern.
5. **Fabrication.** Most "AI insights" products invent plausible narratives. The Brain refuses
   to. "Not enough data" is a first-class, respectable answer.

---

## 2. Core Philosophy

Seven principles. Each is enforced in a contract today, not merely aspired to.

### 2.1 The Brain explains
Every output states *what changed* and *why*, in plain language, in the owner's business
terms. Change is stated as a change, not as a metric readout — `IntelligenceChange` carries a
direction, a prior and current value, and a graded significance, never just a number.

### 2.2 The Brain recommends
The Brain does not stop at diagnosis. Every opportunity and every risk is a
`RecommendationEnvelope`: a plain-language recommendation, the reason, a suggested action, an
expected outcome, the business impact, and the risk of *both acting and not acting*. The Brain
proposes decisions; it does not take them autonomously (see §13).

### 2.3 The Brain remembers
The Brain's outputs are append-only and immutable. A `BrainActivity` is a frozen,
point-in-time record; a later reading produces a *new* activity, it never mutates the old one.
Memory is structured and deterministic — a durable understanding of each customer,
organization, campaign, and the institution itself.

### 2.4 The Brain learns
Outcomes feed back. The `LearningService` boundary turns what actually happened into
generalized, tenant-safe improvement. Learning sharpens confidence and prioritization over
time — within strict limits (§9).

### 2.5 The Brain never fabricates
This is the non-negotiable principle. Absent data is **absent**, never zero. A percentage
change from zero is `undefined`, not infinite. Revenue with no attribution is `null`, not
`$0` — an unmeasured business is not a $0 business. When the Brain cannot support a
conclusion, it says so and records what it would need. "Unknown" is a first-class value across
every contract (`RootCause`, `DiagnosticState`, `Unknown`).

### 2.6 The Brain always cites evidence
Every finding and every root cause carries `Evidence` — the real rows behind the claim, each
with a stable reference the owner can open. A recommendation with no evidence is not a
recommendation; a diagnosis with no evidence is not permitted by the contract.

### 2.7 The Brain earns trust
Confidence is *earned from coverage*, never asserted. It is a number in `[0,1]`, and it is
deliberately capped — a single module's read tops out at `0.7` today, because one period is a
direction, not a certainty. The Brain would rather be quietly right than confidently wrong.
Trust is the entire product; every other principle serves it.

---

## 3. Executive Briefing

The Executive Briefing is the owner-facing surface of the Brain — the one screen that matters.
It is a **read-only composition of intelligence-module outputs**. It knows nothing about
CallGrid, calls, or bids; it consumes `IntelligenceModuleOutput[]` and composes them. When a
second module ships, it appears in the briefing with no rewrite. That is the whole point of the
module contract.

**Structure (today).** One revenue headline (the only KPI), a merged narrative of 4–6
sentences, ranked opportunities and risks (each a full `RecommendationEnvelope`), what changed
(ranked by significance), concrete optimizations, and a projected `BrainBriefing` over every
module's activities. It also carries `unknowns`, `missingEvidence`, and per-module provenance,
so the owner always knows what the Brain could *not* see.

**Cadence (design intent).** Today one on-demand, windowed briefing exists. The cadence below
is the product design built on that primitive — each cadence is the *same* briefing engine run
over a different `IntelligenceTimeWindow` with a matched prior-comparison window. The engine
does not change per cadence; the window does.

| Cadence | Window / comparison | Purpose | Emphasis |
|---|---|---|---|
| **Morning briefing** | Yesterday vs prior day; week-to-date vs prior week | Start the day oriented | The 2–3 decisions that deserve attention today; overnight changes |
| **Afternoon changes** | Intraday delta since the morning briefing | Catch what moved mid-day | Only material changes since morning — silence when nothing moved |
| **Evening recap** | Today vs prior comparable day | Close the day honestly | What happened, what was decided, what is still open |
| **Weekly briefing** | Last 7 days vs prior 7 | The operating rhythm | Trends, buyer/source movers, optimizations worth a week's action |
| **Monthly briefing** | Last 30 days vs prior 30 | Management review | Revenue trajectory, margin health, decisions made and their results |
| **Quarterly briefing** | Quarter vs prior quarter | Strategic review | Structural shifts, learning accumulated, what to change next quarter |
| **Yearly review** | Year vs prior year | Institutional memory | The decisions of the year, their outcomes, and what the business learned |

Three rules govern every cadence:

1. **One KPI.** Revenue is the only headline number at every cadence. Everything else is
   explanation. There is no second KPI to add, ever.
2. **Honest silence.** A cadence with no material change says so in one sentence. The
   afternoon briefing is allowed to be nearly empty; padding it would be fabrication.
3. **Comparison or abstention.** A cadence with no comparable prior window does not invent a
   trend — it states that change and projection are limited, and says why.

---

## 4. Evidence Engine

Evidence is the foundation everything else stands on. If the Evidence Engine is honest, the
Brain is trustworthy; if it is not, nothing above it matters.

### 4.1 How evidence is collected
Facts enter only through **Sensors** (providers). A `Fact` is the atomic, interpretation-free
unit; a sensor emits facts and asserts no meaning. Facts are normalized into the canonical
domain model and persisted through repositories. The Brain reasons over windowed, aggregated
facts — never over a vendor payload directly.

### 4.2 Evidence layers
Evidence is layered from raw to reasoned, and every layer above raw points back down to it:

1. **Raw facts** — the sensor's interpretation-free records (e.g. a call, a payment).
2. **Canonical domain** — sensor-neutral projections (e.g. `MarketplaceCall`): the business
   abstraction, not the vendor's schema.
3. **Aggregations** — windowed, org-scoped rollups with explicit coverage denominators.
4. **Observations & findings** — `Observation` (asserts a value, no meaning) and `Finding`
   (a statement with severity, always carrying `Evidence`).
5. **Assessment** — a `DiagnosticAssessment`: observations, findings, root causes (most-likely
   first), unknowns, and missing evidence, with an overall confidence and state.

The atomic support unit at every layer is `Evidence`: its `kind`, a stable `ref` the owner can
open, a `description` of *why* it is evidence, when it was `observedAt`, and its `source`.

### 4.3 Coverage
Coverage is how much of the window the Brain could actually see, stated explicitly so it can be
honest. `DataCoverage` records calls observed, calls that carried revenue (economics coverage),
whether a prior window existed, whether bid/auction facts were supplied, and whether transcripts
were available. Coverage is surfaced to the owner as a caveat, always last, so a read never
overstates its own reach — e.g. "revenue was attributed on 84 of 120 calls."

### 4.4 Confidence
Confidence is earned from coverage, never declared. It rises with call volume, with the
existence of a prior window, with high revenue-attribution coverage, and with bid facts — and
it is capped (0.7 for a single module today). With no observed activity, confidence is `0` and
the summary says "Not enough data." Confidence is a single `[0,1]` field by design, so the
scoring model can be replaced later without changing a single consumer.

### 4.5 Missing evidence
Absence is recorded, not hidden. `MissingEvidence` names what to collect and why, with an
optional expected information gain. `missingEvidence` and `unknowns` arrays travel on every
envelope, activity, and briefing. This is how the Brain "asks better questions": missing
evidence is the backlog of what would raise confidence next.

### 4.6 Truthfulness
The truthfulness guarantees are structural, not stylistic:

- Absent metric → absent, never a fabricated `0`.
- Undefined ratio (division by zero) → `undefined`, never a misleading default.
- Unattributed revenue → `null`, never `$0`.
- Unsupported attribution → root cause `'unknown'`, never a hidden fallback.
- Every conclusion is grounded in a summed, observed value; nothing is modelled or estimated
  and then presented as fact.

---

## 5. Recommendation Engine

### 5.1 How recommendations are generated
Every opportunity and risk anywhere in the platform **is** a `RecommendationEnvelope` — the
canonical, fully-explainable Brain contract, never a stripped-down copy. Today they are
produced by **deterministic, auditable rules** over aggregated facts, with named thresholds
kept in one place so the product rules are tunable without a code hunt (e.g. margin
compression at ‑15% period-over-period, qualified-rate deterioration at ‑20%, a scale
candidate at ≥50% qualified rate). AI ranking can be introduced later *behind the same
contract*, so the output shape never changes.

A recommendation is only emitted when the evidence supports it. Where the evidence a
conclusion needs is absent — bid facts, a prior window, a second period of pricing — the engine
does not guess. It records the gap in `missingEvidence` and stays silent on that conclusion.

### 5.2 The anatomy of a recommendation
Every `RecommendationEnvelope` carries, at minimum:

- **recommendation** — the plain-language "do this," in business terms.
- **reason** — the diagnosis grounded in the numbers.
- **rootCause** — `'vendor' | 'buyer' | 'emg' | 'unknown'` (`'unknown'` is first-class).
- **trust** — confidence, the supporting `Evidence[]`, and `missingEvidence`.
- **alternativesConsidered** — other hypotheses with their likelihood; the Brain never
  presents a single answer as the only possible truth.
- **unknowns** — what it could not resolve, never silently omitted.
- **suggestedAction** — the concrete next step.
- **expectedOutcome** — a statement, and where estimable a metric and change.
- **risk** — level, description, and the **cost of inaction** (the risk of *not* acting).
- **businessImpact** — impact stated in the organization's own terms.

Because an envelope extends the base Brain object, it is also tenant-scoped, auditable,
versioned, and decay-aware.

### 5.3 Priority and urgency
**Priority** (`low | normal | high | critical`) is the platform's single triage axis — signals,
recommendations, actions, and activity severity all rank on it. Priority is derived
deterministically from the magnitude of what changed (e.g. a ≥40% swing is critical).
**Urgency** is the time dimension layered on top: how soon the cost of inaction compounds. A
margin-compression risk is high-priority *and* urgent because "the same calls earn
progressively less profit" every window it is left unaddressed.

### 5.4 Business impact and expected outcome
Impact and outcome are mandatory, not decorative. Impact is stated in the owner's terms
("protects gross profit on ~120 calls/window"; "revenue at risk on this buyer:
$4,200/window"). Expected outcome is stated honestly, and may be directional rather than
precise when precision would be a guess.

### 5.5 Confidence and evidence
Every recommendation's confidence is bounded by its evidence, and its evidence is attached.
Missing evidence *caps* confidence — honesty about ignorance is required, never hidden. A
recommendation the Brain is only 55% sure of says 55%, and says what would make it surer.

---

## 6. Investigation Engine

A recommendation the owner cannot interrogate is a recommendation they cannot trust. The
Investigation Engine is how an owner drills from a one-line recommendation all the way down to
the raw rows behind it.

### 6.1 The evidence chain
Every recommendation exposes its `Evidence[]`, and every piece of evidence has a stable `ref`.
The owner can follow the chain: recommendation → reason → the specific evidence rows → the
canonical domain records → the raw sensor facts. Nothing in the chain is summarized away; the
briefing carries full items, never collapsed ones.

### 6.2 Related entities
A recommendation names its subject (`buyer:Acme`, `source:XYZ`, `campaign:Spring`). From that
subject the owner reaches every related entity — the buyer, the sources feeding it, the
campaigns, the calls — because the canonical domain model is graph-connected, not siloed per
report.

### 6.3 Timeline
Each investigation is anchored in time (§8). The owner sees the window the conclusion was
drawn over, the prior window it was compared against, and the history of the same subject
across prior briefings — so a "buyer deteriorating" claim can be checked against that buyer's
actual trajectory.

### 6.4 Source data and provenance
Provenance is built in without leaking internals. A `BrainActivity` carries an `assessmentRef`
back to the assessment that produced it, and a `BriefingItem` carries an `activityRef` back to
its activity. The owner can always trace a headline back to its source; the Brain never asks to
be taken on faith.

---

## 7. Decision Memory

The Brain must remember not just what it observed, but what the owner *decided* — and what
happened next. This is the difference between an analytics tool and an operating system.

### 7.1 What is remembered
- **Approvals** — when an owner accepts a recommendation, it is recorded as a decision with an
  actor and a timestamp (today via the append-only `AuditEntry` action `'approved'`).
- **Ignored recommendations** — a recommendation deferred or dismissed is remembered, with the
  owner's reason where given. A recommendation ignored ten times should stop being surfaced the
  same way; a recommendation ignored once and then vindicated by events is a learning signal.
- **Results** — what actually happened after a decision: did margin recover, did the buyer's
  qualified rate stabilize, did the paused source stop the loss.
- **Learning** — the pattern across approvals, dismissals, and results (§9).

### 7.2 Current state and the gap (design intent)
Today the platform has the *primitives* for decision memory — append-only `audit` trails,
structured `MemoryRecord`s per subject, and `learnedSuppressions` on workflow memory — but
**there is no dedicated, typed Decision Memory object** that unifies approval, dismissal, and
outcome against a specific `RecommendationEnvelope`. Closing that gap is a defined requirement
of Brain V2 (§15). The design intent: a Decision record that references the recommendation, the
owner's disposition (approved / deferred / dismissed, with reason), and a later outcome
observation linked back by ref — append-only, tenant-scoped, and feeding the Learning boundary.

### 7.3 Principles
Decision memory is append-only (a decision is never rewritten), org-scoped (one tenant's
decisions never inform another's operations directly), and evidence-linked (a remembered
outcome carries the evidence that it happened). The Brain remembers so the owner does not have
to — and so the Brain can be held to its own past recommendations.

---

## 8. Timeline

The Timeline is the Brain's memory expressed as history. It is **append-only — nothing is ever
deleted** — and it is composed of immutable records, so history is auditable and reproducible.

Four interleaved histories share one timeline:

1. **Business history** — revenue, margin, and volume over time: the trajectory of the
   business itself.
2. **Operational history** — the operational facts: calls, connectivity, dispositions,
   ingestion health — what the machine did.
3. **Decision history** — what the owner decided and why (§7).
4. **Recommendation history** — what the Brain recommended, and whether events vindicated it.

Because `BrainActivity` records are frozen and time-stamped, the timeline is not a rendering
convenience — it is the substrate. Any surface (a briefing, a subject page, an audit) is a
projection over the same immutable activity stream. A later reading adds a new record; it never
edits the past.

---

## 9. Learning

Learning is how the Brain gets sharper without getting reckless. It is the most tightly
constrained subsystem in the platform, on purpose.

### 9.1 How the Brain becomes smarter
The `LearningService` observes outcomes — org-scoped, subject-tagged, valued — and turns them
into generalized improvement. Concretely (design intent, built on today's boundary):
sharper confidence calibration (recommendations that repeatedly prove right earn confidence
faster), better prioritization (patterns the owner consistently acts on rank higher), and
smarter suppression (recommendations consistently ignored are surfaced less, via
`learnedSuppressions`).

### 9.2 What it learns
- Which recommendation patterns the owner acts on, defers, or dismisses.
- Which recommendations were vindicated by later outcomes.
- Coarse, generalized, non-identifying patterns that hold across the tenant.

### 9.3 What it NEVER learns automatically
This is the line that must never move:

- **It never learns across the tenant boundary.** Customer records never cross organizations.
  Only generalized, non-identifying learning may be promoted to the network or platform tier —
  and only through the Trust layer's explicit evaluation.
- **It never trains a model that then acts on its own.** Learning changes ranking and
  confidence; it does not grant autonomy. The Brain recommends; humans and, later, escalation-
  bound AI Employees act.
- **It never overwrites institutional memory silently.** Learned changes are versioned and
  auditable; a learned suppression is a recorded fact, not an invisible one.
- **It never learns from fabricated data.** Learning consumes only observed outcomes with
  evidence. A guessed outcome is not an outcome.

Today there is no vector database and no model training; learning is a deterministic boundary.
That is a deliberate V1 posture, not a limitation to apologize for — determinism first, models
later behind the same interface.

---

## 10. Marketplace Intelligence

Marketplace Intelligence is the Brain's first fully-realized intelligence domain and the
template for every domain that follows.

### 10.1 The Sensor model
**CallGrid is a Sensor, not the product.** Ringba, Invoca, Twilio, Salesforce, HubSpot, Meta,
and Google Ads are also sensors. Marketplace Intelligence is the durable, sensor-agnostic
business abstraction that sits above all of them. A sensor emits facts; it never emits a
recommendation. Swapping CallGrid for another call platform changes an adapter, not the Brain.

### 10.2 The canonical domain
The sensor's schema is translated into a sensor-neutral canonical model — `MarketplaceCall` and
the Buyer / Source / Vendor / Campaign intelligence abstractions — expressed in business
vocabulary the vendor does not own. This is what makes the intelligence portable: the Brain
reasons about *a call in a marketplace*, not about a CallGrid API object.

### 10.3 What it contributes today
The CallGrid module produces one `IntelligenceModuleOutput`: a revenue headline, what changed
(revenue, volume, margin, qualified/conversion rates, per-buyer and per-source movers), risks
(margin compression, break-even windows, buyer deterioration, low acceptance), opportunities
(scale candidates, buyers ready for more volume), concrete optimizations (pause, decrease,
negotiate, increase, reallocate), and honest market and predictive reads. It states plainly
what it cannot see — transcripts the sensor does not deliver, buyer caps CallGrid does not
expose, competitive pricing that needs multi-window bid facts — rather than inventing it. Its
predictive reads are labelled low-confidence by construction: "one period is a direction, not a
forecast."

### 10.4 Why it is the template
Marketplace Intelligence proves the pattern the whole platform repeats: sensors emit facts →
canonical domain → an intelligence module → the Executive Briefing. Every future domain
implements the *same* `IntelligenceModule` contract and inherits the Brain's contracts
(`RecommendationEnvelope`, `BrainActivity`) unchanged.

---

## 11. Future Intelligence Modules

The `IntelligenceModule<TInput>` contract is the platform's extension point. A module takes
windowed, sensor-neutral facts and a supplied clock/identity, and returns one
`IntelligenceModuleOutput`. The briefing reads that output. Adding a module is writing a sibling
of the CallGrid module — never a rewrite of the briefing.

The following are the intended future modules. Each is design intent; the contract that makes
them cheap already exists.

- **In My City** *(grounded direction).* The cross-organization benchmarking network. It is
  the platform's canonical source of generalized, non-identifying comparison — how a business
  compares to its peer set — and is bound by the Trust tiers: benchmarks are generalized
  learning, never another tenant's customer records. ServicesInMyCity is already named as the
  platform's first external data source.

- **Talent** *(candidate — not yet specified).* An intelligence module over hiring, staffing,
  and workforce performance for customer-facing businesses. No specification exists yet; it is
  named here to reserve the pattern, not to imply readiness. It will implement the same module
  contract or it will not ship.

- **CRM Intelligence.** The CRM is a module and an *interface into the Brain*, not the product.
  CRM Intelligence reasons over the customer graph — lifecycle, churn risk, lifetime value,
  next best action per customer — and feeds the same briefing.

- **AI Employees.** The Loop's defining unit of action: configured, role-bound, permission-
  scoped agents. As an intelligence surface, AI Employees are both a *consumer* of Brain
  recommendations (they execute approved actions within deny-by-default permissions and a
  mandatory human escalation path) and a *subject* of intelligence (their performance is
  measured and reasoned about). No AI Employee ever acts without a defined escalation path, and
  none may weaken its organization's compliance floor.

- **Future providers.** New sensors (payments, calendar, ads, transcription) arrive as
  adapters and enrich existing modules or seed new ones. A new provider never reshapes the
  Brain; it feeds it.

- **Future businesses / Vertical Brains.** Care, Pets, Marriage, Services, Homes, Creator,
  Business, and Revenue Brains share the same core and specialize only their knowledge and
  their prioritized signals. **A vertical is configuration, not a fork.** A pizzeria and a law
  firm run the same Brain with different knowledge and different signals switched on.

---

## 12. Owner Experience

### 12.1 What the owner feels
Calm, and in control. Opening the Brain feels like opening an operating system, not auditing a
spreadsheet. The palette is restrained; the language is plain; the screen answers the owner's
real question instead of burying it. The owner feels *ahead* of their business rather than
buried under it.

### 12.2 How often they visit
Daily, by habit, because the morning briefing is worth ninety seconds and repays them. Not
because a notification nags them — because the briefing reliably contains the two or three
things that matter and nothing that doesn't. Cadence (§3) meets the owner where they already
are: a quick morning read, an optional afternoon glance, a weekly rhythm, a monthly review.

### 12.3 What they accomplish
In one session: understand what changed, see the decisions that deserve attention, act or
defer with a reason, and trust that what they decided is remembered. Over a quarter: run the
business by exception, spending attention only where the Brain has earned their attention.

### 12.4 Why they trust it
Because it has never lied to them. It says "I don't know" when it doesn't. It shows the
evidence for everything it does say. It never inflates a number, never pads an empty day, never
presents a guess as a fact, and never buries what it missed. Trust is not asked for; it is
accumulated, briefing by briefing.

---

## 13. What Brain NEVER Does

The anti-patterns. These are stated as prohibitions because the failure mode of every
intelligence product is to drift into one of them.

1. **It never becomes another dashboard.** One KPI, ranked explanation, and decisions — not a
   wall of metrics with equal weight.
2. **It never becomes another reporting system.** It does not exist to display data; data
   exists only to support explanation and recommendation. The report is a by-product.
3. **It never becomes another CRM.** EMG Loop is not a CRM. The CRM is one interface into the
   Brain. The Brain does the work and records what happened as a by-product.
4. **It never becomes another analytics tool.** Analytics answers "what happened." The Brain
   also answers "why" and "what to do," with evidence and a decision.
5. **It never fabricates.** No invented metric, trend, recommendation, or narrative. Absent is
   absent; unknown is unknown; null is null.
6. **It never presents a single answer as the only truth.** Alternatives considered travel with
   every recommendation.
7. **It never acts autonomously (current posture).** The intelligence layer outputs
   recommendations and workflow suggestions, not autonomous actions. Autonomy, when it comes,
   arrives through permission-scoped, escalation-bound AI Employees — never through the Brain
   acting on its own.
8. **It never crosses the tenant boundary with customer data.** Customer records never leave
   the organization. Only generalized, non-identifying learning may be promoted, and only
   through the Trust layer.
9. **It never couples to a vendor.** No vendor SDK types cross a module boundary; no vendor name
   appears in core logic; every sensor is swappable.
10. **It never forks per industry.** Verticals are configuration; industry shape lives in
    JSON attributes, never in industry-specific tables or code branches.
11. **It never deletes its history.** Intelligence primitives are append-only.
12. **It never hides what it missed.** `unknowns` and `missingEvidence` are surfaced, never
    silently dropped.

Anything that would require forking the core, coupling to a single vendor, or fabricating a
value is, by definition, out of scope — not a feature to negotiate.

---

## 14. Architecture Principles

### 14.1 The layered chain

```
        Brain            ← owns decisions; the canonical contracts and the reasoning core
          ↑
     Intelligence        ← modules that turn windowed facts into one standard output
          ↑
     Repositories        ← the only database access; all Prisma lives here
          ↑
   Canonical Domain      ← sensor-neutral business model (e.g. MarketplaceCall)
          ↑
      Providers          ← Sensors: the outside world, emitting interpretation-free facts
```

Read bottom-up as the flow of a fact, and top-down as the flow of authority:

- **Facts flow up.** A provider (sensor) emits interpretation-free facts. Repositories persist
  them, normalized into the canonical domain model. Intelligence modules reason over windowed,
  aggregated canonical facts. The Brain owns the decision that results.
- **Authority flows down.** The Brain owns decisions and the canonical contracts. Intelligence
  modules must express every conclusion in those contracts. The domain model asserts facts, not
  decisions. Sensors assert facts only, never recommendations.

### 14.2 How this maps to the code today (grounded, no fabrication)

The conceptual chain above maps to real packages, though the code's dependency direction is
worth stating precisely so no one is misled:

- `@emgloop/brain` — the canonical contracts and deterministic scaffolding (`RecommendationEnvelope`,
  `BrainActivity`, `BrainBriefing`, `DiagnosticAssessment`, `Confidence`/`Priority`/`Evidence`,
  Trust, Memory). Depends only on `@emgloop/shared`.
- `@emgloop/intelligence` — the reusable `IntelligenceModule` framework, the CallGrid module,
  and the Executive Briefing assembler. Depends only on `brain` and `shared`.
- `@emgloop/database` — the repositories; the *only* Prisma access. App code never touches
  `PrismaClient` directly.
- **Canonical domain model** — the sensor-neutral shapes (`MarketplaceCall`, Marketplace
  Buyer/Source/Vendor/Campaign intelligence). The vocabulary is deliberately not the sensor's.
- `@emgloop/providers` — sensors and adapters at the edge; normalized webhooks land as
  integration events. `brain` depends *on* the fact/sensor types here; the outside world is
  held at arm's length behind adapters.

The Brain itself is a set of permanent service boundaries — Identity Resolution, Memory, Signal
Registry, Intent, Customer/Organization Graph, Knowledge, Recommendation / Next Best Action,
Revenue Intelligence, Learning, and Trust — behind one `BrainService.process(event)` facade,
running the canonical pipeline: *Provider → Adapter → Normalization → Integration Event → Event
Store → Brain → Workflow → CRM → Analytics → Portals.*

### 14.3 Why this shape

- **Provider-agnostic.** Swapping a sensor never touches the Brain. The intelligence is the
  asset; the infrastructure is rented.
- **Tenant-safe by construction.** Every object is org-scoped; the Trust layer denies any
  cross-org access that carries a customer record.
- **Deterministic first.** Every contract is satisfiable by rules today; AI can be added later
  behind the identical interface, so consumers never change.
- **Reuse over redeclaration.** Every opportunity/risk is *the* `RecommendationEnvelope`; every
  insight is *the* `BrainActivity`. No stripped-down copies, no parallel shapes to drift.
- **Explainable end to end.** Because authority flows down through fixed contracts, evidence and
  provenance are available at every layer without special-casing.

---

## 15. Roadmap

Versioned by capability, not by date. Each version is a coherent product posture; the guiding
constraint is that **no version rebuilds the previous foundation** — new domains arrive as
modules, new sensors as adapters.

### Version 1 — Foundation (shipped / in progress)
- The Brain contracts: `RecommendationEnvelope`, `BrainActivity`, `BrainBriefing`,
  `DiagnosticAssessment`, Evidence/Confidence/Trust primitives. **Shipped.**
- The reusable `IntelligenceModule` framework + Executive Briefing assembler. **Shipped.**
- Marketplace Intelligence Module 1 (CallGrid), sensor-neutral `MarketplaceCall`. **Shipped /
  in progress.**
- Deterministic, rules-based recommendations with earned confidence and full evidence.
  **Shipped.**
- One on-demand, windowed Executive Briefing. **Shipped.**

### Version 2 — Memory & Cadence
- **Decision Memory** as a first-class, typed object: approval / deferral / dismissal (with
  reason) linked to a `RecommendationEnvelope`, plus outcome observations linked by ref (§7.2).
- **Briefing cadence**: morning / afternoon / evening / weekly (the daily operating rhythm),
  built on the windowed-briefing primitive (§3).
- **Learned suppression & prioritization** from decision outcomes, within the tenant boundary
  (§9).
- **Ingestion-health evidence**: surface sensor/reconcile/webhook failures as Brain evidence,
  so coverage is honest about pipeline gaps.

### Version 3 — Breadth & Depth
- **Second intelligence module** (In My City benchmarking or CRM Intelligence), proving the
  briefing composes N modules with no rewrite.
- **Monthly / quarterly / yearly** briefings and the institutional-memory review.
- **Investigation Engine** as a full surface: drill from headline → evidence → canonical
  records → raw facts, with subject timelines.
- **Richer evidence layers** as new sensors land (transcripts, bid/auction facts, payments),
  each unlocking previously-withheld conclusions honestly.

### Future — Network & Bounded Autonomy
- **Network Intelligence**: generalized, non-identifying benchmarking across EMG-operated orgs,
  strictly through the Trust tiers.
- **AI ranking behind the same contracts**: model-based prioritization and confidence,
  swapped in without changing a single consumer.
- **Bounded autonomy** via AI Employees: approved recommendations executed within deny-by-
  default permissions and mandatory human escalation — never the Brain acting on its own.
- **Vertical Brains** switched on by configuration.

Everything beyond this is parking-lot (`FUTURE_CAPABILITIES.md`) and not a promise. The test for
graduating any idea: it must be consistent with `LOOP_MASTER_BLUEPRINT.md` and
`PLATFORM_CONSTITUTION.md`, and it must not fork the core, couple to a vendor, or fabricate a
value.

---

## 16. Open questions

These are decisions the executive team should make deliberately; the answers shape V2–V3.

1. **Decision Memory shape.** Should approval/dismissal/outcome be a new typed object, or an
   extension of the existing `audit` + memory primitives? (Blueprint recommends a typed object;
   §7.2.)
2. **Cadence delivery.** Are briefings pull (owner opens the OS) or push (delivered by
   email/notification at each cadence)? Push raises a fabrication risk — a scheduled briefing
   with nothing to say must still say nothing, gracefully.
3. **Intraday windows.** The afternoon briefing needs an intraday comparison window; today's
   primitive is period-over-period. Do we define a canonical set of windows, or let each
   cadence declare its own?
4. **When does AI enter?** Rules-based is the V1 posture. What is the concrete trigger to
   introduce model-based ranking behind the contract — coverage, volume, a quality bar?
5. **Cross-tenant benchmarking mechanics.** In My City needs a rigorous definition of
   "generalized, non-identifying." Who certifies that a benchmark carries no customer record?
6. **Suppression ethics.** Learned suppression must not hide a risk that *became* real. How do
   we distinguish "the owner correctly ignores this" from "the owner is ignoring something they
   shouldn't"?
7. **Talent module scope.** Is Talent a committed direction or a parking-lot idea? It has no
   specification today and should not be built until it does.
8. **Multi-sensor revenue attribution.** When two sensors report overlapping revenue, whose
   number is canonical? Revenue is the one KPI; double-counting it is the one unforgivable
   fabrication.

---

## 17. Precedence & change control

This document guides Brain product development. It is subordinate to `LOOP_MASTER_BLUEPRINT.md`
and `PLATFORM_CONSTITUTION.md`; where it conflicts with either, they win. Material changes to
the Brain's product definition should update this file in the same change that implements them,
so the blueprint never drifts from the system it describes — the same standard the Brain holds
itself to.
