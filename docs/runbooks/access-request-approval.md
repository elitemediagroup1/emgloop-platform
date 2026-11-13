# Access requests → approved onboarding invitation

Public Request Access submissions now persist in a tenant-scoped `access_requests` queue.
An operations email remains a notification, not the approval mechanism. A submission never
creates a user, grants a role, sends an onboarding link or exposes whether an account exists.
Duplicate email submissions in the configured organization retain the original record and decision.

Administration → Team → Access requests is visible to team administrators with `users:create`.
Approving selects an explicit role and uses the stored request identity. It reuses the existing
IAM invitation flow, seven-day hashed token, canonical acceptance URL and transactional email.
Employee acceptance continues through the existing password/account setup and optional Google
onboarding; Creator acceptance binds its explicit Person identity and opens creator profile setup.

## Production rollout (Matt performs migration and merge)

1. Review and merge the feature PR. Netlify builds the generated Prisma client; this does NOT apply
   the database migration. Until the migration exists, the queue shows a load warning while the
   existing Team invitation controls remain available.
2. Run GitHub Actions → **Deploy Prisma Migrations** → **Run workflow**, branch `main`.
   Confirmation: `migrate loop-connections-production`. Verify success for migration
   `20261113193000_access_requests`. It adds a table/indexes/FKs only; no data is deleted.
3. Open Administration → Team. The setup message shows this signed-in workspace's organization ID.
   In Netlify emgloop2 set **LOOP_ACCESS_REQUEST_ORGANIZATION_ID** to that exact ID, server/Functions
   scope, **Production context only**, then redeploy. Keep previews unconfigured unless explicitly
   testing with a separate authorized organization/database. The public browser never supplies
   this routing; company name and email domain never select a tenant. Existing email settings
   (RESEND_API_KEY, LOOP_EMAIL_FROM, LOOP_ACCESS_REQUEST_TO) remain unchanged.
4. For legacy emails such as Mike's request, choose **Record a request received by email**.
   Enter the supplied name, email, company and requested access. This creates a review entry only,
   without sending an invitation or asking the requester to resubmit.
5. Select the intended role on the entry and click **Approve & send invitation**. Check the success
   message and Pending invitations. The requester uses the expiring email link to onboard.
   Actual delivery/inbox arrival and acceptance require a controlled live check after rollout.

## Recovery and safeguards

- An atomic claim prevents double-clicks or concurrent administrators processing one request twice.
  A stalled claim can be retried after five minutes. Replayed completions cannot change a newer claim.
- Failed delivery remains in the review queue with Retry invitation. Retrying replaces only links
  owned by that request. Creator retries reuse the already-established Person identity.
- Approval does not succeed silently when email is unconfigured, including non-production tests.
- Rejection sends no email and withdraws any pending link owned by a previous failed delivery.
- Active members are not reinvited; an unrelated existing pending invitation is resolved visibly
  with instructions to use its existing Resend control. Its role is not silently changed.
- Reviewed requests retain the decision and linked invitation status; Resend retains the linkage.
- Repository reads/writes and cursor pages are organization-scoped. Audit rows describe actual
  decisions only. No password, raw token or provider error text is persisted in the request.
- No actual request approval or invitation email is performed by this implementation/test work.

Automated validation includes unit/contract checks plus the Access request approval CI workflow:
full migrations on a disposable Postgres, race claims, retries/token replacement, roles, and
tenant isolation. The Postgres test refuses non-local database URLs.
