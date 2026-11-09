# Creator YouTube analytics

## Google Cloud setup

Use the dedicated **EMG Loop YouTube** Google Cloud project and a Web application OAuth client. Do not reuse the staff Google Workspace OAuth client.

Register this exact authorized redirect URI:

`https://app.emgloop.com/api/integrations/youtube/callback`

Enable YouTube Data API v3 and YouTube Analytics API. The creator OAuth request asks only for:

- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/yt-analytics.readonly`

The OAuth app can remain in Testing for the pilot, but every Google account that authorizes must be listed in Audience → Test users. Google may expire refresh tokens issued while the app is in Testing after seven days; creators may need to reconnect during the pilot.

## Production configuration

Set these variables in Netlify's **Production** context for `emgloop2`:

| Variable | Secret | Purpose |
| --- | --- | --- |
| `YOUTUBE_CLIENT_ID` | No | Dedicated YouTube OAuth Web client ID |
| `YOUTUBE_CLIENT_SECRET` | Yes | Dedicated YouTube OAuth client secret |
| `LOOP_YOUTUBE_TOKEN_KEY` | Yes | 32 random bytes, base64 encoded; seals refresh tokens at rest |

Generate the sealing key with `openssl rand -base64 32`. Never commit it, expose it to a browser variable, or send it in chat. The feature is unavailable when any setting is missing or invalid.

## Data handling

OAuth state is stored hashed, expires after ten minutes, and is bound to the same creator, organization, user, and signed-in session that began the flow. The refresh token is AES-256-GCM sealed with the organization and user as authenticated data. Access tokens are held only in memory during API requests. The connection is stored separately from staff Google Workspace and Meta.

After connection, a creator can explicitly refresh a rolling 28-day YouTube Analytics report from Profile. The report is stored as an append-only observation; repeated windows are not added together. Disconnect removes Loop's saved refresh token and stops future reads. The creator can revoke Google's grant separately in their Google Account settings.

## Deployment

Merge the application code and apply the Prisma migration `20261109160000_creator_youtube_analytics` before using the connection. Then verify the creator profile page on the production app using an account listed as a Google OAuth test user. A successful OAuth callback is not itself proof that the YouTube Analytics API returned data; use the page's refresh action and confirm the reported period and metrics.
