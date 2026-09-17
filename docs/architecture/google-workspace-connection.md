# Google Workspace connection — architecture record

**Status:** the Private V1 connection (§11) is **code-complete, NOT deployed** (2026-09-17, branch
`feat/google-workspace-oauth-v1`; §12 records what was built).
- **Not yet done:**
  - no OAuth client exists;
  - no Google account is connected;
  - the migration has not been dispatched;
  - nothing reads Gmail, Calendar or Drive data yet.
- **Google sign-in (§1–§3)** remains a proposal. Connecting is not signing in.
- **What this record defines:** how Loop connects to Google Workspace without the two mistakes that
  make such integrations unsafe.
- **Matt's steps:** `docs/runbooks/google-workspace-oauth.md`.

**The two mistakes, named first, because everything below follows from refusing them:**

1. **Treating authentication as authorization.** "Continue with Google" proves *who someone is*. It must
   never, by itself, grant Loop the right to read their mail, calendar or files. Those are separate,
   later, explicit acts — and a product that bundles them trains people to click past the only moment
   they were asked.
2. **Syncing everything.** A connector that mirrors a mailbox into Loop has copied a decade of
   correspondence into a system with different retention, different access rules and different breach
   consequences. Loop does not need a copy of Gmail. It needs to *reference* the few messages that matter
   to a record somebody is looking at.

---

## 1. Three separate things that are usually conflated

| Concept | What it is | Authority |
|---|---|---|
| **Loop User** | The canonical application principal. Already exists: `User` + `OrganizationMembership`, with role and permissions | Loop |
| **Google identity** | A verified assertion that this person controls this Google account | Google, via OIDC |
| **Connected data source** | A grant to read a specific Google API, for a specific person, at a specific scope, revocable | The person, via OAuth consent |

A Loop User may have a Google identity and no connected source; a connected source and a password login;
or several connected sources. **The three are independent**, and modelling them as one field is how
"sign in with Google" quietly becomes "Loop reads your inbox".

## 2. Employee experience

```
Invitation (Loop, existing)
  → "Continue with Google"                    → identity proven, session created
  → Loop Home                                  → the person is working; nothing is connected
  → Connections (explicit, later, optional)
      → Connect Gmail      → consent → scope granted → status CONNECTED
      → Connect Calendar   → consent → scope granted → status CONNECTED
      → Connect Drive      → consent → scope granted → status CONNECTED
```

Each connection is its own act, separately declinable, separately revocable, and Loop works without any
of them. A person who connects nothing is a fully functional user.

**As built (§12.2), Private V1 puts that choice into employee onboarding:**
```
Invitation accepted (password; Loop identity established)
  → Welcome → Connect Google Workspace       (/app/onboarding/google)
      → Connect Gmail / Calendar / Drive      each its own consent, each shown with its state
      → Continue to Loop  |  Skip for now     both lead to Loop Home; nothing is required
  → later: Home → Connections                 (/app/connections) to add, remove, reconnect or disconnect
```

## 3. Account linking

- **Link on invitation acceptance, never on first sight of an email address.** An invitation already
  proves the organization intended this person. Matching a Google email to an existing User without one
  is account takeover by coincidence of address.
- Store: `googleSubject` (the OIDC `sub`, stable and immutable — **not** the email, which is reassignable
  inside a Workspace), the email at link time as a display value, the linking act's actor and time.
- **One Google subject links to at most one Loop User per organization**, enforced by a unique key.
- **`hd` (hosted domain) claim restriction**: an organization may require that Google identities come
  from its own Workspace domain. Configuration, not a hardcode.
- Unlinking is an audited act that ends the identity link and **revokes every connection** derived from it.

## 4. Scope strategy — minimum, per-purpose, never aspirational

| Purpose | Scope | Why not more |
|---|---|---|
| Identity only | `openid email profile` | Sufficient for sign-in. Requested at sign-in; nothing else is |
| Calendar (meeting intelligence V1) | `calendar.events.readonly` | Loop reads events; it does not create or modify them |
| Gmail (message reference) | `gmail.metadata` first; `gmail.readonly` **only** if a shipped feature needs bodies | Metadata answers "a message exists, from whom, when, on what thread" — enough to place an Activity item without copying content |
| Drive (document reference) | `drive.metadata.readonly`, later `drive.file` for Loop-created files | `drive.readonly` grants the whole Drive. `drive.file` grants only what Loop touched |

**Rule:** a scope is requested when the feature that needs it ships, never in advance. Google's own
verification burden makes over-requesting expensive as well as wrong.

## 5. Sync versus fetch-on-demand

**Default: fetch on demand, reference rather than copy.**

| Data | Approach | Stored in Loop |
|---|---|---|
| Calendar events | Incremental sync (`syncToken`) for the meeting window only | Event id, start/end, organizer, attendee **count**, conference id. Not the description, not the guest list's addresses |
| Gmail messages | On demand, when a person opens the record | Message id, thread id, direction, timestamp. **Never the body** |
| Drive files | On demand | File id, name, owner, modified time. **Never the content** |

An Activity item for any of these is a **reference with an explanation** — exactly `activity.v1`, which
already forbids inline content. Content opens from Google under the viewer's own grant.

## 6. Connection lifecycle

| State | Meaning |
|---|---|
| `NOT_CONNECTED` | No grant. The default, and a permanent legitimate state |
| `CONNECTED` | A valid refresh token; last successful call recorded |
| `EXPIRED` | Refresh failed. Loop stops calling and tells the person; it does **not** retry indefinitely |
| `REVOKED` | Revoked at Google or in Loop. Tokens deleted, not marked |
| `INSUFFICIENT_SCOPE` | The feature needs a scope the person did not grant. Honest, and recoverable by re-consent |

- **Revoke means delete.** Loop calls Google's revocation endpoint *and* deletes the stored token. A
  revoked connection leaves an audit row and no credential.
- **Offboarding:** disabling a Loop User revokes every connection they hold, in the same transaction as
  the membership change. A person who has left must not have a live token pointed at their old employer's
  Loop.

## 7. Token storage and security

- Refresh tokens are **server-only secrets**, encrypted at rest with a key that is not in the database,
  never in `NEXT_PUBLIC_*`, never logged, never echoed in a response, never rendered.
- Scoped to `(organizationId, userId, provider, purpose)` — one token cannot serve another person or
  another organization.
- **A token is never used on behalf of somebody else.** There is no service account that "reads what it
  needs": every call is made with the grant of the person whose data it is.
- Access tokens are held in memory for the life of a request.

## 8. How source permission flows into AI context

This is where a connector usually goes wrong, and where the S0 contracts already have the answer.

- A context block assembled from Google carries `readUnder` — the permission it was read under — and its
  `sourceRef`. The AI context contract already **refuses a package** whose block lacks read authority.
- Gmail and Drive content is `COMMUNICATION_CONTENT`. **No task has a ceiling that high**; Case
  Explanation is `OPERATIONAL` only. So Google content cannot reach a model until a task is approved
  whose ceiling admits it — which is a Product decision with its own privacy review.
- Calendar metadata is `OPERATIONAL`; attendee email addresses are `CONTACT_IDENTIFIER` and are not sent.

## 9. Audit and provenance

Audited acts: identity linked/unlinked, connection granted/revoked/expired, scope changed, first use of
a new scope. Every Google-derived Activity item names its authority (`gmail:<messageId>`,
`calendar:<eventId>`) and the connection it was read through. Audit rows record ids and scopes — **never
a subject line, a body, a file name or an attendee list**.

## 10. Open decisions for Product

1. Is Google the **only** identity provider, or one of several? (Affects whether password login stays.)
2. Is `hd` domain restriction required per organization at launch?
3. Gmail `metadata` or `readonly` — i.e. does any shipped feature need message bodies?
4. Retention for Google-derived references when a connection is revoked: keep the Activity reference
   (it records that something happened) or remove it (the grant is gone)? **Recommendation: keep the
   reference, drop the ability to open it** — the fact that a meeting occurred is Loop's, the content
   never was.

---

## 11. Private V1 OAuth contract (2026-09-17, prepare only)

**Status: IMPLEMENTED IN CODE (§12), NOT DEPLOYED.**
- **Google Cloud (Matt, 2026-09-17):**
  - the project "EMG Loop", External, Testing, with Matt and Charlie as test users;
  - the three APIs enabled and the three scopes configured.
  - **No OAuth client exists yet.**
- **The routes in §11.3** exist in code.
- **The migration for §11.5** exists and has not been dispatched.

**Values.** Where a value is established in code, it is quoted with its source. Where it is not, it is
marked **Matt provides** and nothing is invented.

**Google facts** were re-read on 2026-09-17 from Google's documentation:
- the Gmail, Calendar and Drive scope tables;
- the OAuth 2.0 web-server flow;
- OpenID Connect;
- refresh-token expiry;
- when app verification is not needed.

**How this revises §2.** Matt's Private V1 decision is **one Google connection per Loop user**, covering
Gmail, Calendar and Drive. It keeps §2's principle that each capability is a separate, declinable
consent, by **incremental authorization**:
- there is one connection record and one refresh token per person;
- scopes are added to that grant one capability at a time, when the person turns the capability on;
- a person may grant some capabilities and not others (Google lets a person decline individual
  scopes), and Loop reads the granted set from the token response, never from what it asked for.

### 11.1 Scope of "Private V1"

- **The audience is External (Product decision, 2026-09-17).** Loop must eventually serve people
  outside Elite Media Group's Google Workspace organization.
  - **Nothing in this contract assumes** a user belongs to EMG's Workspace, or to any Workspace.
  - **No hosted domain is required.** An organization may still configure a domain restriction (§3),
    and Private V1 configures none.
- **Private V1 is limited to Matt and Charlie.** The app stays in Google's **Testing** publishing
  status, with their two Google accounts listed as its only test users.
- **What Google says follows from that** (re-read 2026-09-17):
  - an External app in Testing gets refresh tokens that **expire after 7 days** for anything beyond
    basic profile;
  - a Private V1 connection therefore ends every week, shows `EXPIRED` (§11.6), and is reconnected;
  - Testing apps show the unverified-app screen and are capped at 100 users.
- **Going beyond Matt and Charlie means leaving Testing.** The sensitive and restricted scopes below
  then need Google's app verification. That is a separate decision (§11.10), not part of Private V1.
- **The Google Cloud project** does not have to belong to EMG's Workspace. **Matt provides** which
  project hosts the client.
- **Connecting is not signing in.** A person connects Google from inside an existing Loop session.
  Google sign-in is out of scope (§10, question 1).
- **Read-only.** Loop never creates, changes, sends or deletes anything in Google.

### 11.2 Exact scopes

| Capability | Scope (exact) | Google's class | Reads | Why not more |
|---|---|---|---|---|
| Identity (always, first) | `openid`, `email` | non-sensitive | the ID token: `sub`, `email`, `email_verified`, `hd` | `profile` is not needed |
| Calendar | `https://www.googleapis.com/auth/calendar.events.readonly` | sensitive | events on the person's calendars; V1 reads `primary` only | no write scope; `calendar.readonly` also exposes calendar sharing and settings |
| Gmail | `https://www.googleapis.com/auth/gmail.metadata` | restricted | message and thread ids, labels, headers; **never bodies** | `gmail.readonly` returns bodies (open decision §10, question 3) |
| Drive | `https://www.googleapis.com/auth/drive.metadata.readonly` | restricted | file id, name, type, owners, modified time; **never content** | `drive.readonly` returns content. `drive.file` with the Google Picker is the narrower path for a verified release |

- **Restricted scopes are usable in Private V1 only because the app stays in Testing** with two named
  test users.
- **A release beyond them** needs Google's verification. For `gmail.metadata` and
  `drive.metadata.readonly`, that includes Google's additional restricted-scope review, which involves
  a security assessment. The alternative is narrower scopes. Either is a separate decision.
- **What `gmail.metadata` cannot do:** search. Google documents that `messages.list`'s `q` parameter
  "cannot be used when accessing the api using the gmail.metadata scope". V1 finds messages by thread,
  label and date window, never by search text.

### 11.3 Routes and origins

| What | Value | Status |
|---|---|---|
| Production origin | `https://app.emgloop.com` | the canonical fallback in `packages/shared/src/app-origin.ts`. `APP_URL` overrides it. **Matt confirms** production's Netlify `APP_URL` equals it before registering anything |
| Connect start | `GET /api/integrations/google/connect?capability=calendar\|gmail\|drive[&return=onboarding]` | **built**, not deployed |
| Callback (one for all capabilities) | `GET /api/integrations/google/callback` | **built**, not deployed |
| Disconnect, remove one capability | server actions on the Connections page (`apps/web/src/google/actions.ts`) | **built**, not deployed |
| Onboarding step, Connections page | `/app/onboarding/google`, `/app/connections` | **built**, not deployed |
| Authorized redirect URI (production) | `https://app.emgloop.com/api/integrations/google/callback` | register only once the route exists and the origin is confirmed |
| Authorized redirect URI (development) | `http://localhost:3000/api/integrations/google/callback` | a **separate** development OAuth client, never the production one |
| Authorized JavaScript origins | none | the web-server flow needs none. The Google Picker (`drive.file`) would add one later |
| Deploy previews | not registered | Google requires an exact redirect match and allows no wildcards |

### 11.4 The flow

1. **Connect.** The person presses "Connect Calendar" (or Gmail, or Drive). The connect route:
   - resolves the session and requires an active membership (the IAM resource is a decision, §11.9);
   - creates a single-use `state`: random, bound to organization, user and capability, expiring in
     10 minutes, stored hashed server-side;
   - redirects to `https://accounts.google.com/o/oauth2/v2/auth` with:
     - `response_type=code`, `client_id`, `redirect_uri` (exact);
     - `scope` (`openid email` plus the capability's scope);
     - `access_type=offline`, `include_granted_scopes=true`, `prompt=consent`;
     - `state`.

     No `hd` hint is sent. The audience is External, and the person may use any Google account.
2. **Callback.** The callback route:
   1. consumes `state` once and requires the **same session** that created it;
   2. exchanges the code at `https://oauth2.googleapis.com/token`;
   3. **verifies the ID token**: first its RS256 signature, against Google's published signing keys
      (`jwks_uri`, §12.3); then `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud`
      is this client, `exp` has not passed; `email_verified` is true. If the organization has
      configured a domain restriction (§3; none in Private V1), `hd` must match it. An account outside
      any Workspace carries no `hd`, which is allowed when no restriction is configured;
   4. reads the **granted** scopes from the token response;
   5. stores the connection (§11.5).
3. **Upgrade.** Adding a capability repeats step 1 for its scope. `include_granted_scopes=true` returns
   a grant covering everything already granted, and the stored refresh token is replaced. A declined
   scope leaves that capability `INSUFFICIENT_SCOPE`.
4. **Refusals** return the person to Connections with a plain reason, and store nothing:
   - a different Google account from the one already connected (`sub` mismatch);
   - an `hd` outside an organization's configured domain, where one is configured;
   - a replayed or expired `state`;
   - a session mismatch.
5. **PKCE: not used (checked 2026-09-17).** Google's web-server guide documents `state` and the
   client secret for this flow, and does not document `code_challenge` for it. The flow uses:
   - the single-use, session-bound state;
   - the client secret;
   - a **`nonce`**, which Google's OpenID Connect guide lists for replay protection. It is stored
     hashed with the state and must match the ID token's `nonce`.

### 11.5 Storage (needs a migration: not authorized)

- **Why a new table.** `ProviderConnection` is organization-level (unique by organization, category and
  provider) and cannot hold a per-person grant. Proposed:

  | Table `google_connections` | Meaning |
  |---|---|
  | `organizationId`, `userId` | the person, bound to a membership (composite FK, as B4 does) |
  | `googleSubject` | the ID token's `sub`, never the email |
  | `emailAtLink`, `hostedDomain` | display and audit only; `hostedDomain` is null for an account outside any Workspace |
  | `grantedScopes` | exactly what Google granted |
  | `status` | `CONNECTED`, `EXPIRED`, `REVOKED`, `INSUFFICIENT_SCOPE` (per capability, derived from the scopes) |
  | `refreshTokenSealed`, `sealVersion`, `keyRef` | the sealed refresh token; null once revoked |
  | `connectedAt`, `lastUsedAt`, `lastFailureClass`, `revokedAt`, `revokedBy` | lifecycle; failure **classes** only, never Google's text |

  - **Uniqueness:** one connection per `(organizationId, userId)`, and one Loop user per
    `(organizationId, googleSubject)`.
- **Encryption:**
  - AES-256-GCM, the same format and discipline as `AesGcmBrainPayloadSealer`;
  - associated data binds organization, user, Google subject and purpose, so a token copied to
    another row does not open;
  - the key is a **server-only Netlify secret**, versioned through `keyRef`, and never in the database.
- **Access tokens** live in memory for one request.
- **Who holds the key.** Only the web tier. The AWS executor never holds a Google token: Google
  context reaches Brain only through Loop's CONTEXT answer (§11.8).

### 11.6 Revocation, disconnect, offboarding and expiry

- **Disconnect** (the person, or an OWNER/ADMIN for a member), in order:
  1. read the token;
  2. in one transaction, delete the sealed bytes, set `REVOKED`, and write the audit row;
  3. after commit, `POST https://oauth2.googleapis.com/revoke` with the token.

  If Google's revoke call fails, the row records "revocation unconfirmed". Loop no longer holds the
  token, so it cannot use it, and the person can also revoke at their Google account.
- **Offboarding.** Disabling or removing a member runs the same disconnect in the same transaction as
  the membership change, with the revoke call after commit.
- **Expiry.** A refresh failure sets `EXPIRED`. Loop stops calling, tells the person, and retries only
  when the person reconnects.
- **Google invalidates refresh tokens** when:
  - the app is External and in Testing, 7 days after the token was issued (every Private V1
    connection);
  - the person revokes access;
  - a token is unused for six months;
  - the person changes their password (for Gmail scopes);
  - the account exceeds 100 live refresh tokens for this client;
  - an administrator restricts a service.
- **Retention of references after revocation:** §10, question 4. The recommendation stands: keep the
  reference, drop the ability to open it.

### 11.7 Identity mapping and multiple accounts

- **V1 is one Google account per Loop user per organization.** Connecting a different account
  requires disconnecting first.
- **A Google account is never matched to a Loop user by email.** The link is made only by the signed-in
  person completing consent, and recorded by `sub`.
- **Connecting Google establishes nothing about customers.** Email addresses seen in Gmail or Calendar
  are evidence under the identity principle (`identity-evidence-resolution.md`). They never create or
  link a Party by themselves.

### 11.8 Read semantics and provenance

| Source | V1 read | Stored in Loop | Reference form |
|---|---|---|---|
| Calendar | `events.list` on `primary`, a bounded window (`timeMin`/`timeMax`, `singleEvents=true`), incremental with `syncToken` | event id, start/end, organizer, attendee **count**, conference id | `calendar:<eventId>` (§9) |
| Gmail | on demand, when a person opens a record: `threads.list`/`messages.list` by label and date (no `q`), `messages.get` with `format=metadata` | message id, thread id, direction, timestamp; **never subject or body** | `gmail:<messageId>` (§9) |
| Drive | on demand: `files.list` / `files.get` with a field mask of id, name, mimeType, modifiedTime, owners | file id, name, owner, modified time; **never content** | `drive:<fileId>` |

- **Provenance on every read.** Each read is attributed to the connection it used (connection id,
  person, scope), and every Activity item names its source reference.
- **Always the person's own grant.** Every read uses the grant of the person whose data it is. There is
  no service account and no domain-wide delegation.

**How Google data becomes authorized Brain context:**
1. A task's context assembler (`BrainContextAssembler`, `brain-boundary.md` §6.3) may read Google
   **only through the job's principal's own connection**, and only for scopes that person granted.
2. Each block carries its `sourceRef` (the forms above) and `readUnder` (the IAM permission it was read
   under). `validateAiContextPackage` refuses a block without them.
3. **Sensitivity:**
   - Gmail and Drive content is `COMMUNICATION_CONTENT`, and **no task's ceiling admits it today**;
   - Calendar metadata is `OPERATIONAL`;
   - attendee addresses are `CONTACT_IDENTIFIER` and are not sent.

   A task that needs more is a Product decision with its own privacy review.
4. **The executor never receives a Google token,** only the assembled, minimized blocks.

### 11.9 What Matt enters (only when Google work is authorized)

| Where | Setting | Value |
|---|---|---|
| Google Cloud project | which project | **Matt provides**; it need not belong to EMG's Workspace |
| APIs & Services → Library | enable | Gmail API, Google Calendar API, Google Drive API |
| OAuth consent screen / Audience | user type | **External** |
| | publishing status | **Testing** (Private V1) |
| | test users | Matt's and Charlie's Google accounts (**Matt provides**) |
| | app name | `Loop` |
| | support email, developer contact | **Matt provides** (an EMG address) |
| | authorized domain | `emgloop.com` (from the production origin; confirm) |
| | home page, privacy policy, terms URLs | **Matt provides**; none is established in code |
| Data access | scopes | `openid`, `…/auth/userinfo.email` (shown for `email`), `…/auth/calendar.events.readonly`, `…/auth/gmail.metadata`, `…/auth/drive.metadata.readonly` |
| Clients → Create | type | **Web application** |
| | name | `Loop production (Private V1)` |
| | authorized JavaScript origins | none |
| | authorized redirect URIs | `https://app.emgloop.com/api/integrations/google/callback`, **after** the route exists and `APP_URL` is confirmed |
| A second client | name, redirect | `Loop development`, `http://localhost:3000/api/integrations/google/callback` |
| Netlify (production context) | names proposed | `GOOGLE_OAUTH_CLIENT_ID` (not secret), `GOOGLE_OAUTH_CLIENT_SECRET` (**secret**), `LOOP_GOOGLE_TOKEN_KEY` (**secret**: 32 random bytes, base64). A domain restriction, if any, is per-organization configuration (§3), not a deployment variable |

**The client secret is entered only in Netlify.** It is never pasted into chat, a PR, a log or a
repository file, and nobody asks for it.

### 11.10 Before implementation: decisions and prerequisites

1. **The migration** for `google_connections` (§11.5), with its own authorization. **Written:**
   `20260920000000_google_workspace_connections`; not dispatched.
2. **The path beyond Private V1.** The audience is External (decided).
   - **Leaving Testing** means Google's verification, including the restricted-scope review for
     `gmail.metadata` and `drive.metadata.readonly`, or narrower scopes.
   - **Until then,** connections are limited to the test users and expire every 7 days.
3. **The IAM resource** for connecting and reading Google data. **Decided in §12.4:**
   `googleWorkspace`, with its own grant table.
4. **Gmail:** metadata or readonly (§10, question 3).
5. **Retention** of references after revocation (§10, question 4).
6. **The production `APP_URL`,** and the privacy policy and terms URLs.
7. **A Connections surface** in the Loop shell (Track 2), showing each capability's state honestly.
   **Built:** the onboarding step and Connections page (§12.2).

**Suggested PR sequence, each reviewed on its own:**
1. the table and repository (migration);
2. the connect/callback/disconnect routes, the sealing and the offboarding hook, with tests against
   Google's documented responses (no live call);
3. the Connections UI;
4. the Calendar read;
5. Gmail and Drive references.

---

## 12. Implementation: Private V1 (2026-09-17, code-complete, not deployed)

### 12.1 Where it lives

| Layer | File | Holds |
|---|---|---|
| Contract (pure) | `packages/shared/src/google-workspace.ts` | the three capabilities and their exact scopes; the granted-scope allowlist; per-capability states; outcome codes; revocation reasons; audit actions |
| Protocol | `packages/providers/src/google-workspace/oauth.ts` | the authorization URL; code exchange, refresh and revoke (network injected). No environment, no key |
| ID token | `packages/providers/src/google-workspace/id-token.ts` | Google's signing keys (fetched from `jwks_uri`, cached per its headers) and verification: RS256 signature first, then the claims |
| Persistence | `packages/database/src/repositories/google-connection.repository.ts` | attempts and connections, organization-first; audit rows in the same transaction; `revokeGoogleConnectionInTx` for offboarding |
| Sealing | `packages/database/src/services/google/google-token-sealer.ts` over `services/sealing/aes-gcm-sealing.ts` | AES-256-GCM, header `LGT\x01`. The shared core now also serves the Brain checkpoint sealer, byte-for-byte as before |
| Lifecycle | `packages/database/src/services/google/google-workspace.service.ts` | begin, complete, disconnect, remove one capability, access token, finish a revocation; Google, sealer, IAM and clock injected |
| Environment | `apps/web/src/google/google-environment.ts` | the ONLY reader of `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `LOOP_GOOGLE_TOKEN_KEY`; server-only |
| Web wiring | `apps/web/src/google/google-runtime.ts`, `actions.ts`, `app/api/integrations/google/{connect,callback}/route.ts` | the routes and actions; the principal always comes from the signed session |
| UI | `apps/web/src/app/app/_google/google-workspace-panel.tsx`, `app/app/onboarding/google`, `app/app/connections` | one server-component panel, two pages |
| Schema | `google_connections`, `google_oauth_states` (migration `20260920000000_google_workspace_connections`) | as §11.5, with the refinements below |

### 12.2 Onboarding and Connections

- **Onboarding.** Accepting an invitation now lands on `/app/onboarding/google`
  (`postInvitationDestination` in `landing.ts`, the one landing authority).
  - **What the page shows:** each capability with what Loop reads and never reads, its state, and
    its own Connect link.
  - **Moving on:** *Continue to Loop* once all three are connected; *Skip for now* otherwise. Both go
    to Loop Home, and **nothing is required**.
  - **Roles without a connection:** a role that cannot hold a connection (AI Employee) is sent
    straight to Loop Home.
- **Connections.** `/app/connections` (Home → Connections in `LOOP_NAV`, shown only with
  `googleWorkspace:view`) is where a person, at any time, can:
  - add a capability;
  - approve a declined one again, or reconnect an expired one;
  - remove one capability;
  - disconnect Google.
- **Existing members** (onboarded before this) reach the same panel through Connections. No prompt
  is forced on their next sign-in.
- **Each Connect is a plain link** to the connect route for **one** capability, so every Google
  consent screen names exactly one kind of access. No router link is used, so no prefetch can start
  an attempt.

### 12.3 Refinements to §11

- **State and nonce.**
  - **Storage:** `google_oauth_states` stores SHA-256 hashes of both, with organization, user,
    **session row id**, capabilities, return page and a ten-minute expiry.
  - **Consumption:** an attempt is consumed exactly once, and only in the same session.
  - **Limit:** a person may hold ten open attempts.
  - **Offboarding:** revocation drops every open attempt.
  - **Refusals:** connect requests another site initiated (`Sec-Fetch-Site: cross-site`) are
    refused.
- **What is stored is what was granted.** The token response's `scope` is parsed against an
  allowlist:
  - the identity scopes (`openid`, `email`, `…/userinfo.email`);
  - the three capability scopes.

  Anything else refuses the whole grant and stores nothing. A database CHECK admits only the three
  capability scopes in `grantedScopes`/`requestedScopes`.
- **Declined capabilities.**
  - `requestedScopes` accumulates what the person asked for on a live connection.
  - A requested scope that is not granted reads `INSUFFICIENT_SCOPE`.
  - A first attempt that granted no capability at all stores nothing (`DECLINED`).
- **One live link per Google account per organization.**
  - `activeGoogleSubject` equals `googleSubject` while the connection is CONNECTED or EXPIRED, and
    is NULL once REVOKED. It is unique per organization.
  - A different account for the same person is refused (`DIFFERENT_ACCOUNT`), and so is an account
    another member holds (`ACCOUNT_IN_USE`).
  - The repository decides both inside a **serializable** transaction, which also re-reads the
    person's membership standing. A member disabled while their callback was in flight is never
    re-connected. A serialization conflict is retried (at most three attempts).
- **Removing one capability.** Google cannot revoke one scope of a grant. So removal:
  1. revokes and deletes the whole grant (reason `CAPABILITY_REMOVED`);
  2. offers the kept capabilities as one fresh, narrower consent.
- **Expiry.** An access token is obtained per call, in memory.
  - **Google refuses the refresh (`invalid_grant`):** the connection becomes EXPIRED, the sealed
    token is **deleted** (it is known to be dead), and Loop stops calling until the person
    reconnects.
  - **The token cannot be opened** (a rotated key): the same happens, with class `TOKEN_UNOPENABLE`.
  - **A refresh reports fewer scopes:** the stored set follows, with a `scope_changed` audit row.
- **Revocation outcome.**
  - **Revoked:** `revocationConfirmedAt` is set when Google confirms. An already-invalid token counts
    as revoked.
  - **Not confirmed:** `lastFailureClass` records `REVOKE_UNCONFIRMED`, with an audit row.
- **A shared grant is not revoked (architecture issue, see §12.5).** Before calling Google, Loop
  asks, across organizations, whether another live connection holds the same Google account.
  - **If one does,** Loop deletes only its own copy and records `REVOKE_SKIPPED_SHARED_GRANT`.
  - **This is the one cross-organization read** (`liveGrantElsewhere`). It returns only a boolean,
    about the account the caller already holds.
- **Domain restriction (§3).** It is per organization:
  `organizations.settings.googleWorkspace.allowedHostedDomains`, lower-case domains.
  - **Unset, the default:** no restriction; personal Google accounts are allowed.
  - **Set:** the ID token's `hd` must be one of them.
  - **Private V1 sets none,** and no UI edits it yet.
- **Key reference.** `keyRef` is a fingerprint of `LOOP_GOOGLE_TOKEN_KEY` (`google-token/<16 hex>`).
  Rotation makes old tokens unopenable, and they expire as above. There is no dual-key period.
- **The ID token's signature is verified, then its claims** (`packages/providers/src/google-workspace/id-token.ts`).
  Google's OpenID Connect guide says a token received directly from the token endpoint, in an
  exchange authenticated with the client secret, comes from Google -- and also documents the full
  validation, which is what Loop does: the account link rests on `sub`, so it does not rest on the
  transport alone.
  - **The keys are Google's published ones.** The discovery document
    (`accounts.google.com/.well-known/openid-configuration`) names `jwks_uri`
    `https://www.googleapis.com/oauth2/v3/certs`, and lists exactly one
    `id_token_signing_alg_values_supported`: `RS256` (read 2026-09-17).
  - **One algorithm.** The header must say `RS256`. `none`, `HS256` (the "public key as HMAC
    secret" confusion) and every other algorithm are refused before a key is even looked up. A key
    is used only from Google's set -- never one carried in the token's own header -- and only if it
    is an RSA signing key of at least 2048 bits.
  - **Nothing in the payload is read until the signature verifies.** `sub`, `email`, `hd`, the
    nonce and the times are parsed only afterwards; the claim check has no other caller, so there
    is no way to check claims without verifying first.
  - **The claims, unchanged:** `iss`, `aud`/`azp`, `exp`, `iat`; the nonce; `email_verified`;
    `hd` when restricted.
  - **Keys are cached as Google's headers say.** The key set is kept for `max-age` less `Age`
    (`Cache-Control: public, max-age=..., must-revalidate`; ~6.5 hours when read on 2026-09-17),
    capped at a day, and never used stale. A `kid` the cached set does not hold means Google may
    have rotated, so the set is fetched again -- at most once a minute, so invented key ids cannot
    become a stream of requests to Google. One key set per server instance serves every request.
  - **Fail closed.** A network failure, a timeout, a non-200, an unreadable key set, an unknown
    `kid` or a bad signature each refuse the connection (`KEYS_UNAVAILABLE`, `UNKNOWN_KEY`,
    `SIGNATURE`, `ALGORITHM`), and nothing is stored. Before the code is exchanged the service
    checks that the keys are in hand, so an unreachable key set costs Google no grant. No token,
    key-set body or error text appears in a result, a log or a thrown error.

### 12.4 Authority

`googleWorkspace` has its own grant table, `GOOGLE_WORKSPACE_GRANTS`, like `identityResolution`,
with no READ_ONLY fallback:

| Role | view (my connection) | update (connect, remove, disconnect: my own) | manage (another member's) |
|---|---|---|---|
| OWNER, ADMIN | yes | yes | yes |
| MANAGER, EMPLOYEE, READ_ONLY | yes | yes | no |
| AI_EMPLOYEE, unknown roles | no | no | no |

- **AI Employees:** `can()` and `canEach()` deny `AI_EMPLOYEE` whatever a Permission row says.
- **`manage` is literal:** it does not imply the other actions.
- **Offboarding is not a separate permission.** Disabling or removing a member
  (`IamRepository.disableMember` / `removeMember`, under `users:update` / `users:delete`) revokes the
  member's connection in the same transaction. The Team actions ask Google to revoke once that has
  committed.
- **No admin screen acts on another member's connection yet.** `manage` is granted, but nothing
  offers it.
- **Brain roles:** the restricted Brain database roles hold no privilege on either table (checked
  on PostgreSQL 18).

### 12.5 Issues found

1. **Shared grants.**
   - Google issues one grant per Google account per OAuth client, and Loop is one client for every
     organization.
   - The same Google account linked in two organizations therefore shares a grant, and revoking it
     for one would end the other.
   - Loop protects the other connection (§12.3), at the cost of leaving the grant at Google until
     its last holder disconnects.
   - This is inferred from Google's documented behaviour and not tested live.
   - Alternatives: one link per Google account across all of Loop, or one OAuth client per
     organization. Both are product decisions.
2. **Testing-mode expiry.** Private V1 refresh tokens expire after 7 days (§11.1), so every
   connection turns Expired weekly until the app is published.
3. **Reads are not built.** No code reads Gmail, Calendar or Drive yet.
   - Google's verification requires demonstrating each scope, so the read PRs must precede
     publishing.
   - The first read will also be the first caller of `accessToken`.
4. **No dual-key rotation.** Rotating `LOOP_GOOGLE_TOKEN_KEY` expires every connection.
5. **A refusal after the exchange leaves Google's grant in place.** If the ID token is refused
   (wrong domain, unverified email, a signature that does not verify) the code has already been
   exchanged, so Google holds a grant Loop stored nothing for. Loop does not revoke it, because
   `include_granted_scopes` means that grant may be the one another connection to the same Google
   account is using (issue 1). The person simply reconnects. The one case this avoids entirely is
   an unreachable key set: the code is not exchanged at all.
6. **Test-renderer warning.** The panel's server-action forms render with a React warning under
   the test renderer (React 18.3), not under Next's bundled React. It has no product effect.

### 12.6 What remains

1. **Matt:** merge; dispatch the migration; create the OAuth client and set the Netlify variables
   (runbook §1–§3); connect as Matt and Charlie (runbook §4).
2. **The first read** (Calendar, §11.8), with its own review; then Gmail and Drive references.
3. **An admin view** of members' connection states, and an admin disconnect (`manage`), if wanted.
4. **A UI** for the per-organization domain restriction, if any organization needs one.
5. **Google verification and publishing** (runbook §6): brand, sensitive and restricted-scope
   review, CASA assessment, annual reassessment.
