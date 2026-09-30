# Governed website evidence

Status (2026-09-30): the **foundation** is built (draft PR `feat/website-evidence-foundation`). It covers
first-party ingestion tenancy and minimization, the source/stream model, the property authority, the
aggregate evidence store and the organization credential store. **No external website source is connected.**
Google Analytics 4, Google Search Console, Bing Webmaster Tools and Microsoft Clarity are *declared* in the
source registry and read by nothing. The last section records how Google will be authenticated. That part is
a decision, not code.

## 1. Two identities per piece of evidence

| | What it answers | Where it lives |
|---|---|---|
| `sourceId` | Which governed system supplied this evidence? | `INTELLIGENCE_SOURCE_REGISTRY` (`@emgloop/shared`) |
| `stream` | Which real-world events does that system observe? | the same entry's `stream` |

Loop keeps both on every source and never collapses them. Provenance always names the source, and
independence is counted over streams.

| Source | Stream | Basis |
|---|---|---|
| `WEBSITE_EVENTS` (Loop's tracker) | `SITE_VISITS` | `LOOP_RECORDS` |
| `GOOGLE_ANALYTICS` | `SITE_VISITS` | `ORGANIZATION_CONNECTION` (declared, not connected) |
| `MICROSOFT_CLARITY` | `SITE_VISITS` | `ORGANIZATION_CONNECTION` (declared, not connected) |
| `GOOGLE_SEARCH_CONSOLE` | `SEARCH_GOOGLE` | `ORGANIZATION_CONNECTION` (declared, not connected) |
| `BING_WEBMASTER` | `SEARCH_BING` | `ORGANIZATION_CONNECTION` (declared, not connected) |
| `CALLGRID` (feeds CALLGRID and CAMPAIGNS) | `CALLS` | `LOOP_RECORDS` |
| `LOOP_INTAKE` | `INTAKE_RECORDS` | `LOOP_RECORDS` |

**Situation independence** (`clusterSituationSignals`): a candidate is `sourceIndependent` only when its
signals rest on at least `SITUATION_MIN_SOURCES` (2) distinct **streams**.

- GA4, Clarity and Loop's own events count the same visits. Three of them are one stream, not three
  confirmations.
- Search Console and Bing are two streams.
- CallGrid and Campaigns remain one stream (`CALLS`).

The rules are fail-closed and deterministic:

- A source id that is not registered contributes no stream. It still appears in `sources`, so the lineage
  stays visible.
- A model cannot create or change lineage. `m.*` signals are excluded from clustering, and a signal's sources
  come from its digest's governed provenance.
- **Per-signal lineage.** In a digest that names more than one source, each evidence reference must match
  exactly one source's `evidenceRefPrefixes`. Otherwise that signal gets no lineage.

**Intake is not website evidence by default.** `LOOP_INTAKE` has its own stream. An intake signal may carry
website lineage only when a governed, deterministic relationship proves that specific record came from the
website. Nothing infers origin from names, phones, emails or fuzzy matching, and no such relationship is
built yet.

## 2. The EMG website-property registry

`web_properties` is the **authoritative registry of EMG website properties**: every owned domain, whether
live or not. Each row has:

- `key`, unique across Loop (the tracker's `data-property`; its public ingest key is `pk_emg_<key>`);
- `primaryDomain`, normalized and unique across Loop. One EMG domain is one property, and every allowed
  domain and external binding lies within it;
- the one `organizationId` it belongs to;
- **`lifecycle`**: what the property is;
- **`ingestion`**: whether Loop accepts its first-party telemetry now;
- `allowedDomains`: the hosts browser events may come from in production;
- the external bindings: `ga4PropertyId`, `searchConsoleSiteUrl`, `bingSiteUrl`, `clarityProjectId`. Each is
  unique across Loop and records which external property belongs here. None of them connects anything.

### Lifecycle and ingestion: two separate facts

| Lifecycle | Meaning | May go to |
|---|---|---|
| `OWNED` | held; nothing built | BUILDING, LIVE, RETIRED |
| `BUILDING` | being built | OWNED, LIVE, RETIRED |
| `LIVE` | serving visitors | PAUSED, RETIRED |
| `PAUSED` | temporarily not serving | LIVE, RETIRED |
| `RETIRED` | no longer operated | OWNED |

- `ingestion` is `ENABLED` or `DISABLED`. It can be `ENABLED` **only while `LIVE`**; a database CHECK enforces
  this as well.
- Leaving `LIVE` disables ingestion in the same write.
- Entering `LIVE` never enables ingestion. Enabling it is its own operator act.
- A new property starts `OWNED`, `DISABLED`.
- Lifecycle and ingestion change **only** through `transitionLifecycle` / `setIngestion`, scoped to the owning
  organization. Neither ever changes `organizationId`.
- `register` on an existing property updates only its label, allowed domains and bindings. It refuses a
  lifecycle change (`LIFECYCLE_CHANGE_NEEDS_TRANSITION`) and a domain change
  (`PRIMARY_DOMAIN_CHANGE_REFUSED`).
- **Nothing external changes either fact.** A GA4, Search Console or Bing account listing the domain never
  makes it LIVE.

### Admission: tenancy for website events

Only this table decides which organization a website event belongs to, and **only LIVE + ENABLED admits**.
`/api/webhooks/website` authenticates the tier, then calls `admitWebsiteDelivery`:

- **Browser tier.** The public key `pk_emg_<key>` must name a registered property that admits telemetry. In
  production the Origin must be one of its allowed domains, and an event naming a different property is
  `PROPERTY_MISMATCH`.
- **Signed tier.** The HMAC over `WEBSITE_WEBHOOK_SECRET` proves a *class* of sender, not a tenant, so each
  event's property is resolved on its own.
- **Refusals**, as codes:

  | Code | When | Counted against |
  |---|---|---|
  | `PROPERTY_UNREGISTERED` | nobody registered the property | nobody (logged, not durable) |
  | `PROPERTY_NOT_LIVE` | registered, but OWNED / BUILDING / PAUSED / RETIRED | the owner (diagnostics) |
  | `INGESTION_DISABLED` | LIVE, but ingestion is off | the owner (diagnostics) |
  | `PROPERTY_MISMATCH` | an event names another property than the key verified | the owner (diagnostics) |
  | `DOMAIN_NOT_ALLOWED` | the Origin is not one of the property's allowed domains | the owner (diagnostics) |
  | `MISSING_ORIGIN` | a browser request has no Origin in production | the owner (diagnostics) |
  | `PROPERTY_MISSING` | a signed-tier event names no property | nobody (logged, not durable) |
  | `MISSING_INGEST_KEY` | a browser request carries no ingest key | nobody (logged, not durable) |

  There is no fallback organization. The browser's `organization` field is never read or stored.

### Registration and resolution

- **Registration** is an operator act: `Register Web Property` (workflow) →
  `scripts/operations/register-web-property.ts`.
  - Actions: `register-portfolio` (every EMG portfolio domain as OWNED), `register`, `set-lifecycle`,
    `enable-ingestion`, `disable-ingestion`.
  - It runs as a dry run by default.
  - It refuses a key, domain or binding that another organization holds, and never moves one.
  - The migration inserts nothing.
  - The portfolio list (`EMG_WEBSITE_PROPERTIES`, 17 domains on 2026-09-30) is **data**: registration input
    and install snippets. It is never a tenancy authority, and nothing depends on its length.
- **Resolution** is the one cross-organization read (`WebPropertyRepository.resolveForIngest`). It returns only
  what admission needs. Every other method takes `organizationId` first.

### Coverage: what is expected

Absence is a gap only where something is expected (`websiteCoverageVerdict`):

| Source | Expected when | Verdict when not expected | Verdict when expected |
|---|---|---|---|
| First-party events | the organization has a LIVE property with ingestion ENABLED | `NOT_APPLICABLE` | `COVERED` or `GAP_NO_EVENTS` |
| An external source | the organization has at least one LIVE property | `NOT_APPLICABLE` | `COVERED` or `GAP_NOT_CONNECTED` |

An organization whose properties are all OWNED / BUILDING / PAUSED / RETIRED therefore sees **no gap and no
limitation**. `website.domain@2` names unconnected sources only when a LIVE property expects them.

## 3. First-party telemetry: what is stored

`WebsiteProvider.parseWebhook` keeps only `minimizeWebsiteEvent`'s attribute set:

- `property`;
- `page`: the path, lowercased, with no query string or fragment;
- bounded labels: `title`, `cta`, `form`, `category`, `city`, `source`, `medium`;
- `referrerHost`;
- pseudonymous `visitorId` / `sessionId`;
- a ZIP code when a search was one;
- scroll `depth`.

It drops:

- email and phone, and their click targets;
- the full URL;
- free-text search;
- campaign names;
- screen size;
- download and outbound URLs;
- any label that carries a contact detail;
- every unknown key.

It hands no email or phone to the pipeline as identity.

- **Identity** is `web:<property>:<sender id>`, or `web:<property>:h:<sha256 of the minimized event>`. It is
  never derived from the receiving clock. A redelivery dedupes, and two properties never collide in the
  globally keyed `integration_events`.
- **Event classes** (`websiteEventClass`) are `PAGE_VIEW`, `SESSION`, `ENGAGEMENT`, `INTENT`, `TELEMETRY` and
  `OTHER`. Heartbeat, scroll depth and identify are `TELEMETRY`: stored as themselves, never counted as page
  views, and they derive no signals. An unknown event is `web.other`; it used to be stored as a page view.
- **Where the counts come from.** Every admitted event is an `integration_events` row. The normalizer has
  never made page views or session starts into Interactions (only intent-bearing events become Interactions),
  so website analytics and `website.domain@2` count from `integration_events`:
  - totals are an exact GROUP BY with no row cap;
  - rankings come from a bounded scan that reports `rankingsComplete`;
  - legacy rows are read back through the minimizer, and legacy heartbeat rows are recognised by their raw
    event name.

## 4. External aggregates: the evidence contract

`source_metric_windows` has one row per (organization, source, subject, dimension, value, granularity,
window). It holds counts and rates, never a raw response or a user. `websiteSourceWindowProblems` sets these
rules, and `SourceMetricWindowRepository.upsert` enforces them:

- **NULL is not zero.** An unreported metric stays `null`, and a reported 0 stays 0.
- **Finality.** `PRELIMINARY` while the source may revise the window. A late PRELIMINARY never overwrites a
  FINAL window. Completeness `PARTIAL` is carried on reads (`AnalyticsResult.completeness`).
- **Quality flags**, each nullable: `sampledPercent`, `thresholded`, `rolledUp`, `truncated`, `emptyReason`,
  `timeZone`.
- **Forbidden dimensions:** search query text, campaign names and keywords. No row can carry one, and none
  reaches a model.
- **Tenancy.** A window can reference a web property only through the composite FK
  `(webPropertyId, organizationId)`.

`AnalyticsProvider` (`@emgloop/providers`) is the adapter contract a connector will implement. No class
implements it today.

## 5. Organization-owned credentials

`provider_connections` has the following credential columns:

- `credentialKind`, `secretSealed`, `sealVersion`, `keyRef`;
- `lastAttemptAt`, `lastSucceededAt`, `lastFailureClass`, `backoffUntil`;
- `connectedByUserId`, `revokedAt`.

`OrganizationCredentialSealer` (AES-256-GCM, header `LOC\x01`) binds each value to
`[organization, provider, credentialKind, 'organization.credential']`. The same bytes copied onto another
organization's row do not open, and a different provider, kind or key does not open them either.

- `OrganizationConnectionRepository` stores only sealed bytes, is organization-first, and removes the bytes
  on revoke.
- A connection counts as `CONNECTED` only after one successful read. A stored credential alone is not a
  connection.
- Nothing is populated today. Bing and Clarity credentials will live here. Google will not (see §7).

## 6. Retention and the WEB_LEAD finding

| Category | Window | Rows | State |
|---|---|---|---|
| `WEBSITE_RAW_TELEMETRY` | 90 days | website `interactions` with `customerId IS NULL`, and website `integration_events` | **Defined, not active.** It runs only when `LOOP_WEBSITE_TELEMETRY_RETENTION=on`, and nothing sets that. |
| `WEBSITE_SOURCE_AGGREGATES` | 400 days | `source_metric_windows` that ended before the window | Active on the worker (the table is empty) |

**How a WEB_LEAD is established** (`IntakeEligibilityRepository`):

- A Customer row with `metadata.createdFrom = 'website'`, not a `web-visitor:` externalId.
- Its entry time is the earliest website `FORM_SUBMISSION` Interaction *attached to that Customer*.

**Why the purge cannot touch it.** The purge touches no Customer and selects only Interactions with no Person,
so neither the lead nor its submission is ever a candidate. A Postgres test proves this.

**Why it is still not active.** Enabling it truncates `/crm/analytics` history beyond 90 days. That is a
decision for Matt, not a side effect.

Historical rows written before this change still hold whatever the old adapter stored, including contact
details. This foundation does not scrub them: that would be a production data change. Reads pass them
through the minimizer, so nothing unminimized is shown.

## 7. Google authentication: decided, not built

These are the decisions for the Google connectors:

- **Identity.** AWS workload → Google Cloud **Workload Identity Federation** → a Google **service account**.
  There is no long-lived service-account JSON key on the normal path. A JSON key is a fallback only, used if
  WIF proves impossible, and would be sealed like any other organization credential.
- **GA4.** Analytics Data API (`runReport`), scope `https://www.googleapis.com/auth/analytics.readonly`. The
  service account is added to each GA4 property as **Viewer**.
- **Search Console.** Search Console API (`searchanalytics.query`), scope
  `https://www.googleapis.com/auth/webmasters.readonly`. The service account is added to each site as a
  **Restricted** user. Query text is never requested for storage.
- **Binding.** A connector reads only the `ga4PropertyId` / `searchConsoleSiteUrl` recorded on a registered
  `web_properties` row, for that row's organization. Each binding must lie within the row's `primaryDomain`.
- **Confused-deputy protection.** One Loop service account may be granted access by many organizations, so
  "the API answered" never proves which organization a property belongs to. The binding does. The connector
  resolves the property from the organization's own registered row and never from a request. A key, primary
  domain or external binding held by another property is refused at registration, and nothing is ever moved.
- **Library.** Use Google's maintained auth library for the WIF token exchange if it materially reduces
  custom security code. That is a new dependency, so it is proposed with the connector PR.

## 8. Future connectors: account-level discovery (requirement, not built)

This is recorded for the connector batches. Nothing in this foundation implements it.

- **Discover per account, reconcile by domain.** GA4, Search Console and Bing connectors list what the account
  can see and reconcile each discovered external property against **all** registered `web_properties` rows by
  normalized domain, not just the LIVE ones.
  - A new external property for an already-registered EMG domain needs no code deployment. It becomes a
    binding *proposal* for that row.
- **Surface; never guess.** The following go to operator review, and nothing is written for them:
  - an ambiguous match;
  - an external property matching no registered domain;
  - several external properties for one domain.
- **Never change state.** Discovery never changes a property's lifecycle, ingestion or organization, as §2
  already guarantees. The only thing a discovery can lead to is an operator-approved binding (`register`), and
  that write cannot touch lifecycle or ownership.
- **One site, one stream.** Search Console may expose both a Domain property (`sc-domain:example.com`) and
  URL-prefix properties (`https://www.example.com/`) for the same EMG site. They are **one EMG website and one
  evidence stream** (`SEARCH_GOOGLE`), never two websites or two independent streams. The connector chooses
  one as the property's binding (the Domain property, when it exists) and records the others as known aliases
  for review.
- **Clarity** may still need a per-project token, sealed per organization (§5).

## Migration naming

The migration is `20261009000000_website_evidence_foundation`. The migration names in this repository are
**ordinal keys ahead of the calendar**, not dates. Production has already applied `20261001000000` through
`20261008000000` (the last deploy run, 2026-09-26, applied `20261008000000_case_private_scopes`). A name dated
2026-09-30 would therefore sort **before** six applied migrations, and would be applied out of order.
