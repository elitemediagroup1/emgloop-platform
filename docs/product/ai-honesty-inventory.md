# AI honesty inventory — what claims intelligence, and what is actually behind it

**Status:** AUDIT COMPLETE, C1-C4 IMPLEMENTED (2026-09-16). Product decided to **delete** "AI resolution
rate" rather than rename it. The corrections below are applied; the table is kept as the record of what
was found and why each answer was chosen.

**One correction to this audit itself.** It listed *two* percentage-confidence renders. The fence written
with the fix found **five**: three more in `intelligence-ui.tsx` (lines 467, 731, 1048) that a
surface-by-surface read had missed. A grep-backed fence found what reading did not, which is the argument
for writing the fence at all.
**Purpose:** Loop must not ship real AI beside fake AI. Slice AI S1 sends real model output to a screen;
the day it does, every *other* surface implying intelligence has to be either genuinely intelligent or
honestly labelled. This is the list, the classification, and the correction sequence.

**Method.** Every surface naming AI, Brain or intelligence was read, then traced to what produces it.
Nothing here is inferred from a name.

---

## 1. Classification

| Surface / value | Produced by | Class | Action |
|---|---|---|---|
| **Executive Brain** (`packages/intelligence/src/executive/brain.ts`) | Pure, deterministic reasoning over sensor evidence. Suppresses any finding citing a withheld or absent metric; derives confidence from the Evidence Engine, never from what a sensor asserted about itself | **Real deterministic logic** | Keep. Rename the *label* only if "Brain" reads as AI to a user — the logic is sound |
| **Commercial Intelligence** (Headlines, Cases, Findings, Recommendations, Monitoring) | Governed detection over measured objectives, with an append-only observation log | **Real deterministic logic** | Keep |
| **Evidence Engine confidence** (`deriveConfidence`, `packages/intelligence/src/evidence/engine.ts`) | Coverage × sample size × staleness × contradictions. The formula is exported so a domain can see how its number was produced | **Legitimate deterministic metric** — *not* model certainty | Keep the number; change how it is **presented** (§2) |
| **"AI resolution rate"** (`/crm/analytics`, `analytics.repository.ts:157`) | `(1 − sentimentSignals ÷ aiConversationEndSignals) × 100`, counted from `Signal` rows of type `ai.conversation_start` / `ai.conversation_end` / `SENTIMENT` | **FAKE AI** | **Remove or rename.** No AI resolves anything. It is a ratio of behavioural signal rows presented as an AI performance metric, and it reads `0%` when the signals are absent — a zero dressed as data |
| **"AI Setup Assistant"** (`/crm/integrations/assistant`) | A deterministic intent-to-provider resolver. The code header says "deterministic, no external AI" and the page subtitle says so too — but the `<h1>` says "AI Setup Assistant" | **Heuristic, mislabelled** | **Rename.** The subtitle already tells the truth; the heading contradicts it. "Setup Assistant" costs nothing |
| **AI Employees** (`AIEmployee` model, `/crm/ai-employees`) | Identity and configuration of an assignable worker. No LLM. CLAUDE.md names "pretending to think" as the anti-pattern | **Real configuration, risky name** | Keep the feature; the surface must not imply reasoning until one exists behind it |
| **`demonstrateBrainActivityFlow`** (`packages/brain/src/brain-activity.ts`) | Named "demonstrate", used by the live briefing path | **Semantic-state candidate** | Replace with a real envelope author over real signals (a standing goal in CLAUDE.md §Long-Term Goals 5) |
| **`Signal` / `DomainEvent` confidences** | Behavioural rules with insert-time timestamps | **Heuristic** | Already excluded from Universal Activity as derived duplicates. Do not surface them as intelligence |
| **Dormant resolver confidence** (`identity-resolution.ts`, `IdentityRelationship.confidence`) | The dormant cognitive resolver | **Future/dead** | Retired with identity slice 2.1a. No screen reads it |
| **Loop AI runtime** (`packages/shared/src/ai`, slice S0) | Contracts only — `activated: false`, no SDK, no credential | **Future model output** | Must not appear in any UI until S1 activation. No surface references it today ✅ |

---

## 2. Numeric confidence — the real finding

**The correct pattern already exists and is already shipped.** `apps/web/src/app/app/admin/marketplace/queue-ui.tsx`
renders confidence through `confidenceOf(s)` → `{ strength, label, basis, determinacyNote }`: a semantic
state with the reason attached. That is the target, and it is not hypothetical.

**Two surfaces still render a raw percentage:**

| Where | What it renders | Why it is wrong |
|---|---|---|
| `apps/web/src/app/app/admin/marketplace/intelligence-ui.tsx:90` | `{Math.round(finding.confidence * 100)}%` | A derived coverage figure shown as a certainty percentage. A reader cannot distinguish "87% of the sample was covered" from "87% likely to be true" |
| `apps/web/src/app/app/_loop-os/entity-page.tsx:253` (fed by `admin/home-data.ts:140`) | `{a.confidencePct}% confidence` | Same, on Loop Home's entity page |

This conflicts directly with **C-05** ("identity posture is never a number") and with the semantic
direction the queue surface already implements. It is also the exact pattern a model's self-reported
certainty would slot into — which is why it has to go **before** S1, not after.

---

## 3. Correction PR sequence

Each is small, independent, and none needs a migration.

| # | PR | Change | Risk |
|---|---|---|---|
| **C1** | Retire the "AI resolution rate" | Remove the metric from `/crm/analytics` and `analytics.repository.ts`, or rename it to what it measures (`escalation-free conversation rate`) and show an honest unavailable state when the signals are absent | Low. One metric, one screen. **Needs a Product call:** delete or rename |
| **C2** | Rename "AI Setup Assistant" → "Setup Assistant" | Heading only; the subtitle already says deterministic | None |
| **C3** | Semantic confidence on the two remaining surfaces | Replace both percentage renders with the existing `strength / label / basis` presentation from `queue-ui.tsx`. **Reuse, do not re-invent** | Low, but touches Loop Home — coordinate with the design track |
| **C4** | Fence | A test asserting no `% confidence` string and no `confidence * 100` render survives in `apps/web` | None |

**C1–C4 are prerequisites for shipping S1 to a screen.** They are not prerequisites for building S1.

---

## 4. What this audit did *not* find

- **No "Brain Status: Online"**. The anti-pattern CLAUDE.md names by name is gone.
- **No UI claiming a model is thinking, analysing or answering.** Nothing says "powered by AI".
- **No LLM anywhere.** The repository contains no provider SDK and reads no model credential (verified
  repo-wide in slice S0).

The honesty problem in Loop today is **narrower than feared and specific**: one fabricated AI metric, one
misleading heading, and two percentage renders that should be semantic states.
