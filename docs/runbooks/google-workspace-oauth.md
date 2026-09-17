# Runbook: Google Workspace connection (Private V1)

**Status (2026-09-17): code-complete in the branch `feat/google-workspace-oauth-v1`, NOT deployed.**
- **No OAuth client exists yet**, and no Google account has been connected.
- **The migration** `20260920000000_google_workspace_connections` exists and has **not** been
  dispatched.

**Where the design lives:** `docs/architecture/google-workspace-connection.md`, especially §11 and
§12.

**Who does what:** Matt does everything below, in GitHub, Google Cloud and Netlify. Claude has no
access to any of them.

**Rules:**
- **The client secret and the token key** are typed only into Netlify. They never go into chat, a
  pull request, a ticket, a log or a file.
- **Only the three approved data scopes are ever configured:**
  - `gmail.metadata`
  - `calendar.events.readonly`
  - `drive.metadata.readonly`

  The code refuses a grant that contains anything else. The database refuses to record one.
- **The callback needs outbound access to Google.** Besides the token endpoint, it fetches Google's
  published signing keys (`https://www.googleapis.com/oauth2/v3/certs`) to verify the ID token's
  signature, and caches them for as long as Google's headers allow. If those keys cannot be
  fetched, a connect attempt fails rather than trusting the token: nothing to configure, but it is
  why a connect can fail with "Google could not complete this" while Google itself is reachable.
- **Private V1 stays in Testing.** Matt and Charlie are Google's test users. That is a Google limit
  for this phase, not a property of the product.

---

## 1. Merge, then migrate

1. **Review and merge the pull request.**
2. **Apply the migration.** It is additive: two new tables, no change to any existing row. Run
   **GitHub → Actions → Deploy Prisma Migrations → Run workflow** on `main`. Afterwards, its
   "Print migration status" step must show **37** migrations and nothing pending.
3. **Until the migration runs, do not set the Google variables (§3).** The routes would fail to
   store, and the Connections page would fail to read.

## 2. Google Cloud (project "EMG Loop")

### 2.1 Google Auth Platform (already set up; confirm)

| Setting | Value |
|---|---|
| Audience → user type | **External** |
| Audience → publishing status | **Testing** |
| Audience → test users | Matt's and Charlie's Google accounts |
| Branding → app name | `Loop` (or the name the consent screen should show) |
| Branding → support email, developer contact | an EMG address |
| Branding → authorized domain | `emgloop.com` |
| Branding → home page, privacy policy, terms | URLs on `emgloop.com` (required before §6) |
| Data access → scopes | `openid`<br>`…/auth/userinfo.email`<br>`…/auth/gmail.metadata`<br>`…/auth/calendar.events.readonly`<br>`…/auth/drive.metadata.readonly`<br>**nothing else** |
| APIs & Services → Library | Gmail API, Google Calendar API, Google Drive API: enabled |

### 2.2 The production client

**Clients → Create client:**

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | `Loop production (Private V1)` |
| Authorized JavaScript origins | **none** |
| Authorized redirect URIs | **`https://app.emgloop.com/api/integrations/google/callback`** (exactly; Google matches it character for character) |

- **Before registering:** confirm production's Netlify `APP_URL` is `https://app.emgloop.com`, or
  unset. The code builds the redirect URI from `APP_URL` (falling back to that origin) plus
  `/api/integrations/google/callback`, so the two must agree.
- **Save the client ID and client secret** straight into Netlify (§3). Do not paste them anywhere
  else.

### 2.3 A separate development client (optional)

| Field | Value |
|---|---|
| Name | `Loop development` |
| Authorized redirect URIs | `http://localhost:3000/api/integrations/google/callback` |

- **Local use:** it is used only with `APP_URL=http://localhost:3000` in a local `.env`, which is
  never committed.
- **Never add localhost to the production client.**
- **Deploy previews are not registered:** Google allows no wildcards, and a preview's origin
  changes.

## 3. Netlify environment (production context only)

| Variable | Value | Secret? |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | the production client's ID (`….apps.googleusercontent.com`) | no |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the production client's secret | **yes**: mark it secret |
| `LOOP_GOOGLE_TOKEN_KEY` | 32 random bytes, base64 (below) | **yes**: mark it secret |
| `APP_URL` | `https://app.emgloop.com` (confirm; do not change if already set) | no |

- **Scope all three Google variables to the Production context only.** A deploy preview then shows
  "Google connections are not available yet" instead of sending people through a redirect URI
  that is not its own.
- **Generate the token key** on your own machine, and paste the output straight into Netlify:

  ```sh
  openssl rand -base64 32
  ```

- **The code refuses a partial or malformed configuration:**
  - a client ID that is not `*.apps.googleusercontent.com`;
  - a key that is not exactly 32 bytes;
  - a non-https `APP_URL`.

  It then treats Google as not configured and stores nothing.
- **Redeploy** after setting them. Netlify reads variables at build and start.

**Nothing else is needed:**
- no Google variable is `NEXT_PUBLIC_`;
- there is no service account;
- there is no domain-wide delegation.

**The `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` names** in `integration-catalog.ts` belong to the
*planned* Analytics/Ads integrations. They are not used by this connection. This connection reads
the three names above, and only in `apps/web/src/google/google-environment.ts`.

## 4. First connection (Matt, then Charlie)

1. **Sign in** to `https://app.emgloop.com` and open **Home → Connections**.
2. **Connect each capability in turn:** press **Connect Gmail** and approve on Google's screen,
   then repeat for **Calendar** and **Drive**. Each shows **Connected**.
   - **Unverified-app screen:** Google shows its "Google hasn't verified this app" screen while the
     app is in Testing. That is expected for test users.
   - **Declining:** unticking a permission on Google's screen leaves that capability **Access not
     allowed**, which is honest and recoverable.
3. **Check the records:**
   - **Audit Log:** one `google.connection.granted` row, then `google.connection.scope_changed`
     rows. They carry ids and capability names only.
   - **No reads yet:** nothing reads Gmail, Calendar or Drive data. The first reader is a later,
     separately reviewed PR.
4. **Testing-mode expiry:** refresh tokens of an External app in Testing expire **7 days** after
   issue. After that, the next read will mark the connection **Expired**, and the person presses
   **Reconnect** on Connections.
5. **New employees:** an invited employee who accepts their invitation lands on
   **Welcome → Connect Google Workspace**. They can connect, or choose **Skip for now**. While the
   app is in Testing, only listed test users can complete Google's screen; anyone else is refused
   by Google, stores nothing, and continues to Loop.

## 5. Revocation, offboarding and key rotation

- **A person disconnects:** Connections → **Disconnect Google**.
  1. Loop deletes its sealed token and marks the connection revoked, with an audit row, in one
     transaction.
  2. It then calls Google's revoke endpoint.
  3. If Google does not confirm, the page says so, the connection records `REVOKE_UNCONFIRMED`,
     and the person can also remove Loop from their Google Account's third-party access.
- **A person removes one capability:** Connections → **Remove Gmail** (for example).
  1. Google cannot revoke one scope of a grant, so Loop revokes the whole grant.
  2. The page then offers **Continue to Google** to approve the capabilities kept, as a fresh,
     narrower consent.
- **An administrator disables or removes a member** (Team page):
  1. The member's Google connection is revoked in the same transaction as the membership change.
  2. Google is asked to revoke it after that commits.
- **One Google account in two organizations:** it has one grant to Loop. Revoking at Google would
  also end the other organization's connection, so Loop deletes only its own copy and records
  `REVOKE_SKIPPED_SHARED_GRANT`.
- **Rotating `LOOP_GOOGLE_TOKEN_KEY`:**
  1. Set a new value and redeploy.
  2. Every stored token becomes unopenable. On first use the connection turns **Expired** (class
     `TOKEN_UNOPENABLE`), and each person reconnects.
  3. There is no dual-key period in Private V1.
- **If the client secret leaks:**
  1. Rotate it in Google Cloud and update Netlify.
  2. Existing refresh tokens stay valid for the same client.
- **If the token key leaks:** rotate it, as above. Every connection must be reconnected.
- **Kill switch:** removing any of the three variables and redeploying stops all connecting and all
  token use, immediately. Stored tokens stay sealed and unused.

## 6. Leaving Testing: what has to be true first

Google must verify the app before anyone other than the listed test users can connect.

**Scope classes:**
- `calendar.events.readonly` is **sensitive**;
- `gmail.metadata` and `drive.metadata.readonly` are **restricted**.

**Requirements** (Google's production-readiness guides, read 2026-09-17):

1. **Brand verification.**
   - Verified ownership of `emgloop.com` in Google Search Console.
   - A public home page on that domain describing Loop.
   - A privacy policy on the same domain, linked from the consent screen.
   - App name, logo, support email and developer contact.
2. **Sensitive-scope verification** (Calendar).
   - A written justification of `calendar.events.readonly`, and why a narrower scope is not enough.
   - A demonstration video showing a person granting the scope and how Loop uses it.
   - Google's guide gives 3–5 business days.
3. **Restricted-scope verification** (Gmail, Drive).
   - The same justification and video.
   - A privacy policy that complies with the **Google API Services User Data Policy, including the
     Limited Use requirements**.
   - A **security assessment** by an App Defense Alliance (CASA) assessor, because Loop's servers
     access the data.
   - **Re-assessment at least every 12 months.**
   - Google's guide says the whole process can take several weeks. Assessment fees are set by the
     assessor, not stated by Google.
4. **The product must actually use each scope** before it is submitted: Google rejects scopes an app
   cannot demonstrate.
   - Today no code reads Gmail, Calendar or Drive.
   - The read PRs (§12.6 of the architecture record) come first.
5. **The alternative to restricted-scope review** is narrower scopes, which is a product change and
   a new review of this design:
   - Gmail: none that suits message references;
   - Drive: `drive.file` with the Google Picker.
6. **Then switch Audience → publishing status to "In production".**
   - Refresh tokens stop expiring after 7 days.
   - The 100-user cap for unverified apps no longer applies.
   - Each organization may still restrict Google accounts to its own Workspace domains (§12.3 of
     the architecture record).

Do not publish the app, or request scopes beyond the three, without a reviewed decision.
