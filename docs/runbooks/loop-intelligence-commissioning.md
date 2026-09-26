# Loop Intelligence: commissioning runbook

**Audience:** Matt, or whoever dispatches the workflows. This covers the complete Loop Intelligence build
(Phases A–G, one draft PR). **Merging it commissions nothing.** Every step below is a deliberate human
action, and each can be undone the same way it was done.

Do each section on **staging first**. Then repeat it on production once staging has been read back.

The sections are ordered, and each one depends on the one before:

- **A** gets the code and schema live.
- **B** switches features on.
- **C** commissions OpenAI, which is optional.
- **D** is the Mail governance gate.

Architecture: [`docs/architecture/loop-intelligence.md`](../architecture/loop-intelligence.md).

---

## A. Code and migrations

The web app and the worker both run safely before the migrations are applied. Without them:

- every new table reads as absent;
- nothing new is written;
- existing Case reads behave exactly as before, because the private-situation filter works by value.

### A1. Merge (Matt)

Merging deploys the web tier. Nothing new becomes visible until data exists:

- The domain reading panels say "Loop has not written a reading of this yet."
- The Situations panel renders nothing.
- Home keeps its own briefing narrative.
- **Promote to Work** stays refused (`NOT_MIGRATED`) until A2.

### A2. Deploy the migrations, in this order

Use the `Deploy Prisma Migrations` workflow, on staging, then on production. The migrations are:

| # | Migration | What it does | Guarantee |
|---|---|---|---|
| 1 | `20261006000000_intelligence_org_digests` | ORGANIZATION digests (per-scope partial uniqueness) and `entityRefs` | **Drops and replaces** one unique index and three CHECKs; backward-compatible, no row rewritten |
| 2 | `20261006000001_entity_links` | Explicit entity links (never MODEL) | Additive only (one new table) |
| 3 | `20261006000002_intelligence_refresh_queue` | The durable refresh queue | Additive only (one new table) |
| 4 | `20261007000000_promote_to_work` | `work_origins` (many links per origin, one per confirmed submission), and `WORK_LINKED` on Case and work-item logs | **Drops and replaces** the `work_item_observations` CHECK (same list plus one value); backward-compatible, no row rewritten |
| 5 | `20261008000000_case_private_scopes` | `case_private_scopes` and `situation_candidates` | Additive only (two new tables) |

None of them rewrites a row, and every existing row satisfies every replacement constraint. The code runs
safely before each one is applied; this is tested against a database at `d70f737`.

**Read back:** `read-intelligence-state`, or the Intelligence status page. The fabric section should say the
queue is migrated.

### A3. Redeploy the connections worker

Run `connections-infra-deploy` with action `diff` first, then `deploy`. Keep the variables unchanged.

⚠️ **This moves production Telegram triage to Chats v5.** That means task 4.0.0 and the portable schema v5,
with the same provider, lane, budget class and output ceiling. Watch staging's first sweeps before you
redeploy production:

- `ai_invocations`: `taskVersion 4.0.0`, no `REJECTED_OUTPUT` spike.
- Chats: grouped by what needs whom.

Chats v5 does not re-run hydration or backfill on its own.

---

## B. Feature activation (each one independent)

The worker's settings are GitHub environment variables. They are read by `connections-infra-deploy`
(`CONNECTIONS_<STAGE>_…`), and a change takes effect on the next deploy of that workflow. **Unset means
off.** To switch a feature off, clear its variable and redeploy.

A model step also needs all of these:

- its task in `CONNECTIONS_<STAGE>_AI_TASKS`;
- the organization in `CONNECTIONS_<STAGE>_AI_ORG_ID`;
- a recorded provider policy whose class covers the task. Check with `read-ai-provider-policy`:
  - OPERATIONAL for organization readings and organization situations;
  - COMMUNICATION_CONTENT for personal readings, private situations and the Briefing.

Everything runs inside the recorded operating budget (`operating.initial.1`: $20/day, SYNTHESIS lane $6,
BACKGROUND $2 / 60 calls). The class ceilings (routing `.12`, budget `.6`) only bound one task's day
inside it.

A kill needs no deploy: `record-ai-provider-policy` KILLED, or a stored KILLED control, takes effect
within a minute.

### B1. Domain readings, rule only (no AI, no spend)

Set `CONNECTIONS_<STAGE>_INTELLIGENCE_PRODUCERS` to any of:

```
calendar.domain@1, callgrid.domain@1, campaigns.domain@1, pipeline.domain@1, crm.domain@1,
creators.domain@1, work.domain@1, work.mine@1, website.domain@1
```

The worker then runs a pass every 15 minutes: discover, enqueue, and read. A target is skipped when its
fingerprint is unchanged. Each pass writes a RULE digest: MEASURED figures and OBSERVED facts.

**Read back:** each domain page's reading panel, the Home tiles, and the `intelligence_pass` log line
(counts only).

The Mail producers (`mail.thread@1`, `mail.domain@1`) are **not** hosted by the worker. Naming them there
is reported as unknown. See D.

### B2. Domain readings with the model

1. Add the domain's reading task to `CONNECTIONS_<STAGE>_AI_TASKS`, for example `callgrid.domain.reading`.
   The full list:

   ```
   calendar.domain.reading, callgrid.domain.reading, campaigns.domain.reading,
   pipeline.domain.reading, crm.domain.reading, creators.domain.reading,
   work.domain.reading, website.domain.reading
   ```

2. For **organization** domains, name the acting operator by setting
   `CONNECTIONS_<STAGE>_INTELLIGENCE_ACTING_USERS=<orgId>=<userId>`.

   The runtime has no service account, so an organization reading runs as a named person. That person is
   re-checked on every read: they must be an ACTIVE member with the role OWNER, ADMIN or MANAGER, and must
   hold the domain's permission. If nobody is named, the reading stays rule-only and honest.

3. Redeploy.

**Read back:** the digest's provenance says `RULE_AND_MODEL`, its signals carry an `m.` prefix, and
`ai_invocations` rows appear in the BACKGROUND lane.

### B3. Situations

1. Set `CONNECTIONS_<STAGE>_INTELLIGENCE_SITUATIONS=organization` (and/or `private`).
2. Add `situation.synthesis` and/or `situation.synthesis.private` to AI_TASKS.

Clustering is deterministic, so without the synthesis task nothing is asked and nothing is written.

Independent verification (`situation.verify`, `situation.verify.private`) is routed OTHER_THAN_SUBJECT.
**While only Anthropic is commissioned, a Claude-written situation records verification `UNAVAILABLE`**,
and that is honest. Listing the verify tasks before OpenAI exists changes nothing.

**Read back:**

- Home and Headlines show a "Situations" panel.
- The Case page shows "What Loop connected".
- `situation_candidates` rows hold the decided fingerprints.

### B4. The Loop Briefing

Set `CONNECTIONS_<STAGE>_INTELLIGENCE_BRIEFINGS=on`. Home's "Your briefing" then shows Loop's
deterministic Briefing.

To have the model compose it instead, add `loop.briefing.compose` to AI_TASKS. The model's version then
replaces the rule version on the next pass, and is reused while its inputs are unchanged.

**Read back:** `work_briefs` gets a new version with a `headline` and `coverage.composer`, and Home says
who composed it.

What a Briefing may use: only readings that are legitimately current (see "What synthesis may use" below).
A reading that is stale, disconnected, in error or insufficient is not stated; it is listed as not current.
A partial reading is labelled partial. "Nothing pressing" is written only when every reading used was
read in full and nothing was left out, whoever composes the Briefing.

**Retention:** a Loop Briefing is kept **90 days** from its local date (the approved decision; the
`BRIEFS` category, work-retention `.3`, not overridable). The worker's retention sweep deletes older ones.

### What synthesis may use (situations and the Briefing)

A stored reading contributes only when it is current at that moment:

- its status is CURRENT;
- its target has no unresolved refresh work (queued, claimed, retrying or HELD in the refresh queue);
- its source is live (a connected source is read from the connection);
- the source holds no evidence newer than what the reading read, and the reading is not about to expire;
- its coverage is SUFFICIENT or PARTIAL.

A PARTIAL reading carries its limitation into the model's context and into what is stored. STALE,
DISCONNECTED, ERROR and INSUFFICIENT readings contribute nothing.

For Loop's own records (every organization reading), the refresh is the freshness signal:

- A refresh that ends with NO_EVIDENCE or HELD marks the prior reading STALE.
- An unchanged successful refresh re-affirms it without a read.
- A changed one replaces it.

**The Briefing's expected coverage.** Every domain Loop is supposed to observe for the person must be
present and current before "nothing pressing" can appear. That set is:

- their connected Telegram and Google sources;
- the domains this deployment's active producers observe;
- limited to the organization domains the person may read.

A missing reading is a gap ("no current reading of …", or "… is not connected"), never quiet.

### B5. Always live once merged and migrated (no switch)

- **Chats v5 groups, handled / snooze / dismiss.** These follow the triage task already running.
- **Promote to Work.** A person's confirmed action. No AI.
  - A Case may be promoted to several pieces of work. A retried submission returns the same work.
  - A person's own private situation is promoted from Home's Situations panel, by them alone. Only what
    they confirm is shared.

---

## C. OpenAI (optional; NOT commissioned today)

OpenAI adds two things: availability fallback on every route, and the independent verifier for situations.
**No task ever calls both models for one answer.**

1. Record the data-terms decision (Matt).
2. Dispatch `record-ai-provider-policy` with provider `openai`, the sensitivity class, and ACTIVE.
3. Add `openai_api_key` to the Secrets Manager secret `loop/connections/<stage>/ai`. Do not paste it
   anywhere else.
4. Set `CONNECTIONS_<STAGE>_AI_PROVIDERS=anthropic,openai`, then redeploy the worker.
5. Web, if its tasks should fall back too: set the Netlify `OPENAI_API_KEY` and add `openai` to
   `LOOP_AI_PROVIDERS`.

**Read back:** situations record `VERIFIED`, `PARTIAL` or `DISPUTED` instead of `UNAVAILABLE`, and
`verification.providerId` is `openai`.

---

## D. Mail governance (gate: the counterparty-consent decision, UNRESOLVED)

Mail content intelligence is built completely and **held closed** by one recorded decision: may Loop read
the words of people who emailed an employee, who never consented to Loop? Until that decision exists,
nobody is discovered and every gather refuses.

1. **Decide and record it** (Matt, with counsel). Set the Netlify variable
   `LOOP_MAIL_CONTENT_GOVERNANCE_DECISION=counterparty-consent:YYYY-MM-DD:<reference>`.

   Anything else, including unset, is UNDECIDED. The code's status constant stays
   `MAIL_CONTENT_GOVERNANCE_STATUS = 'UNRESOLVED'` until a PR records the decision in
   `mail-content-governance.ts`.

2. **Set the web tier's Netlify variables:**
   - `LOOP_INTELLIGENCE_MAIL_PRODUCERS=mail.thread@1,mail.domain@1`
   - `INTELLIGENCE_MAIL_SECRET` (generate it; never echo it)
   - `mail.content.triage` and `mail.domain.reading` added to `LOOP_AI_TASKS`

3. **Set the GitHub side:**
   - secrets `INTELLIGENCE_MAIL_URL` (`https://<host>/api/internal/intelligence/mail`) and
     `INTELLIGENCE_MAIL_SECRET` (the same value);
   - repository variable `INTELLIGENCE_MAIL_ENABLED=true`, which turns on `run-mail-intelligence.yml`
     (hourly).

4. **Each person opts in** on `/app/mail` ("Turn on mail reading"). This is their own MAIL content
   authorization, re-checked when the thread is gathered and again when the digest is written. "Stop mail
   reading" revokes it and withdraws their Mail digests.

**What is stored:** a minimized reading per thread and a Mail domain reading, private to the person, for
30 days. **Never a message body.** Bodies are read through the person's own Gmail connection for one call,
then dropped.

**Read back:**

- the workflow summary (counts only);
- the person's `/app/mail` "Mail intelligence" panel.

**To switch off:** set `INTELLIGENCE_MAIL_ENABLED` to anything else. Clearing
`LOOP_INTELLIGENCE_MAIL_PRODUCERS` or the decision also closes the route.
