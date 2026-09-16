# Loop Meeting Intelligence — architecture record

**Status:** PROPOSED (2026-09-16). **Nothing here is implemented.** No bot exists, no meeting is joined,
no transcript is read. This record separates what Loop should build from what Google currently permits,
because conflating the two is how meeting products ship features that depend on an API that does not
exist.

**The shape of the decision.** Almost every meeting product starts by putting a bot in the call. That is
the most invasive possible starting point, it needs consent Loop has not asked for, and it is unnecessary
for most of the value. **V1 uses artifacts the meeting already produced.** V2 — a participating agent —
is a separate product decision with its own consent model, and is not authorized.

---

## Part 1 — Loop product architecture

### 1. V1: meetings become facts, without joining anything

```
Google Calendar event (connected, read-only)
  → the event names a Meet conference
  → artifacts the meeting already produced (recording, transcript) where they exist and the viewer may read them
  → Universal Activity items: "a meeting occurred", referencing the source
  → authorized context assembly (the invoking user's own grants)
  → a Meeting Brief: what was discussed, what was decided, what somebody committed to
  → proposals, which remain proposals
```

Every step composes authorities Loop already has. No new event store, no new identity source, no bot.

### 2. What a meeting is, as a fact

An Activity item of category `COMMUNICATION`, authority `calendar:<eventId>`:

- `occurredAt` = the event's actual start, basis `PROVIDER_REPORTED`
- subjects: the calendar event; **`WORK_ITEM` / `CASE` / `RELATIONSHIP` only when a person linked it**
- participants: **attendee count and internal/external composition, not addresses.** An attendee list is
  `CONTACT_IDENTIFIER` and does not belong in a projection
- `identity.state`: **`NOT_APPLICABLE`** until governed attribution exists. An attendee's email address
  matching a Party's is *exactly* the identity matching Loop forbids
- provenance limitations: "transcript covers 41 of 60 minutes", "one participant joined by phone and is
  unidentified", "no transcript was produced"

### 3. Transcript authority — and its limits

**The transcript is a source's account of what was said. It is not the meeting, and it is not truth.**

- Authority stays with Google. Loop references it; it does not become Loop's record of the meeting.
- Speaker labels are the **provider's** attribution. A transcript saying "Dana said X" is evidence that
  the provider labelled a voice that way — never a governed attribution to a Party. Same rule as caller
  ID: the platform records what the source asserted, and asserts nothing itself.
- Gaps are stated: late joins, partial coverage, dial-in participants, non-recorded segments.
- A meeting with no artifact is still an Activity item — **it happened**. An empty brief is honest; an
  invented one is not.

### 4. What AI may infer, and what stays unresolved

| AI may | AI may not |
|---|---|
| Summarise what the transcript contains, citing it | Assert anything the transcript does not support |
| Identify **candidate** commitments ("someone said they would send pricing by Friday") | Create a task, a Work item or a Decision |
| Note that a commercial relationship was discussed | Create, end or modify a **Relationship** |
| Note that a name was spoken | Attribute a speaker to a **Party**, or create one |
| Report that no transcript exists | Fill the gap with plausible narrative |

**Every detected commitment is a proposal carrying its evidence**, and stays one until a person accepts
it through the governed path — which is the Decision Engine and Work OS, both of which already exist and
already require human approval for consequential acts. Meeting Intelligence adds no new way to act.

### 5. Consent and control

- **Loop never joins a meeting by default.** V1 joins nothing at all.
- Per-user opt-in to Calendar; per-meeting exclusion; a private-meeting marker Loop always honours.
- **Internal vs external:** an external meeting includes people who never agreed to Loop's terms.
  Default: process artifacts from **internal** meetings only; external needs explicit per-organization
  opt-in and its own notice obligation.
- Recording authority is the meeting host's and the jurisdiction's, never Loop's. Loop reads a recording
  that already exists under the host's consent; it never causes one.
- Retention: references permanently (a meeting happened); derived briefs for a bounded, configured
  period; **content never copied**, so there is no transcript retention question for Loop to answer.

### 6. V2 — a participating agent (NOT AUTHORIZED)

Recorded so its requirements are written before anyone is tempted.

- Explicitly invited per meeting; **never auto-joins**; never attends a meeting nobody asked it to.
- Announces itself on joining, visibly, to every participant including late joiners.
- An organization-level and a per-user kill switch, both honoured mid-meeting.
- External-participant notice satisfied before capture starts, not after.
- Everything in §4 still applies: real-time capture changes latency, not authority.

**V2 needs its own Product decision, its own legal review, and its own consent design. It is not part of
V1 and must not arrive as an increment of it.**

---

## Part 2 — Google API feasibility (separate, deliberately)

Kept apart from the architecture above so a limitation on Google's side never silently becomes a Loop
design decision.

| Capability | Status to verify before building | If unavailable |
|---|---|---|
| Calendar events + conference data | `calendar.events.readonly` — well established | Nothing works; V1 is blocked |
| Meet recordings / transcripts via API | **Verify**: availability depends on Workspace edition, admin policy and whether recording was enabled | V1 degrades to "the meeting happened", which is still useful |
| Transcript speaker labels | **Verify** granularity and reliability | Summarise without speaker attribution |
| Meet REST participants | **Verify** edition and scope requirements | Use calendar attendees, counted not listed |
| A bot joining a Meet | **No first-party API.** Third-party infrastructure or media plumbing | V2 stops here until Google offers one, or the tradeoff is accepted explicitly |

**This table is the one part of this record that must be re-verified against current Google
documentation before any implementation begins.** It is a snapshot of what to check, not a claim about
what is true today.

---

## Part 3 — Slices, when authorized

| Slice | Contents | Depends on |
|---|---|---|
| **M0** | Calendar connection (Google Workspace record §4, §6) | Google architecture approved |
| **M1** | Meetings as Activity: the calendar adapter, `NOT_APPLICABLE` identity, honest limitations | M0, and the Activity adapter pattern (shipped in A2) |
| **M2** | Artifact reference: transcript/recording exist, opened at the source under the viewer's grant | M1 + feasibility verified |
| **M3** | Meeting Brief as an **AI task** — read-only, cites the transcript, no writes | M2 + AI S1 live + a task whose sensitivity ceiling admits `COMMUNICATION_CONTENT` (a Product decision that does not exist yet) |
| **M4** | Commitments as **proposals** through the existing Decision/Work approval path | M3 |
| **V2** | Participating agent | Separate Product decision. Not planned |

**Nothing before M3 involves a model at all.** M1 and M2 are pure composition of facts Loop already has
the right to see — and they are where most of the value is.
