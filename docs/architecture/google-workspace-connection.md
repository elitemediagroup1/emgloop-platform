# Google Workspace connection — architecture record

**Status:** PROPOSED (2026-09-16). **Nothing here is implemented.** No OAuth client exists, no Google
account is connected, no scope has been requested. This record defines how Loop would connect to Google
Workspace without the two mistakes that make such integrations unsafe.

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
