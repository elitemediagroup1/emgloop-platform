# EMG Loop
## Commercial Intelligence — Stage 4
### Product & UI Handoff for Charlie + Lexi

*Verified against `main` at `bc70d83` on 2026-09-09. Everything below was read from
the code, not from pull-request descriptions.*

---

## Stage 4 product status

**Complete and merged.** Loop can now take a measured change in the business,
put it in front of the right person, let them authorise an investigation, and
carry that investigation through evidence, a claim, several possible responses,
the people involved, the work it produced, a monitoring window, an outcome and a
resolution — with every step recorded and nothing invented.

| | |
|---|---|
| Surfaces you can design against | 5 |
| Human controls that actually work | 9 |
| Representative states you can view without an incident | 23 |
| Things Loop will do to the outside world | **0** |

---

## What Loop can do now

**In one sentence:** Loop watches what the business said it was trying to
achieve, tells the right person when something measurably moved, shows its
working, and helps them run an investigation — without ever pretending to know
more than it does.

**In one paragraph:** A person opens Loop in the morning and is told either that
nothing needs them *and what Loop checked to be able to say that*, or that Loop
cannot currently tell, or that there are things to look at. Each thing is a
**Headline** with the measurement behind it. If they think it deserves the
organisation's attention they press **Investigate**, and only then does an
investigation — a **Case** — exist. Inside it they find what Loop claims and
whether the evidence establishes it, several ways to respond with their
tradeoffs, who has been asked to contribute and why, what work exists and where
it stands, what Loop is watching and what would count as it having held, and
eventually what happened. They can accept or reject the claim, pursue or set
aside an option, change its steps, ask somebody to help, set up or correct the
monitoring, and close or reopen the investigation. Every one of those is
recorded with their name on it, and none of them does anything outside Loop.

---

## 1. The journey, and where a human decides

```
Performance Objective          somebody wrote down what the business is trying to do
        │
        ▼
   Measurement                 Stage 3 decides whether it CAN be measured
        │                      ── if not, nothing is raised at all
        ▼
    Headline                   a measured change, with its receipts
        │
        ▼
Morning Intelligence           ranked for this person, with why
        │
        ▼
 ┌──── INVESTIGATE ────┐       ◀── HUMAN DECISION. Nothing before this creates anything.
 │                     │
 ▼                     ▼
Case                Dismiss     "not this" — with a reason Loop learns from
 │
 ├─ Evidence · 5Ws · what Loop doesn't know
 ├─ Finding                     developing → established (or not)
 │      └─ ◀── HUMAN: accept / reject
 ├─ Recommendations             several viable options, with tradeoffs
 │      └─ ◀── HUMAN: pursue / set aside / change the steps
 ├─ People                      who was asked, and what for
 │      └─ ◀── HUMAN: ask / release
 ├─ Work                        read from Work OS. Loop does not own it.
 ├─ Monitoring                  what would count, declared in advance
 │      └─ ◀── HUMAN: start / correct
 ├─ Outcome                     what happened — never why
 └─ Resolution
        └─ ◀── HUMAN: close (two kinds) / reopen
```

### Six things that are true by construction

1. **A Headline is not a Case.** Rendering, expanding, hovering over or reading
   the evidence of a Headline creates nothing anywhere. The card that draws a
   Headline reaches no service at all.
2. **Investigate is the human boundary.** It is the only path in the entire
   application that can open an investigation, and it cannot run without an
   attributed, signed-in person.
3. **A Finding is not editable truth.** There is no field, anywhere, for changing
   what a claim says. A person can accept or reject it; they cannot rewrite it.
4. **A Recommendation is not an action.** Pursuing an option records a decision
   to pursue it. Nothing leaves Loop.
5. **Participation is not work assignment.** Asking three people to contribute
   creates no task, no assignee and no due date.
6. **Uncertainty cannot become success.** A monitoring window Loop could not
   judge stays unjudged.

---

## 2. Morning Intelligence

**Route:** `/app/admin/headlines` · nav label **Headlines**

This is the first screen, and the one with the most opportunity to mislead.

### The four mornings

| State | What the person is told | When |
|---|---|---|
| **All clear** | "No material changes require your attention. Loop checked *N* active objectives and every eligible measurement window is current." | Nothing raised **and** every active objective was measurable |
| **Can't tell** | "Loop can't determine whether anything requires your attention. *N* of *M* objectives have incomplete measurement coverage." | Nothing raised, and **one or more** objectives could not be measured |
| **Needs your attention** | "*N* things need your attention." | Something is on the list |
| **Nothing to check** | "Loop has nothing to check: no active objective says what this organization is trying to accomplish." | Nobody has declared an objective |

### The property this whole screen exists to protect

> **An empty list means two opposite things.** Either Loop looked at everything
> and found nothing, or a poller stopped and Loop had nothing to look at. Both
> render as zero cards. One is good news.

**Three of the four mornings show zero Headlines. Only one of them is all clear.**

The screen has **no branch on how many Headlines there are.** The state arrives
already decided by a rule that re-reads every active objective's measurement
verdict. You are free to redesign all four completely — but the decision about
*which* one to show is not the screen's to make, and "the list is empty" must
never become the reason.

An all-clear also **names what it checked** (objectives watched, measurable now,
Headlines). An all-clear that does not say what it looked at is indistinguishable
from one that looked at nothing.

Where coverage is incomplete the screen names **which objectives** and **why**,
with three different reasons leading to three different next moves —
*waiting for data*, *source not configured*, *conflicting evidence*.

### A failed read is not an empty morning

If the read itself fails, the screen shows a visibly different thing that shares
no styling with any normal state, and says in words: *"This is a failure to read,
not a finding. Nothing here should be taken as evidence that today's headlines is
healthy or empty."* Please keep that distinction visually unmistakable.

---

## 3. The Headline, and what is behind each part

Your three-part concept maps onto what exists like this.

### THE HEADLINE — *fully supported*

One sentence composed from the measurement, plus the numbers: current value,
prior value, the change, and the window. Direction is shown as "with" or
"against" the objective — which is arithmetic against a stated intent, not a
judgement about the business.

### WHY YOU'RE SEEING IT — *partly supported, and the limit matters*

**Available:** the Performance Objective it was measured against, and whether the
move runs with or against that objective's stated direction. On the personal
queue, additionally: the strongest relationship this person has to the
investigation, and every reason behind it with the exact row it came from.

**Not available:** "this is your account", "you own this buyer", "you handle this
client". Loop has **no governed answer** to those. The only responsibility fact
in the platform is a user-scoped Performance Objective. Please do not design a
relevance line that implies ownership Loop cannot establish.

### THE RECEIPTS — *fully supported, and richer than you may expect*

In the card: coverage percentage, how many calls were measured, how many times
the condition has been seen, the comparison basis in words, and a count of
caveats. Directly beneath: **what this measurement does not establish** — the
limitations and unknowns, in full, in the card rather than behind a link.

Behind a disclosure, for whoever needs it: rule id, rule version, the exact
threshold, the measure binding and its version, the producer build, both windows,
prior coverage, prior denominator, first and last detected.

That is your progressive disclosure ladder, already built: **claim → posture →
receipts → provenance.** You are free to restyle every rung.

---

## 4. The Investigation

**Route:** `/app/admin/headlines/[id]`

Opening a Headline puts a person in front of an argument they have to judge. The
Investigate control is at the **bottom**, deliberately: the decision belongs after
the evidence, not beside the title.

| Your concept | Supported by | Notes |
|---|---|---|
| **The Claim** | the Headline statement + the numbers | fully |
| **Why It Matters** | the objective + direction of the move | as above, no invented ownership |
| **What Loop Knows** | the measurement, both windows, coverage | fully |
| **What Loop Doesn't Know** | limitations + unknowns, as a block above the page | fully — and it renders **above** everything, because a caveat inside an evidence list reads as evidence |
| **How Loop Knows** | rule, version, binding, producer, windows | fully, behind a disclosure |
| **History** | first detected, last detected, detection count, dismissal | fully |
| **Investigate** | the governed human action | fully |

If an investigation already exists, the page says so and offers a way **into**
it rather than a second Investigate button. Pressing Investigate twice never
opens two investigations.

**Presentation choices, entirely yours:** the order of these sections, whether
"How Loop Knows" is a disclosure or a panel, how the numbers are visualised, and
how much of the caveat block is visible before expanding.

---

## 5. The Case Workspace

**Route:** `/app/admin/cases/[id]`

One read assembles everything. A Case on its first morning has no Finding, no
recommendations and no work — that is completely ordinary, and every section has
an honest shape for it.

### What is available

**Header:** the claim, the current lifecycle state in product language, the
objective it was measured against, **who authorised it and when**, who is
accountable, who is working it, and how many people are being waited on.

> There is deliberately **no "Case owner."** Accountability, execution and
> participation are three different questions with three different answers, and
> the header shows all three rather than flattening them.

**Above everything:** what Loop could not establish, gathered from every part.
A Case with a dangling work reference and an unmeasured monitoring window must
not read as a healthy one.

### The 5Ws

Derived from the evidence and the log — never inferred.

| | Typically available |
|---|---|
| **Who** | people from the timeline, entities from the evidence |
| **What** | the metric and the comparison basis |
| **When** | the observed window |
| **Where** | a campaign, market, channel or system — **often empty** |
| **Why** | **usually empty, and that is correct** |

When a dimension is empty *for a structural reason*, the contract supplies the
sentence and the screen renders it instead of a blank. For **Why** that sentence
says Loop has no governed evidence establishing why this happened.

> **An empty Why is a successful product state, not a broken screen.** Nothing in
> Loop infers a cause. Please do not design a Why panel that looks wrong when
> empty — it will be empty most of the time, and filling it convincingly would be
> designing for a Loop that does not exist.

### What should feel primary

Based on what is actionable, not on visual preference:

1. What Loop could not establish *(it changes how everything else should be read)*
2. The Finding
3. The options, and which one somebody chose
4. Who is being waited on
5. Where the work stands
6. Monitoring
7. Outcome
8. The 5Ws
9. The timeline

That ordering is a suggestion from the contracts. **Rearranging it is yours to
decide** — but the first item should stay near the top.

---

## 6. Findings

Loop's claim about what is happening. **Four states, and two independent axes.**

### Axis one: what the evidence supports

| | Meaning |
|---|---|
| **Developing** | Loop has a claim, and the evidence does not yet meet the standard to establish it |
| **Established** | the evidence currently meets the governed standard |

### Axis two: what a person decided

| | Meaning |
|---|---|
| **Accepted** | a person judged the claim correct |
| **Rejected** | a person judged it wrong. It is still the current claim, and Loop keeps evaluating its evidence |

### The distinction that must never collapse

> **Established ≠ Accepted.**

- **Established** is an evidence determination, re-derived **on every read**.
- **Accepted** is a human decision, recorded once.

Three consequences for your designs:

1. **Accepting does not make weak evidence strong, and rejecting does not make
   strong evidence weak.** A person's judgement is not an input to the gate at
   all: Established + Rejected and Developing + Accepted are both ordinary. The
   control says so on screen. *(Corrected in Stage 5 PR 1 — until then an
   acceptance established a claim outright.)*
2. **Establishment can weaken by itself.** If the measurement behind a claim
   degrades, the same stored claim stops reading as Established — with nothing
   written in between and nobody having changed their mind. Please do not design
   Established as a permanent badge that gets "awarded".
3. **They need different visual treatments.** A person must never have to guess
   whether a green state means *Loop can stand behind this* or *somebody agreed
   with it*.

### What a Developing Finding shows

The claim, its supporting evidence count, the window, and — importantly — **what
stands between it and being established**, in plain sentences drawn from the
gate's own refusals: *"Part of the evidence population did not report"*, *"Two
pieces of evidence disagree about this"*, *"The measurement behind this claim is
not currently ready"*.

A developing claim whose obstacles are invisible is just a weaker claim. Naming
them is what makes it useful.

### Supersession

Earlier claims are kept **in their own words**, with when they stood and the fact
that something replaced them. History is never visually rewritten.

### Why there is no confidence percentage

There is no governed confidence anywhere in this platform. A percentage on a
screen is read as authority, and Loop was never granted it. **Please do not add
one, and please do not translate a missing one into a middle value** — an
unassessed thing reads as "Not assessed", never as "Moderate".

### What the UI must never allow

Editing a Finding's words to make the conclusion more convenient. There is no
field for it and there must never be one. A claim changes when the evidence does,
or when a newer claim supersedes it.

---

## 7. Recommendations

The lesson this experience exists to teach: **Loop can show several reasonable
moves and explain their tradeoffs without pretending one is objectively correct.**

### What is available

- **Several options**, each with a name, a paragraph, and a ranked position
- **A posture** — *Learn first · Find out · Reversible change · Committed change*
- **Up to nine tradeoff factors**, each with a level and a **stated basis**
- **An action sequence** — numbered steps, each opening with a governed verb
- **Why one sits above another** — pairwise comparisons over the declared
  factors, including the factors **neither** option assessed

### The rank is declared, not scored

There is no weighting and no number. A person can read the actual reasons and
disagree with them. **Please do not introduce a score** — it would be a judgement
nobody could reconstruct.

### Factor levels

*Low · Moderate · High · **Not assessed***

**"Not assessed" is not a polite Moderate.** It means nobody assessed it, and it
is excluded from the comparison entirely. It must read as an absence.

### The three things a person can do

| Control | What changes | What does **not** change | Anything external? |
|---|---|---|---|
| **Pursue this** | approval recorded on that option; a "selected" entry on the log | every other option, exactly as Loop wrote it | **No** |
| **Set aside** | a "dismissed" entry on the log | the option itself is untouched | **No** |
| **Change the steps** | a **new** record marked as the person's, pointing at Loop's | **Loop's original sequence, kept in full** | **No** |

The revision form starts from Loop's wording and says on screen that Loop's
original is kept either way. Both versions render side by side afterwards.

### How sequence revision works

Uncheck a step to drop it. Edit the wording to change it. Add a step by choosing
a verb and writing the rest.

**Verbs come from a fixed vocabulary:** *Review, Investigate, Confirm, Compare,
Check, Evaluate, Monitor, Contact, Consider, Validate.* Words that assert an
outcome Loop cannot support — *Increase, Decrease, Shift* — are not offered and
would be refused. This is why a step reads *"Evaluate shifting volume to the
backup buyer"* rather than *"Shift volume"*.

There is deliberately **no drag-and-drop**: the underlying operation takes a
replacement list, not a move, and a drag interaction would be inventing a
capability.

---

## 8. People

**A Case can involve several people, each asked for something different.**

```
Charlie   — DECIDE          "Decide whether to move volume while we establish the cause."
Matt      — INVESTIGATE     "Work out whether the drop is buyer-wide or source-specific."
Mike      — RELATIONSHIP    "Ask the buyer directly whether their qualification changed."
```

Six kinds of contribution: **Decide · Investigate · Relationship · Domain input ·
Approve · Informed.** Two of them — Decide and Approve — mean the Case is
*waiting on* that person, and the header counts them.

Every participant carries **the request in the words of whoever added them**. It
is required: a participant with no stated reason is a name on a list, and whoever
arrives next has to guess what was wanted.

Released participants are kept, with what they were asked for.

### The line that must stay visible

> **Case participation ≠ Work assignment.**

Asking somebody to contribute creates **no task, no assignee and no due date**.
The screen says so in words, and nothing in the participation path touches Work
OS at all. Please keep them visually distinct — a participant row that looks like
a task row would quietly merge two different concepts.

---

## 9. The Work OS boundary

| | Owns |
|---|---|
| **Commercial Intelligence** | why somebody is involved, and what contribution the investigation needs from them |
| **Work OS** | whether it is being done, by whom, by when, what is blocking it, and whether it is late |

The Case **reads** execution state. It never stores or recomputes it — which is
why the same Case read an hour later can show a different verdict with nothing
having been written.

### The health states you must distinguish

| Product word | Means |
|---|---|
| **On track** | measured, and inside the expected time |
| **Overdue** | actionable for a while and has not moved |
| **Badly overdue** | actionable for over a day |
| **Paused** | legitimately waiting; the clock is paused and the time already spent is kept |
| **Done** | nothing further expected |
| **Not measured** | **Loop has no execution history and cannot say** |

> **"Not measured" must never look like "On track."**
>
> Stage 4 fixed exactly this defect: the Work OS detail page used to call a stage
> with no recorded history *"On track"*. Absence of evidence that something is
> late is not evidence that it is fine. Every work item created before this
> foundation is in that state today, so you will see it often.

Three further states you will encounter, each with its own sentence: the work
lives in a system Loop cannot read; the work no longer exists; the work has no
execution history.

**Escalation** is the honest one: Loop can say *"eligible for escalation"* and
then says it **cannot determine who it should go to**, because this platform has
no reporting relationship between people. Please do not design a "notify their
manager" control — there is no manager to notify.

---

## 10. Monitoring

**What Loop is watching, and what would count as it having held.**

A plan carries: the condition, a baseline *(optional)*, a success criterion, a
failure criterion, the observation window, and the evidence required before Loop
will judge it at all — minimum observations, minimum coverage, and whether the
window must have finished.

### Loop proposes none of it

There is no suggested threshold and no default baseline. **A criterion Loop
proposed would be Loop marking its own homework.** A person writes down what
would count *before the answer is known* — which is the only reason a verdict
later means anything.

### The verdicts

| Product word | Means |
|---|---|
| **It held** | the declared success criterion was met, on adequate evidence |
| **It did not hold** | the declared failure criterion was met |
| **Neither** | neither criterion was met, on adequate evidence |
| **Still watching** | the window has not finished |
| **Inconclusive** | **there was not enough evidence to judge it** |

> **Inconclusive is a real product state and it is the default today.** The
> measurement seam is not wired to a live producer, so most windows will come
> back unjudged. That is rendered honestly rather than faked.
>
> It must never look like success — and it is also not failure. It means Loop
> could not tell.

**When there is no baseline:** the monitor can still detect a threshold breach,
but it **cannot report a recovery**, and the plan shows "None recorded" rather
than a fabricated starting point.

**Corrections are appends.** Revising a plan keeps every earlier version in full,
so *"what did we originally say would count"* stays answerable after the numbers
are in. The screen says how many times it has been corrected.

---

## 11. Outcome, resolution and reopening

### Outcome: what happened, never why

An outcome reports what was observed after the intervention, with its full
lineage — the Finding, the options recorded, which one was selected, the work
referenced, the monitoring window and the evidence.

It carries, as its own visible block, the sentence saying Loop **cannot attribute
the change**: there is no control, no counterfactual and no way to separate this
intervention from everything else that changed in the same window.

> Please keep that caveat visible. Hiding it turns a careful result into an
> implied claim.

### Two ways to close, and the difference matters

| | Means |
|---|---|
| **Yes — we acted** | somebody did something about it |
| **No — it did not need action** | closing without having acted |

Both require **what actually happened** from a governed list of thirteen
outcomes, each shown with a sentence explaining it, and a **written reason**.

Two of those outcomes — *"Loop should not have raised this"* and *"Real, and
nothing needed doing"* — count against Loop, and are marked as such. **This is
how Loop's false-positive rate is computed**, which is the single most important
number Loop can publish about itself. A single "Close" button would destroy it.

### Reopening

The earlier resolution **stays on the log**. A reopened Case shows how many times
it has come back, and both the close and the reopen appear in the timeline.

> A resolution that did not hold is the most informative event an investigation
> can carry. A reopened Case must never look like one that was never resolved.

---

## 12. The human control model

| Concept | Control | What changes | What does **not** change | History | External? |
|---|---|---|---|---|---|
| **Headline** | Dismiss ("Not this") | records that it did not need attention, and which of two reasons | it keeps recurring; dismissal never silences it | dismissal + who + when | No |
| **Headline** | **Investigate** | opens an investigation | nothing about whether the Headline is correct | attributed authorisation on the log | No |
| **Finding** | Accept / Reject | records a person's judgement | **the claim's words. Ever.** | verdict + who | No |
| **Recommendation** | Pursue | records intent to pursue | every other option | selection + who | **No** |
| **Recommendation** | Set aside | records it was set aside | the option as Loop wrote it | dismissal | No |
| **Sequence** | Change the steps | adds the person's version | **Loop's original** | both versions, side by side | No |
| **People** | Ask | records who was asked and for what | creates no task | the ask, in their words | No |
| **People** | Release | records the release | what they were asked for | both | No |
| **Monitoring** | Start / Correct | records the plan in force | every earlier plan | full plan history | No |
| **Case** | Close | records the outcome and reason | prior history | the close + why | No |
| **Case** | Reopen | brings it back | **the earlier resolution** | close *and* reopen | No |

**Every row's last column is "No."** That is the whole external-action boundary,
in one place.

Every action is attributed to the signed-in person. A human click never produces
"system" history. Repeating an action never manufactures a second event.

---

## 13. Product language

There is **one dictionary**. Every governed state passes through it, and it
carries the technical name alongside so a support conversation, a bug report and
a log line all still work.

### Five tones, five shapes

| Tone | Glyph | Means | Who acts |
|---|---|---|---|
| Verified | ✓ | Loop stands behind it | nobody |
| Incomplete | ◑ | real, and partial | depends |
| Waiting for data | ◷ | something has to arrive | nobody — just wait |
| Needs setup | ⚙ | somebody must decide something | a person |
| Conflicting | ⚠ | the evidence disagrees with itself | neither waiting nor configuring helps |

The glyphs differ in **shape**, not only colour — so a monochrome screen, a
printout and any form of colour blindness carry the same information. **Please
keep a word and a shape on every state.**

### The vocabulary as it stands

| Technical | Product |
|---|---|
| `ALL_CLEAR` | All clear |
| `INSUFFICIENT_COVERAGE` | **Can't tell** |
| `NOTHING_TO_CHECK` | Nothing to check |
| `NEEDS_ATTENTION` | Needs your attention |
| `UNKNOWN` *(work)* | **Not measured** |
| `WITHIN_POLICY` | On track |
| `REMINDER_ELIGIBLE` / `ESCALATION_ELIGIBLE` | Overdue / Badly overdue |
| `PAUSED_WAITING` | Paused |
| `waiting_internal` / `waiting_external` | Waiting on us / Waiting on them |
| `HELD` / `DID_NOT_HOLD` / `NEITHER` | It held / It did not hold / Neither |
| `WINDOW_NOT_OBSERVED`, `RECONCILIATION_MISSING`, `AUTHORITATIVE_DATA_PENDING` | Waiting for data |
| `SOURCE_AUTHORITY_MISSING`, `MEASURE_NOT_SUPPORTED_BY_SOURCE` | Source not configured |
| `SOURCE_AUTHORITY_CONFLICT` | Conflicting sources |
| `RECONCILIATION_INCONCLUSIVE`, `CAMPAIGN_EXPECTATION_CONTRADICTED` | Conflicting evidence |
| `POPULATION_INCOMPLETE`, `AUTHORITATIVE_DATA_INCOMPLETE`, `CALL_UNATTRIBUTED` | Incomplete |
| `MIXED_SOURCE_AGGREGATION_UNSUPPORTED` | Cannot be combined |
| `DEVELOPING` / `ESTABLISHED` | Developing / Established |
| `NEEDS_REVIEW` / `ASSIGNED` / `WATCHING` | Needs review / Under investigation / **Monitoring** |
| `RESOLVED` / `DISMISSED` | Resolved / **Closed without acting** |

**An unmapped state renders its own technical name** — not a friendly default.
That is deliberate: a state nobody has named is a state nobody has thought about,
and the omission belongs on screen.

### Five distinctions that are contracts, not styling

These may not be collapsed even if two badges would look similar:

- **Unknown ≠ Healthy.** Not measured is not on track.
- **Inconclusive ≠ Failure.** Loop could not tell is not "it did not hold".
- **Incomplete ≠ Zero.** An unmeasured number renders as **—**, never as 0 or $0.
- **Nothing to check ≠ All clear.** Complete coverage of nothing is not health.
- **Error ≠ Empty.** A failed read is not an empty result.

---

## 14. Evidence and receipts

Available to render, at three depths:

**On the Headline:** coverage, denominator, detection count, comparison basis,
caveat count.

**In the investigation:** the measurement itself, both windows, coverage for
each, and the limitations and unknowns in full sentences.

**Deeper, for whoever needs it:** rule id and version, the exact threshold in
words, the measure binding and its version, the producer build, precise window
boundaries, prior coverage and denominator.

**On a Case:** each evidence item's source, what it measures, its window, its
value, and its completeness — where **completeness `null` is not `1`**. A
producer that did not state how much of the population reported is a different
fact from one that reported all of it, and the contract keeps them apart.

The three-rung ladder is a **presentation opportunity that is fully backed by
data**. How much of each rung is visible before expanding is entirely your call.

---

## 15. Personalisation

**Route:** `/app/admin/queue` · nav label **Your queue**

### What exists

Every open investigation is ranked for one person by a declared walk over three
facts — never a score.

**Relevance tiers, strongest first:**

1. **Waiting on you** — you were asked to decide or approve, and not released
2. **You were asked to help**
3. **You own this** — accountable
4. **You are working this**
5. **Measured against your objective**
6. **Not assigned to you**

Then severity, then whether it moved against something the business said it
wanted.

**Every item can explain itself.** Each reason names the exact row it came from,
so somebody who disagrees can go and look. And **every adjacent pair carries a
sentence** saying why one sits above the next:

> *"It is more directly yours: you were asked for something on it."*
> *"You are equally connected to both, and this one is more severe."*
> *"Both are equally severe, and this one moved against something the business said it wanted."*
> *"Nothing separates them, so the order they arrived in is kept."*

### What does not exist

The queue reports, in the UI, what it **could not** weigh:

- how much revenue is exposed
- what a client or partner relationship is worth
- what this could be worth if it goes well
- how much else this person is already carrying
- who reports to whom

> **Please do not invent an "AI score."** There is no governed priority number,
> and the whole value of this surface is that the ordering can be argued with.

**Also important:** an empty personal queue means *nothing is currently yours* —
it says nothing about whether the business is fine. The empty state says so and
points at Headlines, which is the surface that answers that question.

Items nothing connects you to still appear, in the lowest tier. A queue that hid
them would let the most important thing in the business be invisible to everyone
not personally named on it.

---

## 16. The review harness

**Route:** `/app/admin/review`

### How to open it

1. Set `EMG_SEED_DEMO=true` in a non-production environment
2. `npm run dev`
3. Sign in, and go to `/app/admin/review`

It is **fail-closed**: without the opt-in, or on production, the route returns
not-found. It reads nothing from the database and can write nothing.

### The 23 states currently on it

**Morning (4)** — all clear · can't tell · needs attention · nothing to check

**Work (5)** — in progress · blocked · **escalation eligible with no recipient** ·
never measured · reference no longer resolves

**Monitoring (2)** — inconclusive · it held

**Outcome (2)** — recovered with cause not established · nothing established

**Learning (2)** — one observation · emerging pattern

**Controls (7)** — a developing finding · a finding somebody rejected · an option
with its sequence · start watching · correct a monitoring plan · close an
investigation · reopen one that did not hold

**Failure (1)** — a read that failed

### These are the real components

Not mockups. Every value is typed as the contract production returns, so if a
contract changes the harness stops compiling. The **controls are the real
controls** posting to the real guarded actions — they simply name a fixture
investigation id that resolves to nothing, so they cannot touch anything real.

### What to review

- **Information hierarchy** — does the most important thing lead?
- **Comprehension** — can somebody who has never seen Loop read a Headline?
- **Uncertainty distinction** — can you tell *all clear* from *can't tell* at a glance?
- **Interaction clarity** — before pressing, is it obvious what will happen?
- **Visual priority** — does "what Loop doesn't know" get enough weight?
- **Responsive behaviour** — narrow to ~380px; nothing should disappear
- **Accessibility** — tab through it; every control should be reachable and announced
- **Language** — is anything more reassuring than it should be?

---

## 17. Visual freedom vs product contract

### You can change freely

- Layout, spacing, grid, density
- Typography and type scale
- Colour palette and the specific tone colours
- Component composition and how sections are grouped
- Which information sits behind a disclosure and which is visible at rest
- Icon set and glyph choices *(provided each state keeps a distinct shape)*
- Ordering of Case sections
- How numbers and trends are visualised
- Responsive arrangement and breakpoints
- Motion, where it serves comprehension
- All button and section wording, **within the meaning constraints below**
- How evidence receipts are presented at every depth

### Please do not change without a product conversation

| Contract | Why |
|---|---|
| **All clear vs can't tell** | Collapsing them is the single most damaging thing this UI could do |
| **Zero Headlines ≠ healthy** | Health comes from measurement coverage, not list length |
| **Unknown ≠ on track** | Absence of overdue evidence is not compliance |
| **Inconclusive ≠ success** | And it is the default state today |
| **Error ≠ empty** | A failed read must never render as a calm screen |
| **Established ≠ accepted** | Evidence determination vs human decision |
| **A Finding's words are not editable** | Claims change through evidence, not preference |
| **Loop's recommendation survives revision** | Both versions must remain visible |
| **Participation ≠ work assignment** | Asking somebody creates no task |
| **Investigate is the human boundary** | Nothing may open an investigation implicitly |
| **Two ways to close** | The false-positive rate depends on the distinction |
| **Reopen preserves the resolution** | History is never rewritten |
| **No confidence percentage** | There is no governed confidence to show |
| **No priority score** | The ordering must remain arguable |
| **Nothing external happens** | No button may imply Loop acted outside itself |

---

## 18. The external action boundary

> ### Loop does not do anything outside itself.

Stage 4 does **not** mean Loop autonomously sends email, contacts a buyer or
creator, messages anyone, changes traffic routing, changes spend, or commits EMG
to anything.

**Pursuing a recommendation means:**
*"We are pursuing this direction inside Loop."*

**It does not mean:**
*"Loop did it."*

The confirmation message says exactly that: *"Recorded: you are pursuing this
option. **Nothing has happened outside Loop.**"*

### Button language to avoid

| Avoid | Because | Prefer |
|---|---|---|
| "Send", "Notify", "Contact" | implies Loop reached somebody | "Record", "Ask", "Pursue" |
| "Execute", "Apply", "Do it" | implies Loop performed it | "Pursue this" |
| "Approve" *(on an option)* | approval is a distinct governed act | "Pursue this" |
| "Assign" *(on participation)* | that is Work OS's word | "Ask" |
| "Escalate to…" | there is nobody to escalate to | "Eligible for escalation" |
| "Fix", "Resolve it" *(on work)* | Loop does not act on work | — |

Even a well-chosen icon can imply an outbound action. Please treat send/paper-
plane/phone iconography as off-limits on these controls.

---

## 19. Accessibility and responsive properties to preserve

These are already enforced, and should survive a visual refresh:

- **Semantic controls.** Every action is a real `<button>` in a real form; every
  navigation is a real link. No clickable divs anywhere.
- **Every state carries a word**, not only a colour, and glyphs differ in shape.
- **Real landmarks and headings.** Each Headline is an article labelled by its own
  claim; each Case section is a labelled section; heading levels never skip.
- **Labelled inputs.** Every select and text field is labelled; grouped choices
  use fieldset and legend.
- **Visible focus** on every interactive element.
- **Announcements.** Success messages announce as status, errors as alerts.
- **Unavailable states are explained in text.** A read-only person is told they
  need authoring permission — not shown a silent gap.
- **Mobile reflows and hides nothing.** No Stage 4 breakpoint uses
  `display: none`. At ~380px the claim, the evidence posture, what Loop does not
  know, and the primary action are all present.

**The one that is easiest to lose in a redesign:** at 380px a person must still
be able to tell what Loop believes, what it does not know, what decision is being
asked of them, and what a button will do.

---

## 20. Known deferred capabilities

Re-verified against `main`. Please do not design around these as if solved.

| Capability | What you can show now | What is not possible | Why |
|---|---|---|---|
| **Escalate to a person** | "Eligible for escalation", plus the sentence saying Loop cannot determine to whom | naming a manager or notifying them | There is no Team, Division or reporting relationship in the platform. A role is a permission level, not a manager. |
| **Promote a pattern to organisational knowledge** | patterns as *observation* or *emerging pattern*, with everything they cannot conclude | making anything durable doctrine | Durable knowledge is recorded *about* a subject, and an operating pattern is about a way of working. There is nothing to name as its subject. |
| **Live monitoring verdicts** | the plan, the window, and **Inconclusive** | a real held/did-not-hold from live data | The measurement seam is not wired to a producer. It returns inconclusive by default, honestly. |
| **Recomputed tradeoffs after a revision** | what moved — steps added, removed, reordered | what the new tradeoff *is* | Asserting the new tradeoff from a diff would be manufacturing the reasoning. |
| **"What did they actually do"** | what was selected, and that work exists | the sequence actually carried out | Loop knows what was chosen and that work was created. It does not know what anybody did. |
| **Patterns on a live Case** | patterns in the review harness | patterns on a production investigation | No production surface reads them yet. |
| **"Since you were last here"** | "Here's what Loop can establish right now" | a since-you-were-away frame | Loop records no last-view time. |
| **Ownership relevance** | the objective it was measured against | "this is your account / your buyer" | No governed responsibility fact beyond a user-scoped objective. |

---

## 21. Locked product semantics

The short list, for pinning above a desk:

1. Rendering intelligence creates nothing. **Investigate** is the only door.
2. **All clear** requires measurement coverage. An empty list is not health.
3. **Unknown is not healthy.** Not measured never reads as on track.
4. **Inconclusive is not success**, and it is the default today.
5. **Error is not empty.**
6. **Established ≠ Accepted.** Establishment can weaken by itself.
7. A Finding's words are **never editable**.
8. **Loop's recommendation survives** every human revision, visibly.
9. **Participation is not work assignment.**
10. **Two ways to close**, because the false-positive rate depends on it.
11. **Reopening preserves the resolution.**
12. **No confidence percentage. No priority score.**
13. **Nothing happens outside Loop.**

---

## 22. Review checklist

Work through this against the review harness and the live surfaces.

**Morning**
- [ ] Within seconds, can I tell whether anything needs me?
- [ ] Can I distinguish *everything is fine* from *Loop doesn't know*?
- [ ] When Loop can't tell, can I see which objectives and why?
- [ ] Does an all-clear tell me what was checked?
- [ ] Does a failed read look unmistakably different from a quiet morning?

**Headline**
- [ ] Can I tell why this matters to me?
- [ ] Can I see how much of the window was measured?
- [ ] Can I see what the measurement does not establish, without navigating away?
- [ ] Is it obvious that Investigate is a decision, not a view?

**Case**
- [ ] Can I tell what Loop claims and whether the evidence establishes it?
- [ ] Can I tell *Developing* from *Established*, and *Established* from *Accepted*?
- [ ] When Why is empty, does that read as a fact rather than a bug?
- [ ] Can I compare several recommended moves and see the tradeoffs?
- [ ] Can I tell which sequence is Loop's and which is a person's?
- [ ] Can I see who is involved and what each was asked for?
- [ ] Is participation visually distinct from work?
- [ ] Can I tell whether work is on track, waiting, blocked, or **not measured**?
- [ ] Can I understand what Loop is monitoring and what would count?
- [ ] When monitoring is inconclusive, is that unmistakable?
- [ ] Can I understand why a Case was closed, and which kind of close it was?
- [ ] Does a reopened Case visibly retain its earlier resolution?

**Before pressing anything**
- [ ] Do I know what will happen?
- [ ] Do I know whether it changes Loop or the outside world?
- [ ] Where a reason is required, is it obvious why?

**Craft**
- [ ] Does every state carry a word as well as a colour?
- [ ] Can I do everything important with a keyboard?
- [ ] At 380px, can I still tell what Loop believes and what it doesn't know?
- [ ] Is anything on screen more reassuring than the evidence supports?

---

## 23. Open product questions

Genuine decisions `main` leaves open.

**1. "Inconclusive" currently reads as "Conflicting evidence" on a monitoring
verdict.** The word `INCONCLUSIVE` belongs to two vocabularies — measurement
readiness (where it means *the evidence disagrees with itself*) and monitoring
(where it means *there was not enough to judge*). The shared translator resolves
to the readiness meaning, so an unjudged monitoring window currently says
"Conflicting evidence" rather than "Couldn't tell".

*The safety property holds* — it does not read as success. But it is imprecise,
and monitoring inconclusiveness is the state you will see most often. **Do you
want these given distinct wording?** It is a small change to the dictionary, not
to any behaviour.

**2. How prominent should "what Loop doesn't know" be?** It currently renders as
a bordered block above the Case and inside each Headline card. It is the section
that makes everything else trustworthy, and also the one most likely to be
shrunk in a visual pass. **How much weight do you want it to carry by default?**

**3. Should the personal queue or Headlines be the landing surface?** Both exist
and answer different questions — *what is mine* versus *what changed*. Today
neither is the post-login destination.

**4. How should a Case with no Finding read?** It says *"Loop is still developing
a finding on this investigation."* That is honest and slightly bleak, and it is
the state every new Case is in for a while.

**5. Should dismissing a Headline ask for more than the two reasons?** Today it
is *"Loop got this wrong"* or *"Correct, but not worth surfacing"* — the only
signal Loop gets about whether it earns attention. **Is two enough?**

**6. Thirteen outcomes on closing may be too many to choose from at speed.**
Each has a sentence, and two are marked as counting against Loop. **Would a
shorter primary set with the rest behind "more" serve the person better** —
without losing the vocabulary, which is a contract?

---

*Prepared from `main` at `bc70d83`. Every capability, state and constraint above
was verified in source. Where something is not supported, this document says so
rather than describing an intention.*
