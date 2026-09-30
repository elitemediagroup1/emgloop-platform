# Website evidence: commissioning

For the website evidence foundation (`feat/website-evidence-foundation`). What it builds is described in
`docs/architecture/website-evidence.md`.

**This connects no external source.** It needs no Google, Bing or Clarity credential, and it sets no
production variable beyond what is listed below.

## ⚠️ Order matters: the webhook fails closed

Once the web deploy carrying this change is live, `/api/webhooks/website` accepts events only for
**registered** properties. Every event from a property that is not yet registered is refused with
`PROPERTY_UNREGISTERED` and is **not stored**.

Register the properties *before* the web deploy reaches production, or accept a gap in website events between
the deploy and the registrations.

## Sequence

### 1. Merge the PR (Matt)

### 2. Apply the migration

Dispatch **Deploy Prisma Migrations**. It applies `20261009000000_website_evidence_foundation`, which is
additive only:

- the `web_properties` table (empty);
- the `source_metric_windows` table (empty);
- ten nullable columns on `provider_connections` (all NULL).

Read back: the run log lists the migration as applied.

### 3. Register each live property, dry run first

Dispatch **Register Web Property** once per site, first with `dry_run: true` and then with `dry_run: false`.

- `organization_slug`: the organization that owns the site's visitors. Today every EMG site's events land in
  `servicesinmycity-demo`, but whether that stays so is Matt's decision, made here, per property.
- `property_key`: exactly the `data-property` the site's snippet sends (its ingest key is `pk_emg_<key>`).
  The install snippets currently name these keys:

  | Key | Domain |
  |---|---|
  | `servicesinmycity` | servicesinmycity.com |
  | `consumersupporthelp` | consumersupporthelp.com |
  | `marriageinmycity` | marriageinmycity.com |
  | `careinmycity` | careinmycity.com |
  | `petsinmycity` | petsinmycity.com |
  | `gamedayinmycity` | gamedayinmycity.com |
  | `homesinmycity` | homesinmycity.com |

  Register only the sites that are actually live. The number of properties is whatever you register; nothing
  depends on this list.
- `domains`: the site's hostnames, space-separated, for example `servicesinmycity.com`. A registered domain
  also admits its subdomains, so `www.` is covered.
- `ga4_property_id`, `search_console_site`, `bing_site`, `clarity_project_id`: optional. They record which
  external property belongs to the site. **They connect nothing**, and they can be added later.

Read back: `event=REGISTRATION_RESULT result=REGISTERED written=true readBack=FOUND status=ACTIVE`.

### 4. Deploy web (Netlify)

The website webhook now resolves tenancy from `web_properties`.

Read back:

- `GET /api/webhooks/website` returns `tenancy: "registered-property"`.
- In **Read Intelligence State**, for the organization:
  - `WEBSITE_EVENTS total>0` with a recent `newestAt`;
  - `WEBSITE_REFUSALS` for that organization's refusals;
  - `SOURCE_COVERAGE source=WEBSITE_EVENTS connection=CONNECTED`;
  - the four external sources show `connection=NOT_CONNECTED`.
- Refusals for an unregistered property are logged as `WEBSITE_INGEST_REFUSED code=PROPERTY_UNREGISTERED`
  (Netlify function logs). They have no organization to be counted against.

### 5. Redeploy the connections worker

Redeploy the worker (the `connections-infra-deploy` path). It runs the aggregate-window retention step (the
table is empty, so this is a no-op). It does **not** purge raw website telemetry.
`LOOP_WEBSITE_TELEMETRY_RETENTION` stays unset.

### 6. Switch the website reading to @2 (only if website readings are commissioned)

If `LOOP_INTELLIGENCE_PRODUCERS` names `website.domain@1`, replace it with `website.domain@2`. `@1` no longer
exists: an activation list that names it simply runs no website reading. `@2`:

- reads Loop's own events only;
- counts from every admitted event;
- never counts heartbeat, scroll or identify as page views;
- names the unconnected external sources as a coverage limitation.

It uses the existing `website.domain.reading` task. There is no new AI task.

## Deliberately NOT done here

- **No external connector.** There are no GA4, Search Console, Bing or Clarity calls or credentials. Google
  auth is decided, not built (architecture §7).
- **No raw telemetry purge.** `WEBSITE_RAW_TELEMETRY` is defined and proven unable to touch a WEB_LEAD, but
  enabling it (`LOOP_WEBSITE_TELEMETRY_RETENTION=on` on the worker) truncates `/crm/analytics` history beyond
  90 days. That is Matt's decision.
- **No scrub of historical rows.** Website rows stored before this change may still hold contact details in
  their payload. Reads minimize them, but removing them is a production data change and needs its own
  dispatch.
- **Signed-tier previews.** The signed tier no longer accepts unsigned traffic on previews: there is no
  per-connection `allowUnsigned` before the organization is known. Use a signed request or the browser tier
  from a registered domain.

## Rollback

- **Web.** Redeploy the previous web build. The old route resolves `servicesinmycity-demo` again.
- **Migration.** Nothing needs reverting. The tables stay empty or unused and the columns stay NULL.
