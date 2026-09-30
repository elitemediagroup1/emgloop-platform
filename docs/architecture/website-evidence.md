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

## 2. Property authority: tenancy for website events

`web_properties` holds one row per property:

- `key`, unique across Loop;
- the one `organizationId` it belongs to;
- `status` (`ACTIVE` / `DISABLED`);
- `allowedDomains`;
- the future external bindings: `ga4PropertyId`, `searchConsoleSiteUrl`, `bingSiteUrl`, `clarityProjectId`.

The external bindings record which external property belongs to this site. They connect nothing.

**Only this table decides which organization a website event belongs to.**
`/api/webhooks/website` authenticates the tier, then calls `admitWebsiteDelivery`:

- **Browser tier.** The public key `pk_emg_<key>` must name a registered, ACTIVE property. In production the
  Origin must be one of that property's allowed domains. An event naming a different property is refused with
  `PROPERTY_MISMATCH`.
- **Signed tier.** The HMAC over `WEBSITE_WEBHOOK_SECRET` proves a *class* of sender, not a tenant, so each
  event's property is resolved on its own.
- **Refusals**, as codes:

  | Code | When |
  |---|---|
  | `PROPERTY_UNREGISTERED` | the property is not in the registry |
  | `PROPERTY_DISABLED` | the property is registered but not ACTIVE |
  | `PROPERTY_MISSING` | a signed-tier event names no property |
  | `DOMAIN_NOT_ALLOWED` | the Origin is not one of the property's allowed domains |
  | `MISSING_ORIGIN` | the browser request has no Origin in production |
  | `MISSING_INGEST_KEY` | the browser request carries no ingest key |

  There is no fallback organization. The browser's `organization` field is never read or stored.
- **Registration** is an operator act: `Register Web Property` (workflow) → `scripts/operations/register-web-property.ts`.
  It runs as a dry run by default. It refuses a key that another organization owns, and it never moves one.
  The migration inserts no property. Any number of properties can be registered.
- **Resolution** is the one cross-organization read (`WebPropertyRepository.resolveForIngest`). It returns
  only what admission needs. Every other method takes `organizationId` first.

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
  `web_properties` row, for that row's organization.
- **Confused-deputy protection.** One Loop service account may be granted access by many organizations, so
  "the API answered" never proves which organization a property belongs to. The binding does. The connector
  resolves the property from the organization's own registered row and never from a request, and a property
  bound to two organizations is refused at registration (the key is unique and never moved).
- **Library.** Use Google's maintained auth library for the WIF token exchange if it materially reduces
  custom security code. That is a new dependency, so it is proposed with the connector PR.
