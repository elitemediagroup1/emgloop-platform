# Buyer / Call-Handling Diagnoser

_Phase 1 — First concrete DiagnosticEngine. Deterministic, pure, additive. No schema, UI, experiments, knowledge, Digital Twins, or LLM calls. No CallGrid behavior changes._

## What it answers

One narrow, real, CallGrid-grounded question:

> When calls are not qualifying/billable, is the likely cause the **buyer**, the **vendor**, **EMG** (internal routing/config), or is the evidence simply **insufficient**?

It is the platform's first implementation of the `DiagnosticEngine` contract (`diagnose(context) -> DiagnosticAssessment`). It intentionally does **not** try to solve every CallGrid problem — just buyer/call-handling performance.

## Inputs

The engine reads **Observations** off the `DiagnosticContext`; it never touches the database itself. Each observation maps to a CallGrid-derived metric that exists today (call status `answer / miss / no_answer / voicemail / transfer / complete / hangup`, and reconciled `Interaction.metadata` keys such as `durationSeconds`, `billable`, `buyer`, `vendor`). Canonical subjects (see `CALL_HANDLING_SUBJECTS`):

| Subject | Meaning | Unit |
| --- | --- | --- |
| `call_sample_size` | calls in the window | count |
| `buyer_answer_rate` | fraction the buyer answered | ratio [0,1] |
| `buyer_ended_rate` | fraction the buyer hung up | ratio [0,1] |
| `caller_ended_rate` | fraction the caller hung up | ratio [0,1] |
| `no_route_rate` | fraction that failed to route to a buyer | ratio [0,1] |
| `short_call_rate` | fraction of answered calls too short to qualify | ratio [0,1] |
| `avg_duration_seconds` | mean answered-call duration | seconds |

A pure helper, `buildCallHandlingObservations(scope, metrics, windowRef?)`, assembles these Observations from a plain metrics object for tests or future callers. It is **non-invasive**: it does not read the DB or change any behavior.

## Outputs

A single `DiagnosticAssessment` containing: the `observations` reasoned over, deterministic `findings`, attributed `rootCauses` (most-likely first), honest `unknowns`, `missingEvidence` the engine still wants, `alternativesConsidered` (carried on the causes), an overall `confidence`, and a `state` (`inferred` or `unknown`).

Root-cause categories use the shared `RootCause` union (`vendor | buyer | emg | unknown`). The user-facing category **"internal" maps to `emg`** (EMG-internal routing/configuration).

## Deterministic findings

- **Buyer answer rate degraded** — `buyer_answer_rate <= lowAnswerRate`.
- **Buyer ended calls unusually often** — `buyer_ended_rate >= highBuyerEndedRate`.
- **Caller ended calls unusually often** — `caller_ended_rate >= highCallerEndedRate`.
- **No-route rate elevated** — `no_route_rate >= highNoRouteRate`.
- **Duration too short to qualify** — `short_call_rate >= highShortCallRate`.
- **Insufficient sample / no threshold crossed** — root cause `unknown`.

## Classification logic

Each fired finding contributes a signal to a category:

- **buyer** <- low answer rate, buyer hangs up, short handled calls.
- **emg** <- elevated no-route (routing/config failure).
- **vendor** <- caller-driven hangups with otherwise healthy buyer behavior (poor traffic).

The category with the most concordant signals wins. **Ties and no-signal cases return `unknown`** — a single cause is never forced. Secondary categories with signals are recorded as additional `rootCauses` and as `alternativesConsidered`.

## Thresholds

All thresholds are explicit in `DEFAULT_CALL_HANDLING_THRESHOLDS` and can be overridden via `createBuyerCallHandlingDiagnoser(thresholds)`. Defaults:

| Threshold | Default |
| --- | --- |
| `minSampleSize` | 20 |
| `lowAnswerRate` | 0.60 |
| `highBuyerEndedRate` | 0.35 |
| `highCallerEndedRate` | 0.50 |
| `highNoRouteRate` | 0.15 |
| `highShortCallRate` | 0.40 |

Confidence scales with concordant signals and is **capped at 0.8** — a rules-based diagnoser never claims near-certainty.

## Returning "unknown" (first-class)

The engine returns an `unknown` assessment when: no observations are provided; the sample size is unknown; the sample is below `minSampleSize`; the sample is adequate but no metric crosses a threshold; or signals tie. In every case it attaches an `Unknown` with a `reason` and the `missingEvidence` that would most raise confidence.

## Limitations

- Deterministic thresholds only — no trend/seasonality, no per-buyer baselining, no statistical significance testing beyond the minimum sample gate.
- Reads only the metrics present; absent metrics reduce coverage and are surfaced as `missingEvidence` rather than guessed.
- Attribution is coarse (buyer / vendor / emg / unknown); it locates the likely owner of a call-handling problem, not the precise fix.
- **Nothing is wired into a live path.** The engine and its helper are pure and opt-in; ingestion, CallGrid, and all pages are unchanged.

## Usage (illustrative)

```ts
import { buyerCallHandlingDiagnoser, buildCallHandlingObservations } from '@emgloop/brain';

const observations = buildCallHandlingObservations(
  { organizationId: 'org_123' },
  { sampleSize: 140, answerRate: 0.42, buyerEndedRate: 0.5, noRouteRate: 0.05, shortCallRate: 0.1 },
  'window:2026-07-01..2026-07-02',
);

const assessment = buyerCallHandlingDiagnoser.diagnose({
  organizationId: 'org_123',
  subject: 'buyer_call_handling',
  observations,
});
// assessment.rootCauses[0].category === 'buyer'  (low answer rate + buyer hangups)
```

See the `DiagnosticEngine` contract in `diagnostics.ts` and the diagnostics-to-recommendations adapter for how a `DiagnosticAssessment` flows onward to a recommendation.
