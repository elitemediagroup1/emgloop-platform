# CallGrid Missing-Capability Blueprint

**Status:** Engineering blueprint. **No implementation.** This is the design Loop builds *immediately, without redesigning the architecture,* the moment CallGrid access to each capability is confirmed.
**Companion:** `docs/CALLGRID_INTELLIGENCE_FOUNDATION.md` (the discovery + gap analysis this builds on).
**Ground rule:** every "endpoint" below is either (a) **evidenced in the repo** (cited), (b) **documented in Loop's own integration doc** (`docs/integrations/CALLGRID.md`, cited), or (c) explicitly marked **ASSUMED SHAPE — must be confirmed with CallGrid** and never treated as real until then. Nothing here is wired; building it is gated on confirmation.

---

## Part 1 — Repository deep audit (what references more than the code ingests)

A full sweep (`grep` across `packages/**`, `apps/**`, `docs/**`, config) for hidden configuration, commented code, env vars, disabled adapters, unfinished services, or abandoned integrations referencing CallGrid capabilities beyond `/api/call`. Findings:

| Finding | Location | Verdict |
| --- | --- | --- |
| **Webhook payload documents `recording_url` + `transcript`** | `docs/integrations/CALLGRID.md:41-42` (example body), `:114-115` (intended handling: recording URL → reference only; transcript → `Interaction.summary`) | **Real, known shape, NOT ingested.** The adapter (`callgrid.provider.ts`) maps neither. Blueprint §Recordings/§Transcripts uses this exact shape. |
| **Recording-download capability + rate limit** | `docs/integrations/CALLGRID.md:66-68` ("Recording downloads: 50/min") | **Documented capability, not built.** Implies a recording fetch endpoint exists; shape unconfirmed. |
| **Older polling shape `GET /v1/calls`** | `docs/integrations/CALLGRID.md:56` | **Superseded.** The built client uses `GET /api/call` (`callgrid-api.ts:32`). Note the discrepancy when confirming the real polling contract. |
| **`bidStats`/`stats`/`rejections` report endpoints** | `marketplace-intelligence/callgrid-input.ts:10-12`, `callgrid-assembler.ts:5` | **Contract stubs only.** No client, no fetch, no route. Blueprint §Bid/§Auction uses these types as the target shape, unconfirmed. |
| **`pollingSupported: true`, `idempotency: true`, `retrySupported: true`** | `integration-catalog.ts:100-102` | Declares polling/idempotency/retry are *supported*, but **no scheduler is wired** — polling is manual (`/api/integrations/callgrid/sync`). |
| **`SOMETHING_NEW_CALLGRID_ADDED`** | `callgrid-webhook-verification.ts:98,163` | **Test fixture** for forward-compatible unknown-status handling. Not a capability. |
| **`rate_limiter: 'planned'`** | `brain/integration-hub.ts:22,42` | Generic Brain subsystem status, **not CallGrid-specific**. |
| **`.env.example` has NO CallGrid vars** | `.env.example` | **Config gap.** `CALLGRID_API_KEY`/`CALLGRID_WEBHOOK_SECRET`/`CALLGRID_API_BASE_URL` are read in code but not templated. Add them (documentation-only) when wiring polling. |
| Disabled adapters / abandoned services | — | **None found.** No commented-out CallGrid capability code anywhere. |

**Conclusion:** the only capabilities the repo references beyond `/api/call` are **recordings, transcripts** (known payload shape, in Loop's integration doc) and the **bid/report contract stubs** (shape defined, endpoints unconfirmed). Everything else in this blueprint (auctions, caps, refunds, chargebacks, queue/routing events) has **no shape anywhere in the repo** and is fully ASSUMED, pending CallGrid confirmation.

---

## Part 2 — Missing-capability specifications

Each capability answers the 7 required questions, then gives the 7 build artifacts (Business Purpose · Required Fields · Suggested Schema · Suggested Repository · Suggested Ingestion · Suggested Scheduler/Webhook · Suggested Intelligence Outputs). All schemas are **sensor-neutral** (a `sensor`/`provider` column; CallGrid is one populator), **cents for money**, **null for unknown**, **org-scoped**, and carry **`sourceOccurredAt` + `createdAt` + `updatedAt`** and a **`(provider, externalId)` unique** — consistent with the `MarketplaceCall` foundation.

Shape-confidence legend: **[REPO]** shape evidenced in repo · **[DOC]** shape in Loop's integration doc · **[ASSUMED]** must be confirmed with CallGrid.

---

### 2.1 Auction lifecycle **[ASSUMED]**

1. **Missing capability:** the auction/ping event for each call — the moment CallGrid solicits bids and picks a winner.
2. **Why Brain needs it:** revenue is the *output* of auctions; without the auction, Brain sees results but never *why* — how much competition, how many bids, why this buyer won at this price. It is the root of the entire optimization lifecycle.
3. **Required fields:** `auctionExternalId`, `callExternalId?` (link to the resulting call, if it converts), `sensor`, `occurredAt`, `campaignExternalId?`, `sourceExternalId?`, `geoState?`, `geoZip?`, `vertical?`, `bidCount`, `acceptedCount`, `rejectedCount`, `rateLimitedCount`, `winningBidCents?`, `winnerBuyerExternalId?`, `floorPriceCents?`, `secondPriceCents?`.
4. **Ideal source:** a CallGrid **`auction`/`ping` webhook event** (real-time) OR an `/api/reports/bidStats`-style report keyed by call/auction. Neither is confirmed.
5. **Expected payload [ASSUMED]:** `{ id, callId?, campaignId, sourceId, state, zip, bids:[{buyerId, amount, status:'won'|'lost'|'rejected'|'rate_limited', reason?}], winnerId, winningAmount, floor }`.
6. **Persistence:** `MarketplaceAuction` (header) + `MarketplaceBid` (children, §2.2). Money in cents; counts non-null; `(provider, externalId)` unique; FK-by-externalId to `MarketplaceCall`.
7. **Intelligence unlocked:** competition-depth analysis, win-price vs floor, "unwinnable auction" detection, per-source auction yield, bid-shading opportunities.

- **Suggested schema:** `model MarketplaceAuction { id, organizationId, sensor, externalId, sourceOccurredAt, callExternalId?, campaignExternalId?, sourceExternalId?, geoState?, geoZip?, vertical?, bidCount Int, acceptedCount Int, rejectedCount Int, rateLimitedCount Int, winningBidCents Int?, winnerBuyerExternalId?, floorPriceCents Int?, createdAt, updatedAt, @@unique([sensor, externalId]), @@index([organizationId, sourceOccurredAt]) }`
- **Suggested repository:** `MarketplaceAuctionRepository.aggregateWindow(orgId, since, until)` → `{ auctions, avgBidsPerAuction, winRate, avgWinningBidCents, floorGapCents, byCampaign[], bySource[] }`.
- **Suggested ingestion:** webhook handler mapping the auction event → `MarketplaceAuction` + N `MarketplaceBid`, idempotent on `(sensor, externalId)`.
- **Suggested scheduler/webhook:** prefer webhook; fallback poller over a `/reports/auctions` range if only report access exists.
- **Suggested intelligence outputs:** "auctions with ≥N bids you lost → raise bid", "you win 90%+ at floor → lower bid", "campaign X draws no competition → expand".

### 2.2 Bid lifecycle · Bid requests · Bid responses **[ASSUMED / partial REPO shape]**

1. **Missing:** each individual buyer bid within an auction (request → response → outcome).
2. **Why Brain needs it:** per-buyer bidding behavior is the unit of negotiation and routing decisions — who bids, how much, how often they win/lose, whether they're capped.
3. **Required fields:** `bidExternalId`, `auctionExternalId`, `buyerExternalId`, `amountCents`, `status` (`won`|`lost`|`rejected`|`rate_limited`|`no_bid`), `rejectReason?`, `respondedAt?`, `latencyMs?`.
4. **Ideal source:** child records on the auction webhook (§2.1), or `/api/reports/bidStats` per-source rows (`CallGridBidStatsRow`, `callgrid-input.ts:33-62` **[REPO]** shape: `bids, won, total, rated, rejected, totalBidAmount, totalWonAmount, avgBid, avgWinningBid, winRate, bidRate, rejectRate`).
5. **Expected payload [ASSUMED]:** the `bids[]` array in §2.1.
6. **Persistence:** `MarketplaceBid { id, organizationId, sensor, externalId, auctionExternalId, buyerExternalId, amountCents Int?, status, rejectReason?, latencyMs Int?, sourceOccurredAt, createdAt, updatedAt, @@unique([sensor, externalId]), @@index([organizationId, buyerExternalId, sourceOccurredAt]) }`.
7. **Intelligence unlocked:** per-buyer win rate & average bid, bid-vs-win price gaps, buyer responsiveness (latency), "buyer stopped bidding" alerts.

- **Repository:** `aggregateBuyerBids(orgId, since, until)` → per-buyer `{ bids, wins, winRate, avgBidCents, avgWinCents, rejects }`.
- **Ingestion / scheduler:** as §2.1 (shared webhook) or a `bidStats` report poller.
- **Intelligence outputs:** bid up/down per buyer (the module already accepts `bids` and lights up), negotiation targets, unresponsive-buyer risk.

### 2.3 Bid statistics **[REPO shape]**

1. **Missing:** windowed per-source bid rollups (the `bidStats` report). 2. **Why:** source-level auction economics — which traffic wins, which gets rejected. 3. **Fields [REPO]:** exactly `CallGridBidStatsRow` (`callgrid-input.ts:33-62`). 4. **Ideal source:** `GET /api/reports/bidStats` **[unconfirmed]**. 5. **Payload:** `CallGridBidStatsRow[]`. 6. **Persistence:** `MarketplaceBidStat` (per source × window) OR derive live from `MarketplaceBid`. 7. **Intelligence:** source win/bid/reject rates, source-quality scoring, the existing `@emgloop/marketplace-intelligence` assembler + enrichment become populatable end-to-end.

### 2.4 Winning bids / Losing bids / Rejections / Rate limiting **[ASSUMED / REPO shape for rejections]**

1. **Missing:** the outcome distribution of bids. 2. **Why:** distinguishes "we're not bidding enough" (losing) from "buyer/tag rules block us" (rejected) from "buyer maxed out" (rate-limited) — each has a *different* fix. 3. **Fields:** carried on `MarketplaceBid.status` + `rejectReason` (§2.2); reject reasons **[REPO]** `CallGridRejectionRow` (`callgrid-input.ts:70-91`: `callerId, closed, paused, duplicate, duplicateBids, failedAcceptance, failedTagRules`). 4. **Ideal source:** auction webhook, or `/api/reports/bidStats/rejections` **[unconfirmed]**. 5. **Payload:** `CallGridRejectionRow[]`. 6. **Persistence:** `MarketplaceBid.status`/`rejectReason` enum + a `MarketplaceRejectionRollup` for reason breakdown. 7. **Intelligence:** "raise bid" (losing) vs "fix tag rules" (rejected) vs "buyer at cap" (rate-limited) — precisely separated; rate-limited → §2.5 cap signal.

### 2.5 Buyer caps / Vendor caps **[ASSUMED]**

1. **Missing:** each buyer's/vendor's volume or spend ceiling and current consumption. 2. **Why:** a capped buyer can't take more volume no matter the bid — Brain must stop recommending "send more" and instead recommend "raise the cap / add a buyer". Directly powers "buyer reaches cap" prediction. 3. **Fields:** `participantExternalId`, `role` (`buyer`|`vendor`), `capType` (`daily_calls`|`daily_spend`|`concurrency`), `capValue`, `consumedValue`, `resetAt`, `periodStart`. 4. **Ideal source:** a CallGrid **caps/limits endpoint** or a field on the auction/bid event (rate-limited implies a cap). None confirmed. 5. **Payload [ASSUMED]:** `{ buyerId, capType, cap, consumed, resetsAt }`. 6. **Persistence:** `MarketplaceCap { id, organizationId, sensor, participantExternalId, role, capType, capValue Int?, consumedValue Int?, resetAt, sourceOccurredAt, createdAt, updatedAt, @@unique([sensor, participantExternalId, capType]) }`. 7. **Intelligence:** cap-utilization %, "buyer reaches cap in ~N days" forecast (removes the current honest "buyer caps unavailable" gap), "add a buyer for capped demand".

### 2.6 Refunds / Chargebacks **[ASSUMED]**

1. **Missing:** reversals of previously-recognized revenue. 2. **Why:** revenue/margin are overstated without them; a buyer with rising chargebacks is a hidden quality/credit risk. 3. **Fields:** `reversalExternalId`, `callExternalId?`, `buyerExternalId?`, `type` (`refund`|`chargeback`), `amountCents`, `reason?`, `occurredAt`. 4. **Ideal source:** a CallGrid **billing/financial webhook or report** (`payment.refunded` exists as a *generic* Loop event type, `shared/index.ts:139`, but no CallGrid financial feed). 5. **Payload [ASSUMED]:** `{ id, callId?, buyerId, type, amount, reason, at }`. 6. **Persistence:** `MarketplaceRevenueReversal { id, organizationId, sensor, externalId, callExternalId?, buyerExternalId?, type, amountCents Int, reason?, sourceOccurredAt, createdAt, updatedAt, @@unique([sensor, externalId]) }`. 7. **Intelligence:** net-of-reversal revenue & margin (true profitability), chargeback-rate risk per buyer, "buyer credit deterioration" alerts.

### 2.7 Call recordings · Recording metadata **[DOC shape]**

1. **Missing:** the recording reference + metadata for each call. 2. **Why:** recordings are the substrate for transcript intelligence and QA; metadata (duration, availability) tells Brain what's analyzable. 3. **Fields [DOC]:** `callExternalId`, `recordingUrl` (`recording_url`, `CALLGRID.md:41`), `recordingDurationSeconds?`, `available` (bool), `fetchedAt?`. 4. **Ideal source:** the **`recording_url` on the existing call webhook** (`CALLGRID.md:41`) + a recording-download endpoint (rate-limited 50/min, `CALLGRID.md:68`). 5. **Payload [DOC]:** already in the webhook body — currently dropped by the adapter. 6. **Persistence:** `MarketplaceCallMedia { id, organizationId, sensor, callExternalId, recordingUrl?, recordingDurationSeconds Int?, hasTranscript Bool, sourceOccurredAt, createdAt, updatedAt, @@unique([sensor, callExternalId]) }` — **store the reference only, do not download audio** (`CALLGRID.md:114`). 7. **Intelligence:** coverage ("% of calls with a recording"), gate for transcript intelligence, QA sampling.

### 2.8 Transcripts **[DOC shape]**

1. **Missing:** the call transcript text. 2. **Why:** the single richest source of *why* a call converted or failed — intent, objections, buyer/service mismatch, appointment likelihood. The extraction engine already exists (`intelligence/callgrid/transcript.ts`) and waits on data. 3. **Fields [DOC]:** `callExternalId`, `text`, `language?`, `source` (`callgrid`|`external_asr`). 4. **Ideal source:** the **`transcript` field on the call webhook** (`CALLGRID.md:42`, intended handling `:115` "store in Interaction.summary") OR an external ASR over the recording URL. 5. **Payload [DOC]:** webhook `transcript` string (historically null/empty — must confirm live delivery). 6. **Persistence:** `MarketplaceCallTranscript { id, organizationId, sensor, callExternalId, text, language?, source, sourceOccurredAt, createdAt, updatedAt, @@unique([sensor, callExternalId]) }` (separate table — transcripts are large; keep off the hot `MarketplaceCall` row). 7. **Intelligence:** the existing extractor lights up — intent distribution, rejection causes, buying signals, appointment likelihood, buyer/service mismatch (all currently "Not enough data").

### 2.9 Dispositions · Call outcomes **[partial REPO shape]**

1. **Missing:** the *rich* disposition beyond the coarse status taxonomy. 2. **Why:** "completed" hides whether it booked, was a wrong number, or a duplicate — outcome drives qualified/converted truth. 3. **Fields:** `callExternalId`, `disposition` (raw string), `endedBy` (`buyer`|`caller`|`system`, **[REPO]** `callgrid.provider.ts:214`), `duplicate`/`blocked`/`connectFailed`/`noConnect`/`noRoute` (**[REPO]** on the `Call` object, `callgrid-api.ts:19-20`). 4. **Ideal source:** already on the call webhook/`/api/call` — **partially mapped** (endedBy) but the granular flags (`duplicate`, `blocked`, `connectFailed`, `noConnect`) are only preserved in raw JSON. 5. **Payload [REPO]:** the `Call` object flags. 6. **Persistence:** promote these onto `MarketplaceCall` (nullable booleans) + a raw `disposition` string. 7. **Intelligence:** true qualified/converted rates, duplicate-rate risk, connectivity-failure detection per source/destination.

### 2.10 Routing events · Queue events **[ASSUMED]**

1. **Missing:** the intra-call routing/queue transitions (rang buyer A → failed → rerouted to B; time in queue). 2. **Why:** explains *connectivity* failures and latency — why a paid call never connected, or waited too long and dropped. 3. **Fields:** `callExternalId`, `sequence`, `eventType` (`queued`|`routed`|`ring`|`connect`|`fail`|`reroute`), `destinationExternalId?`, `atOffsetMs`, `result?`. 4. **Ideal source:** a CallGrid **routing/queue webhook stream** — none confirmed (the current webhook is call-level, not step-level). 5. **Payload [ASSUMED]:** `{ callId, steps:[{seq, type, destinationId, offsetMs, result}] }`. 6. **Persistence:** `MarketplaceRoutingEvent` (child of call). 7. **Intelligence:** routing-failure hotspots, queue-time distribution, "destination X fails to connect" alerts, reroute-loss quantification.

### 2.11 Campaign performance **[derivable + ASSUMED enrichment]**

1. **Missing:** campaign-level rollups incl. any campaign *config* (vertical, geo targeting, budget). 2. **Why:** campaign is the lever owners scale/pause; Brain needs performance *and* the config that explains it. 3. **Fields:** performance is **derivable** from `MarketplaceCall` grouped by `campaignExternalId`; config (`vertical`, `geoTargeting`, `budgetCents`, `status`) needs a **[ASSUMED]** CallGrid campaign endpoint. 4. **Ideal source:** derive performance now; `/api/campaigns` **[unconfirmed]** for config. 5. **Payload [ASSUMED]:** `{ id, name, vertical, status, budget, geoTargets }`. 6. **Persistence:** derive live; optional `MarketplaceCampaign` for config when the endpoint is confirmed. 7. **Intelligence:** scale/pause per campaign (partially available now), budget-pacing, geo/vertical performance.

### 2.12 Additional operational objects Brain should consume

- **Phone number pool** (`phoneNumberId` is **[REPO]** on the `Call` object): which tracking numbers drive which sources — number-level attribution & fraud detection. Persist `MarketplaceTrackingNumber`.
- **Duplicate detection** (`duplicate`, `callHash`, `callSid` **[REPO]** on `Call`): duplicate-call rate as a source-quality and billing-integrity signal.
- **Ingestion health** (Loop-side, **real now**): API errors (`CallGridApiError`), sync results (`reconcile()` counts), webhook failures (`IntegrationEvent.status=FAILED`) — surface as Brain "evidence sources" confidence input. No CallGrid dependency.

---

## Part 3 — Data contract summary (every missing object)

| Object | Money? | Key link | Unique | Shape confidence |
| --- | --- | --- | --- | --- |
| MarketplaceAuction | cents | callExternalId | (sensor, externalId) | ASSUMED |
| MarketplaceBid | cents | auctionExternalId, buyerExternalId | (sensor, externalId) | ASSUMED (+REPO stats) |
| MarketplaceBidStat | cents | sourceExternalId + window | (sensor, source, windowStart) | REPO shape |
| MarketplaceRejectionRollup | — | sourceExternalId + window | (sensor, source, windowStart) | REPO shape |
| MarketplaceCap | cents/int | participantExternalId | (sensor, participant, capType) | ASSUMED |
| MarketplaceRevenueReversal | cents | callExternalId, buyerExternalId | (sensor, externalId) | ASSUMED |
| MarketplaceCallMedia | — | callExternalId | (sensor, callExternalId) | DOC |
| MarketplaceCallTranscript | — | callExternalId | (sensor, callExternalId) | DOC |
| MarketplaceRoutingEvent | — | callExternalId | (sensor, externalId) | ASSUMED |
| MarketplaceCampaign | cents | campaignExternalId | (sensor, externalId) | ASSUMED (perf derivable) |
| MarketplaceTrackingNumber | — | sourceExternalId | (sensor, externalId) | REPO shape |

All: `organizationId` scoped, `sensor` column, `sourceOccurredAt`/`createdAt`/`updatedAt`, nullable unknowns, cents for money — identical conventions to `MarketplaceCall`.

---

## Part 4 — Recommended implementation order

Ordered by **(value ÷ dependency-on-unconfirmed-CallGrid-access)**:

1. **`MarketplaceCall` foundation** — *no new CallGrid access needed* (this PR). Everything else references it.
2. **Dispositions/outcomes (§2.9)** — *no new access*; the flags are already in ingested JSON, just promote them onto `MarketplaceCall`.
3. **Ingestion health (§2.12)** — *no new access*; surface existing error/sync/webhook state to Brain.
4. **Recordings + Transcripts (§2.7–2.8)** — **[DOC]** shape known; needs (a) adapter to map `recording_url`/`transcript` from the webhook, (b) confirmation CallGrid actually delivers them. Highest intelligence upside (transcript engine already built).
5. **Bid statistics + Rejections (§2.3–2.4)** — **[REPO]** shape known; needs the reports API confirmed. Lights up the existing marketplace-intelligence assembler.
6. **Auction + Bid lifecycle (§2.1–2.2)** — **[ASSUMED]**; needs auction webhook/report confirmed. Deepest optimization intelligence.
7. **Caps (§2.5)** — **[ASSUMED]**; unlocks cap forecasting.
8. **Refunds/Chargebacks (§2.6)**, **Routing/Queue (§2.10)**, **Campaign config (§2.11)** — **[ASSUMED]**; build as each endpoint is confirmed.

Steps 4–8 each follow the identical pattern already proven for calls: **adapter map → idempotent persist → repository aggregate → intelligence rule → briefing surface.** No architectural redesign — only new entities of the same shape family.

---

## Part 5 — Risk assessment

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Building against unconfirmed endpoints** (`bidStats`, auctions, caps, refunds) | **High** — could ship a client that 404s or mismaps in prod | Do NOT build until the endpoint + payload are confirmed. Every `[ASSUMED]` object stays blueprint-only. |
| **Recordings/transcripts documented but historically empty** (`callgrid.provider.ts:20-29`) | Medium | Map the fields (low cost) but gate intelligence on `available`/non-empty; confirm live delivery before claiming coverage. |
| **Polling-endpoint discrepancy** (`/v1/calls` doc vs `/api/call` code) | Medium | Confirm the real reports/polling base path before wiring a scheduler; base URL is already env-overridable. |
| **Rate limits** (recording downloads 50/min; API limits unstated) | Medium | Build the report/recording pollers with token-bucket rate limiting + backoff from day one (the reconciliation service's retry pattern is the template). |
| **PII in transcripts/recordings** | Medium | Store recording *reference* only (per `CALLGRID.md:114`); treat transcripts as sensitive; org-scope + access-gate; never send to an external service without authorization. |
| **Idempotency on new webhooks** | Medium | Reuse the proven `(provider, externalId)` unique + upsert pattern; every new object carries `(sensor, externalId)` unique. |
| **Schema churn as canonical Buyer/Vendor/Source/Campaign entities arrive** | Low | Use **nullable external-ref ids** now (per the `MarketplaceCall` spec); add FKs later without rewriting rows. |
| **Money unit drift** (dollars vs cents) | Low | Every table stores **integer cents**; conversion happens once at the ingestion boundary. |

---

## Part 6 — What to hand CallGrid (the exact ask)

To unblock steps 4–8, confirmation is needed on:
1. **Does the call webhook actually deliver `recording_url` and `transcript`?** (Loop's doc says yes; the provider's audit note says historically empty.) If yes → step 4 ships immediately.
2. **Do `/api/reports/bidStats`, `/bidStats/rejections`, `/stats` exist?** Exact base path, params, and response shape. (Loop has type stubs; no confirmation.) If yes → step 5.
3. **Is there an auction/ping webhook or report** exposing per-bid outcomes? → step 6.
4. **Is there a caps/limits endpoint** (or a rate-limited signal on bids)? → step 7.
5. **Is there a billing/financial feed** for refunds/chargebacks? → step 8.
6. **The real rate limits** for each of the above (only recording-download 50/min is documented).
