# TikTok One / API for Business app registration

This flow is separate from TikTok Developers Login Kit. It handles the two redirect callbacks,
exchanges `auth_code` server-side and stores an encrypted grant scoped to the signed-in member.
Authorization is not a content sync: this work does not import thumbnails, generate creator
analytics, create campaigns, send invitations, publish posts or manage advertisements/payments.
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
