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

Register the portfolio, and commission each site that is **currently sending traffic** (steps 2–5), *before*
the web deploy reaches production. Otherwise accept a gap in that site's website events.

## Sequence

Steps 0–1 are done in production: the migration was applied and the portfolio was registered on 2026-09-30,
and `servicesinmycity` is LIVE + ENABLED.

### 0. Apply the migration (done)

Dispatch **Deploy Prisma Migrations**. It applies `20261009000000_website_evidence_foundation`, which is
additive only:

- the `web_properties` table (empty);
- the `source_metric_windows` table (empty);
- nullable columns on `provider_connections`.

### 1. Register the whole EMG portfolio (done)

Dispatch **Register Web Property** with:

- `action: register-portfolio`;
- `organization_slug`: the owning organization (`servicesinmycity-demo`);
- `dry_run: true` first, then `dry_run: false`.

This registers every portfolio domain **OWNED with ingestion DISABLED**:

- activitiesinmycity.com, artistsinmycity.com, careinmycity.com, carsinmycity.com
- consumersupporthelp.com, faithinmycity.com, familiesinmycity.com, foodinmycity.com
- gamedayinmycity.com, homesinmycity.com, marriageinmycity.com, petsinmycity.com
- realtorsinmycity.com, schoolsinmycity.com, servicesinmycity.com, spasinmycity.com
- travelinmycity.com

Read back: `event=REGISTRATION_RESULT registered=17 ... readBack=FOUND`. A re-run reports `unchanged=17`.

OWNED properties are known and quiet: they produce no events, no gap and no missing-connection limitation.

### 2. Dry-run `commission-live-sites` with the explicitly confirmed live properties

Dispatch **Register Web Property** with:

| Input | Value |
|---|---|
| `action` | `commission-live-sites` |
| `organization_slug` | `servicesinmycity-demo` |
| `property_keys` | the confirmed live sites, comma-separated, e.g. `servicesinmycity,consumersupporthelp,marriageinmycity,careinmycity,petsinmycity,gamedayinmycity,homesinmycity` |
| `dry_run` | `true` |

Leave `property_key`, `primary_domain`, `lifecycle` and the binding inputs empty.

Only the keys you list are touched; the action never commissions anything you did not name. At most **25**
keys are accepted (`WEB_PROPERTY_COMMISSION_BATCH_MAX`). Surrounding whitespace is trimmed. The whole run is
refused, before any database lookup, if the list:

- is empty;
- has an empty entry;
- has a malformed key;
- repeats a key;
- has more than 25 keys.

### 3. Inspect the results

The dry run performs the **complete preflight** and writes nothing. It prints one line per requested property:

```
event=COMMISSION_PREFLIGHT property=careinmycity result=WOULD_COMMISSION before=OWNED/DISABLED after=LIVE/ENABLED
event=COMMISSION_PREFLIGHT property=servicesinmycity result=UNCHANGED before=LIVE/ENABLED after=LIVE/ENABLED
event=COMMISSION_PREFLIGHT property=<key> result=REFUSED:<CODE> before=<state or -> after=-
```

It ends with a batch summary:

```
event=COMMISSION_BATCH_RESULT requested=7 eligible=6 unchanged=1 refused=0 written=0 dryRun=true
```

**Any `REFUSED` line refuses the whole batch.** Nothing is written for any property, the valid ones included.
Fix the named key (or remove it from the list) and dry-run again. Refusal codes:

| Code | Meaning |
|---|---|
| `PROPERTY_NOT_IN_ORGANIZATION` | the key is not one of this organization's registered properties: unknown, or owned by another organization. They are deliberately indistinguishable, because cross-organization is not-found. |
| `LIFECYCLE_TRANSITION_REFUSED` | the property cannot go to LIVE directly under the lifecycle state machine (today: RETIRED; move it to OWNED with `set-lifecycle` first if that is really intended). |
| `STATE_UNRECOGNIZED` | the stored state is outside the vocabulary. Investigate; never forced. |
| `CONCURRENT_CHANGE` / `BATCH_ROLLED_BACK` | (real run only) a property changed between preflight and write. The whole transaction rolled back; re-run. |

### 4. Run `commission-live-sites` for real

Dispatch the same inputs with `dry_run: false`. The run:

1. **Validates** the whole batch again, inside the write transaction.
2. **Mutates** in ONE database transaction. Each property's lifecycle and ingestion change together, in one
   write conditional on the state preflight read. A property already LIVE + ENABLED is `UNCHANGED` and not
   rewritten. A crash or a concurrent change rolls back every write.
3. **Reads back** every property afterwards.

It only ever writes lifecycle and ingestion. It never registers, reassigns or moves a property, and never
changes a domain, allowed domains or any binding.

### 5. Verify the read-back

Each property gets one line:

```
event=COMMISSION_READBACK property=careinmycity result=COMMISSIONED after=LIVE/ENABLED ownerUnchanged=true
event=COMMISSION_READBACK property=servicesinmycity result=UNCHANGED after=LIVE/ENABLED ownerUnchanged=true
```

Then the batch line:

```
event=COMMISSION_BATCH_RESULT requested=7 commissioned=6 unchanged=1 refused=0 readbackFailed=0 ownerChanges=0 ownerUnchanged=true dryRun=false
```

- `readbackFailed` must be 0 and `ownerUnchanged=true`.
- A `READBACK_FAILED` line means the database does not show the property as this organization's, LIVE and
  ENABLED. The run then exits red whatever the write reported.
- Re-running the same batch is safe: every entry reports `UNCHANGED`, and nothing is written.

### 6. Deploy web (Netlify)

`GET /api/webhooks/website` returns `tenancy: "registered-property"`. Only LIVE + ENABLED properties' events
are admitted.

### 7. Read Intelligence State

For the organization, confirm:

- `WEBSITE_PROPERTY registered=17` with the lifecycle counts;
- `WEBSITE_PROPERTY_STATE state=LIVE_INGESTING count=<live sites>`;
- `WEBSITE_EVENTS total>0` with a recent `newestAt`;
- `SOURCE_COVERAGE source=WEBSITE_EVENTS coverage=COVERED`;
- the four external sources as `connection=NOT_CONNECTED coverage=GAP_NOT_CONNECTED`. That is correct, because
  LIVE sites exist and nothing is connected yet.

An organization with no LIVE property shows `coverage=NOT_APPLICABLE`. Refusals for unregistered properties
appear only in Netlify function logs (`WEBSITE_INGEST_REFUSED code=PROPERTY_UNREGISTERED`).

### 8. Redeploy the connections worker

This runs the aggregate-window retention step, a no-op on the empty table. It does **not** purge raw website
telemetry. `LOOP_WEBSITE_TELEMETRY_RETENTION` stays unset.

### 9. Verify `website.domain@2` activation, as appropriate

If website readings are commissioned, `LOOP_INTELLIGENCE_PRODUCERS` must name `website.domain@2`, not `@1`,
which no longer exists. `@2` reads Loop's own events only, and names unconnected external sources only when a
LIVE property expects them. It uses the existing `website.domain.reading` task; there is no new AI task.

## Later one-site changes

Use the single-property actions, each its own dispatch (dry run first). They are unchanged:

- `set-lifecycle` (`property_key`, `lifecycle`) moves a site along the lifecycle: BUILDING, LIVE, PAUSED,
  RETIRED. Pausing or retiring disables its ingestion in the same write. Entering LIVE never enables ingestion.
- `enable-ingestion` / `disable-ingestion` (`property_key`) allows or stops a LIVE site's telemetry.

A single newly-live site can also go through `commission-live-sites` with a one-key list. None of these acts
changes which organization owns a property.

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
