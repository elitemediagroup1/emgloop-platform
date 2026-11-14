# TikTok One / API for Business app registration

This flow is separate from TikTok Developers Login Kit. It handles the two redirect callbacks,
exchanges `auth_code` server-side and stores an encrypted grant scoped to the signed-in member.
The agency grant supports bounded public creator snapshots (profile image, latest ten video
thumbnails/links and public metrics). It does not create campaigns, send invitations, publish
posts or manage advertisements/payments. Private creator analytics and rotating-token refresh
remain separate and are not enabled by this public importer.
Private creator access still requires the creator's own consent. Public TTO media endpoints require
an authorized TTO account and a creator on the marketplace; an arbitrary public handle is not enough.

## Production order (Matt performs merges, migrations and configuration)

1. Merge the reviewed PR. Run **Deploy Prisma Migrations** for Production/main. New migration:
   `20261113223000_tiktok_business_connect`. Netlify builds generate clients but never apply migrations.
2. Wait for a green deployment of that merged commit. Verify both public callback routes return a
   safe redirect without a session/code. A blank callback must not create a connection.
3. In the TikTok Business app form register exactly:

   - Advertiser redirect URL: `https://app.emgloop.com/api/integrations/tiktok-business/callback`
   - TikTok account holder redirect URL: `https://app.emgloop.com/api/integrations/tiktok-business/creator-callback`

   Keep the uploaded EMG logo. Request only Read TikTok One account, Creator user and Creator media.
   Do not request advertising write, payment, campaign invitation or publishing permissions.
4. Submit for TikTok review. No access token is needed to submit the application. TikTok approval
   is a separate prerequisite from a green Loop deployment.
5. After TikTok makes this app's ID, secret and generated authorization URLs available, add these
   **server-only Production / Functions** Netlify variables; never paste a secret into chat:

   | Variable | Value |
   | --- | --- |
   | `TIKTOK_BUSINESS_APP_ID` | This API for Business app's numeric ID |
   | `TIKTOK_BUSINESS_APP_SECRET` | This app's secret, entered privately |
   | `LOOP_TIKTOK_BUSINESS_TOKEN_KEY` | A new random 32-byte key, base64; do not replace the Login Kit key |
   | `TIKTOK_BUSINESS_TTO_AUTHORIZATION_URL` | Generated Advertiser authorization URL from this app's My Apps page |
   | `TIKTOK_BUSINESS_CREATOR_AUTHORIZATION_URL` | Generated TikTok account holder authorization URL from this app's My Apps page |

   Each authorization URL must identify the same app. Preserve TikTok's generated path/scope settings.
   Loop replaces only state and redirect_uri; never save a URL containing an authorization code or token.
   Redeploy after setting variables. Leave a flow unconfigured rather than inventing a generated URL.
6. As an authorized administrator, open Integration OS → TikTok One setup, or
   `/app/integrations/tiktok-business`. Start **Authorize with TikTok** FROM LOOP so a single-use state
   is recorded in this browser session. Do not open a static consent URL directly to connect.
7. Check the consenting TikTok account is EMG's intended TTO account. Complete TikTok consent manually.
   The Loop page must show authorization connected. This is not proof of media import or analytics.
   For optional creator authorization the same settings URL resolves the logged-in creator's own seat.
8. Verify replay, wrong-session callback and declined consent leave grants unchanged. Disconnect deletes
   local credentials and pending states; remove the app in TikTok settings too, since this setup does
   not claim provider-side revocation. Disabling, removing or changing the member's role clears local grants.

## Security and limits

- Ten-minute state, SHA-256 at rest, session/org/user/kind binding, one-use atomic claim.
- A creator's profile is resolved from the active membership; it is never supplied in a URL/form.
- Token persistence rechecks authority and revision after the external exchange; disconnect during
  the request invalidates the pending grant. Serializable transactions protect account binding races.
- Only OWNER/ADMIN members without explicit view/update denies may connect the TTO flow.
- No provider error text, authorization code, secret or access token is rendered or logged by these handlers.
- Existing Login Kit tokens and callbacks are untouched. Business credentials never overwrite them.
- No grant-consuming media pipeline or token refresh worker is enabled by this registration work.

Official references: TikTok API for Business “Authorization”, “Comparing authorization for different APIs”,
“Obtain a short-term access token”, and “Get TTO Public Media Insights”. Use the app-specific generated
consent URLs because TikTok operates multiple authorization products.


## Public creator imports

Migration `20261114010000_tto_creator_media` adds one replaceable, org-scoped snapshot per creator,
source revision, request lease and retry state. Matt runs the migration manually after merging.
No new environment variables or AI spending are required. The existing agency grant remains sealed.

Verify these read permissions on the approved Business app (and reauthorize if TikTok requires it):

- `/tto/oauth2/tcm/` — authorized marketplace account IDs.
- `/tto/tcm/creator/public/` — exact-handle public profile insights.
- `/tto/tcm/creator/public/video/list/` — bounded latest public videos.

On **Connections → TikTok One** (`/app/integrations/tiktok-business`), select the authorized
marketplace source if there is more than one. A sole authorized account can be selected automatically
by the first import; no arbitrary account is guessed. Check each creator's exact declared TikTok
handle, then **Update content**. A report requires successful, validated responses from both insight
endpoints. An unavailable report is not evidence of zero followers or no activity.

Creator profile saves (including staff preloads) attempt an import. The existing creator **Refresh**
button updates public content as well as requesting Gmail updates. A two-minute fence applies to
manual requests. Success becomes due again after six hours; failures back off 15 minutes or one hour.
`netlify/functions/tto-creator-sync.mts` runs every ten minutes on the published production deploy,
processing at most one actual provider import per run. Deploy previews do not run automatically.
This schedule is for public content, not the separate 7 AM Eastern Gmail intelligence schedule.

The Creator Hub displays official thumbnails as remote images linked to actual videos, the provider's
public follower/median view counts when available, and the last-read time. Missing counts remain
unknown. Data older than six hours is marked pending refresh; after 24 hours it is withheld.
No video/image bytes are downloaded or rehosted. Reviewed static Trevon imagery remains a fallback.
These imports do not create campaign, deal, earnings or Gmail intelligence records.

Disconnecting, disabling/removing the source owner, changing the handle, changing source revision,
explicit permission denial or duplicate creator handles prevents publication/read access. Disconnect
and member lifecycle actions also delete stored snapshots. Handle or source changes clear the old
report before new evidence can be published. Cross-org composite foreign keys prevent a snapshot
from referencing another tenant's profile or grant. Serializable transactions and leases fence
concurrent refresh and mid-request revocation.

### Live acceptance (not established by tests or a green build)

1. Confirm the migration workflow and merged production deploy are green.
2. On the TikTok One connection page, verify authorized account IDs can be read. Do not copy tokens.
3. Update Trevon's exact declared handle, run **Update content**, and inspect the safe result.
4. Verify actual thumbnail images and video links against TikTok. Check follower count source and
   read time; no synthetic values or unrelated creator content may appear.
5. Sign in as Trevon and use **Refresh**. Verify it can only update his own profile.
6. Check the Netlify scheduled function's execution and sanitized result after deployment. Do not
   mark automated updates working until a real invocation persists a report.
7. If TikTok withholds a marketplace report, resolve app permissions/marketplace eligibility; do
   not substitute scraped images or another creator's report.
