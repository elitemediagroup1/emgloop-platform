# Website evidence: commissioning

For the website evidence foundation (`feat/website-evidence-foundation`). What it builds is described in
`docs/architecture/website-evidence.md`.

**This connects no external source.** It needs no Google, Bing or Clarity credential, and it sets no
production variable beyond what is listed below.

## ⚠️ Order matters: the webhook fails closed

Once the web deploy carrying this change is live, `/api/webhooks/website` admits events **only** for a
registered property that is **LIVE with ingestion ENABLED**. Everything else is refused and **not stored**:

- a property no one registered: `PROPERTY_UNREGISTERED`;
- a registered property that is OWNED or BUILDING: `PROPERTY_NOT_LIVE`;
- a LIVE property whose ingestion is not enabled: `INGESTION_DISABLED`.

Register the portfolio, and move each site that is **currently sending traffic** to LIVE with ingestion
ENABLED, *before* the web deploy reaches production. Otherwise accept a gap in that site's website events.

## Sequence

### 1. Merge the PR (Matt)

### 2. Apply the migration

Dispatch **Deploy Prisma Migrations**. It applies `20261009000000_website_evidence_foundation`, which is
additive only:

- the `web_properties` table (empty);
- the `source_metric_windows` table (empty);
- ten nullable columns on `provider_connections` (all NULL).

Read back: the run log lists the migration as applied.

### 3. Register the whole EMG portfolio

Dispatch **Register Web Property** with:

- `action: register-portfolio`;
- `organization_slug`: the organization that owns the portfolio. Today every EMG site's events land in
  `servicesinmycity-demo`, but that is Matt's decision to make here;
- `dry_run: true` first, then `dry_run: false`.

This registers every domain in the portfolio list, each one **OWNED with ingestion DISABLED**:

- activitiesinmycity.com, artistsinmycity.com, careinmycity.com, carsinmycity.com
- consumersupporthelp.com, faithinmycity.com, familiesinmycity.com, foodinmycity.com
- gamedayinmycity.com, homesinmycity.com, marriageinmycity.com, petsinmycity.com
- realtorsinmycity.com, schoolsinmycity.com, servicesinmycity.com, spasinmycity.com
- travelinmycity.com

Read back: `event=REGISTRATION_RESULT registered=17 ... readBack=FOUND`. A re-run reports `unchanged=17`.

After this step, OWNED properties are known and quiet: they produce no events, no gap and no
missing-connection limitation.

### 4. Mark each site's real state, one dispatch per act

For each site **currently live and sending traffic** (as far as the code knows, the sites whose snippets
have been installed: servicesinmycity, consumersupporthelp, marriageinmycity, careinmycity, petsinmycity,
gamedayinmycity, homesinmycity; confirm each one):

1. `action: set-lifecycle`, `property_key: <key>`, `lifecycle: LIVE`. Ingestion stays DISABLED.
2. `action: enable-ingestion`, `property_key: <key>`.

For each site under construction: `set-lifecycle` → `BUILDING`, and leave ingestion disabled.

Every other site stays `OWNED`.

The optional external bindings (`ga4_property_id`, `search_console_site`, `bing_site`, `clarity_project_id`)
can be recorded with `action: register` on the same key and primary domain. They connect nothing, must lie
within the property's domain, and never change its lifecycle.

Read back: `event=STATE_RESULT written=true lifecycle=LIVE ingestion=ENABLED ownerUnchanged=true`.

### 5. Deploy web (Netlify)

Read back:

- `GET /api/webhooks/website` returns `tenancy: "registered-property"`.
- In **Read Intelligence State**, for the organization:
  - `WEBSITE_PROPERTY registered=17` with the lifecycle counts;
  - `WEBSITE_PROPERTY_STATE state=LIVE_INGESTING count=<live sites>`;
  - `WEBSITE_EVENTS total>0` with a recent `newestAt`;
  - `SOURCE_COVERAGE source=WEBSITE_EVENTS coverage=COVERED`;
  - the four external sources show `connection=NOT_CONNECTED coverage=GAP_NOT_CONNECTED`. That is correct,
    because LIVE sites exist and nothing is connected yet.
- An organization with no LIVE property shows `coverage=NOT_APPLICABLE` instead.
- `WEBSITE_REFUSALS` counts `PROPERTY_NOT_LIVE` / `INGESTION_DISABLED` for the organization.
- Refusals for unregistered properties appear only in Netlify function logs as
  `WEBSITE_INGEST_REFUSED code=PROPERTY_UNREGISTERED`.

### 6. Redeploy the connections worker

This runs the aggregate-window retention step (the table is empty, so it is a no-op). It does **not** purge raw
website telemetry. `LOOP_WEBSITE_TELEMETRY_RETENTION` stays unset.

### 7. Switch the website reading to @2 (only if website readings are commissioned)

If `LOOP_INTELLIGENCE_PRODUCERS` names `website.domain@1`, replace it with `website.domain@2`. `@1` no longer
exists.

`@2` reads Loop's own events only. It names unconnected external sources as a coverage limitation, and only when
the organization has a LIVE property. It uses the existing `website.domain.reading` task; there is no new AI
task.

## Later lifecycle changes

A site goes live, pauses or retires through `set-lifecycle`, and its telemetry is allowed or stopped through
`enable-ingestion` / `disable-ingestion`. Pausing or retiring a site disables its ingestion in the same write.
None of these acts changes which organization owns it.

## Deliberately NOT done here

- **No external connector.** There are no GA4, Search Console, Bing or Clarity calls or credentials. Google
  auth is decided, not built (architecture §7). Account-level discovery and reconciliation is a documented
  requirement for the connector batches (§8).
- **No raw telemetry purge.** It is defined and proven unable to touch a WEB_LEAD, but enabling it
  (`LOOP_WEBSITE_TELEMETRY_RETENTION=on`) truncates `/crm/analytics` history beyond 90 days. That is Matt's
  decision.
- **No scrub of historical rows.** Website rows stored before this change may still hold contact details in
  their payload. Reads minimize them, but removing them is a production data change and needs its own
  dispatch.
- **Signed-tier previews.** The signed tier no longer accepts unsigned traffic on previews.

## Rollback

- **Web.** Redeploy the previous web build. The old route resolves `servicesinmycity-demo` again.
- **Migration.** Nothing needs reverting. The tables stay unused and the columns stay NULL.
