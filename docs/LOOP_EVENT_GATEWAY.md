# Loop Event Gateway

## Purpose

The Loop Event Gateway is the single inbound entry point for events produced by
all InMyCity properties and future EMG properties. It lets producer sites report
things that happen on their side (profile views, claims, form submissions, etc.)
into EMG Loop.

Producers include:

- ArtistsInMyCity
- CarsInMyCity
- FoodInMyCity
- PetsInMyCity
- CareInMyCity
- ServicesInMyCity
- future EMG properties

**Scope (PR #80):** this endpoint only **receives, authenticates, validates,
deduplicates, and stores** raw events. It does NOT connect Brain, create Work OS
items, mutate the CRM or Marketplace, send outbound webhooks, email, or Slack.
Downstream processing is intentionally out of scope and handled by later PRs.

## Endpoint

```
POST /api/v1/events
```

Method: **POST only.** Other methods return `405`.
Body: **JSON only** (`Content-Type: application/json`).

## Required environment variable (Loop side)

| Variable | Description |
| --- | --- |
| `LOOP_EVENT_SECRET` | Shared secret. The gateway compares the `x-emg-loop-secret` request header against this value. |

## Producer environment variables (each InMyCity site)

| Variable | Value |
| --- | --- |
| `EMG_LOOP_WEBHOOK_URL` | `https://app.emgloop.com/api/v1/events` |
| `EMG_LOOP_WEBHOOK_SECRET` | Same value as Loop's `LOOP_EVENT_SECRET` |

## Headers

| Header | Required | Notes |
| --- | --- | --- |
| `content-type` | yes | Must be `application/json`. |
| `x-emg-loop-secret` | yes | Must equal `LOOP_EVENT_SECRET`. |

## Event envelope

```json
{
  "eventId": "evt_...",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "artist.claimed_profile",
  "occurredAt": "2026-07-08T18:15:11.000Z",
  "anonymousId": "anon_...",
  "userId": null,
  "sessionId": "sess_...",
  "pageUrl": "https://artistsinmycity.com/...",
  "referrer": "...",
  "payload": {},
  "metadata": {}
}
```

**Required:** `eventId`, `platform`, `eventType`, `occurredAt`, `payload`.
**Optional:** `site`, `anonymousId`, `userId`, `sessionId`, `pageUrl`,
`referrer`, `metadata`.

Validation rules:

- `eventId`, `platform`, `eventType` must be non-empty strings.
- `occurredAt` must parse as a valid date.
- `payload` must be an object and is size-capped (64 KB).
- `metadata` must be an object if provided.
- Invalid JSON returns a JSON `bad_request` error.

## Responses

Success (stored):

```json
{ "ok": true, "eventId": "...", "stored": true }
```

Duplicate (eventId already stored):

```json
{ "ok": true, "eventId": "...", "duplicate": true }
```

Unauthorized (missing/wrong secret) — HTTP 401:

```json
{ "ok": false, "error": "unauthorized" }
```

Bad request — HTTP 400:

```json
{ "ok": false, "error": "bad_request", "message": "..." }
```

## Example curl

```bash
curl -X POST "https://app.emgloop.com/api/v1/events" \
  -H "content-type: application/json" \
  -H "x-emg-loop-secret: $EMG_LOOP_WEBHOOK_SECRET" \
  -d '{
    "eventId": "evt_01HZX8Q",
    "platform": "artistsinmycity",
    "site": "artistsinmycity.com",
    "eventType": "artist.claimed_profile",
    "occurredAt": "2026-07-08T18:15:11.000Z",
    "anonymousId": "anon_abc123",
    "sessionId": "sess_xyz789",
    "pageUrl": "https://artistsinmycity.com/artist/jane-doe",
    "payload": { "artistId": "art_123", "slug": "jane-doe" },
    "metadata": { "source": "claim-flow" }
  }'
```

## Example ArtistsInMyCity payloads

### artist.profile_viewed

```json
{
  "eventId": "evt_view_01",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "artist.profile_viewed",
  "occurredAt": "2026-07-08T18:15:11.000Z",
  "anonymousId": "anon_abc123",
  "pageUrl": "https://artistsinmycity.com/artist/jane-doe",
  "payload": { "artistId": "art_123", "slug": "jane-doe" },
  "metadata": {}
}
```

### artist.claimed_profile

```json
{
  "eventId": "evt_claim_01",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "artist.claimed_profile",
  "occurredAt": "2026-07-08T18:16:00.000Z",
  "userId": "user_555",
  "payload": { "artistId": "art_123", "claimMethod": "email" },
  "metadata": {}
}
```

### artist.submitted_music

```json
{
  "eventId": "evt_music_01",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "artist.submitted_music",
  "occurredAt": "2026-07-08T18:20:00.000Z",
  "userId": "user_555",
  "payload": { "artistId": "art_123", "trackId": "trk_789", "format": "mp3" },
  "metadata": {}
}
```

### fan.signup_started

```json
{
  "eventId": "evt_signup_01",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "fan.signup_started",
  "occurredAt": "2026-07-08T18:25:00.000Z",
  "anonymousId": "anon_fan_001",
  "pageUrl": "https://artistsinmycity.com/signup",
  "payload": { "referrerArtistId": "art_123" },
  "metadata": {}
}
```

### contact.form_submitted

```json
{
  "eventId": "evt_contact_01",
  "platform": "artistsinmycity",
  "site": "artistsinmycity.com",
  "eventType": "contact.form_submitted",
  "occurredAt": "2026-07-08T18:30:00.000Z",
  "anonymousId": "anon_abc123",
  "pageUrl": "https://artistsinmycity.com/contact",
  "payload": { "subject": "Booking question", "hasMessage": true },
  "metadata": {}
}
```

## Netlify setup for ArtistsInMyCity

In the ArtistsInMyCity Netlify project, set the following environment variables
(Site configuration → Environment variables):

| Key | Value |
| --- | --- |
| `EMG_LOOP_WEBHOOK_URL` | `https://app.emgloop.com/api/v1/events` |
| `EMG_LOOP_WEBHOOK_SECRET` | (same value as Loop's `LOOP_EVENT_SECRET`) |

The producer site sends each event as a JSON POST to `EMG_LOOP_WEBHOOK_URL` with
the `x-emg-loop-secret` header set to `EMG_LOOP_WEBHOOK_SECRET`.

## Migration / deploy note

This PR adds a Prisma model (`LoopEvent` → `loop_events`) and a migration.
**Do not merge or deploy until the Prisma migration recovery / baseline strategy
(see `docs/runbooks/prisma-baseline-recovery.md`) is completed on production.**
Production currently has no `_prisma_migrations` table, so `migrate deploy` must
not run against it until baselining is done. Deploying this schema change before
that is resolved risks migration drift.
