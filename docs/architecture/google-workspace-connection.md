# Google Workspace connection — architecture record

**Status:** PROPOSED (2026-09-16). The Private V1 OAuth contract was added on 2026-09-17 (§11).
- **Nothing here is implemented.** No OAuth client exists, no Google account is connected, and no scope
  has been requested.
- **What this record defines:** how Loop would connect to Google Workspace without the two mistakes that
  make such integrations unsafe.

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

**Status: A CONTRACT, NOT AN IMPLEMENTATION.**
- No OAuth client, secret, consent screen, API enablement or Google Cloud change exists or was made.
- No route in §11.3 exists in code.
- No migration exists for §11.5.

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
| Connect start | `GET /api/integrations/google/connect?capability=calendar\|gmail\|drive` | **proposed**, not built |
| Callback (one for all capabilities) | `GET /api/integrations/google/callback` | **proposed**, not built |
| Disconnect | a server action on the person's Connections page | **proposed**, not built |
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
   3. **verifies the ID token**: `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud`
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
5. **PKCE.** Google's web-server guide documents `state`, and the client secret authenticates the
   exchange. Whether to add PKCE (S256) on top is an implementation check against Google's current
   documentation, not an assumption.

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

1. **The migration** for `google_connections` (§11.5), with its own authorization.
2. **The path beyond Private V1.** The audience is External (decided).
   - **Leaving Testing** means Google's verification, including the restricted-scope review for
     `gmail.metadata` and `drive.metadata.readonly`, or narrower scopes.
   - **Until then,** connections are limited to the test users and expire every 7 days.
3. **The IAM resource** for connecting and reading Google data (e.g. a new `googleWorkspace` resource
   with `view` and `manage`): a permissions-matrix change.
4. **Gmail:** metadata or readonly (§10, question 3).
5. **Retention** of references after revocation (§10, question 4).
6. **The production `APP_URL`,** and the privacy policy and terms URLs.
7. **A Connections surface** in the Loop shell (Track 2), showing each capability's state honestly.

**Suggested PR sequence, each reviewed on its own:**
1. the table and repository (migration);
2. the connect/callback/disconnect routes, the sealing and the offboarding hook, with tests against
   Google's documented responses (no live call);
3. the Connections UI;
4. the Calendar read;
5. Gmail and Drive references.
