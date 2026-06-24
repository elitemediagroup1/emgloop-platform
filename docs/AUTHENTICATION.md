# Authentication

Sprint 2 establishes the **authentication foundation only**. No production auth
flows are implemented. The goal is an architecture that is provider-agnostic and
ready for enterprise scale (multi-org, invitations, password reset, and future
SSO) without rework.

## Principles

1. **Provider-agnostic.** Auth is reached through an interface, not a vendor.
   The host can use a managed provider (e.g. Clerk, Auth0, WorkOS, Supabase
   Auth, Cognito) or a self-hosted stack. No vendor name appears in business
   logic. The chosen provider must support future enterprise SSO.
2. **Organization-scoped identity.** Every user belongs to an organization;
   identity is always tenant-aware.
3. **No raw secrets.** Passwords and tokens are never stored raw — only hashed
   or opaque references managed by the auth provider/host. The platform stores
   session and reset *metadata*, not credentials.
4. **Accounts created by users, not by the platform.** The system issues
   invitations; users complete account creation and set their own passwords.
   SSO/OAuth flows are user-initiated.

## What the Foundation Supports

- **Organizations** — the tenant boundary; the first user becomes \`OWNER\`.
- **Multiple users** — many users per organization, each with a \`SystemRole\`.
- **Invitations** — \`Invitation\` model: emailed, tokenized (hash stored, raw
  token delivered out-of-band), status-tracked (pending/accepted/expired/
  revoked), with an inviter and target role.
- **Password reset architecture** — \`PasswordReset\` model: tokenized (hash
  stored), expiring, single-use. The actual reset is executed by the auth
  provider; we record the request lifecycle.
- **Sessions** — \`UserSession\` model: metadata only (provider, ip, user agent,
  expiry, revocation), no raw token material.
- **Future SSO compatibility** — \`AuthProviderType\` enum already includes
  \`GOOGLE_OAUTH\`, \`MICROSOFT_OAUTH\`, \`SAML_SSO\`, \`OIDC_SSO\`, and \`MAGIC_LINK\`
  alongside \`PASSWORD\`, so enterprise SSO slots in without schema changes.

## Data Model

| Model | Role |
|-------|------|
| \`Organization\` | tenant root; owns all identity |
| \`User\` | member of an organization; carries \`authProvider\` + \`externalAuthId\` (no passwords) |
| \`Role\` | per-tenant RBAC definition (permissions array) |
| \`Invitation\` | pending membership grant, tokenized + expiring |
| \`PasswordReset\` | reset request lifecycle, tokenized + expiring + single-use |
| \`UserSession\` | session metadata, opaque/hashed token reference |

See \`ROLES_AND_PERMISSIONS.md\` for authorization (deny-by-default) and
\`DATA_MODEL.md\` for full field detail.

## Flows (architecture, not implemented)

- **Invite:** owner/admin creates an \`Invitation\` -> email with raw token ->
  invitee accepts -> \`User\` created/activated with assigned role -> invitation
  marked \`ACCEPTED\`.
- **Password reset:** user requests reset -> \`PasswordReset\` created -> email
  with raw token -> provider resets credential -> row marked used.
- **SSO (future):** organization configures an SSO connection (as a
  \`ProviderConnection\`/auth config) -> users authenticate via IdP -> \`User\`
  linked by \`externalAuthId\`; no passwords involved.

## Explicitly Out of Scope (Sprint 2)

Implementing live login/logout, token issuance, email delivery, and a concrete
auth provider integration. Those follow once the identity core is locked.
