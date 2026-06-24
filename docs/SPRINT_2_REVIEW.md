# Sprint 2 Review — Identity & Operating-System Core

A consistency review of Sprint 2 against \`LOOP_MASTER_BLUEPRINT.md\` and
\`PLATFORM_CONSTITUTION.md\`, with recommendations before Sprint 3.

## What Sprint 2 Delivered

- **Authentication foundation** (architecture only): \`Invitation\`,
  \`PasswordReset\`, \`UserSession\`, \`AuthProviderType\` (SSO-ready). No production
  auth flows. (\`AUTHENTICATION.md\`)
- **Multi-tenant organization config**: \`OrganizationSettings\`,
  \`OrganizationPreferences\`, and the existing \`OrganizationStatus\`.
- **Organization DNA**: \`OrganizationDNA\` with brand, voice, hours, industry,
  knowledge sources, communication style, compliance, escalation, AI defaults,
  and provider defaults — inherited by AI Employees. (\`ORGANIZATION_DNA.md\`)
- **Capabilities**: \`Capability\` + \`OrganizationCapability\`, registration /
  enablement / dependency rules; capabilities power modules. (\`CAPABILITIES.md\`)
- **Roles & permissions**: \`SystemRole\` (Owner/Admin/Manager/Employee/AI
  Employee/Read Only), \`Permission\` with deny-by-default resolution, shared
  \`isAllowed\` resolver. (\`ROLES_AND_PERMISSIONS.md\`)
- **Provider connections**: lifecycle + multi-provider management on the existing
  \`ProviderConnection\` model; no live integrations. (\`PROVIDER_CONNECTIONS.md\`)
- **Future capabilities** parking lot. (\`FUTURE_CAPABILITIES.md\`)
- **Shared vocabulary**: \`packages/shared/src/identity.ts\`.

Schema grew from 19 to **28 models** (additively; nothing removed or forked).

## Consistency Check

| Principle (source) | Status | Notes |
|--------------------|--------|-------|
| AI-first, not CRM-first | PASS | DNA + AI Employee + permissions precede customer features. |
| Industry-agnostic | PASS | All new models are generic; vertical detail stays in JSON. |
| Multi-tenant isolation | PASS | Every new tenant-scoped model carries \`organizationId\` with cascade. |
| Provider-agnostic | PASS | Provider connections store refs, not secrets; multi-provider supported. |
| Modular / capabilities | PASS | Capabilities power modules; org-enabled, not hardcoded. |
| Own intelligence, not infra | PASS | No vendor lock-in introduced; auth is provider-agnostic. |
| Foundation over polish | PASS | Architecture + schema only; no premature features. |
| Identity before customers | PASS | Org/Users/Roles/Permissions/Capabilities/DNA/Providers all modeled first. |

No contradictions with the blueprint or constitution were found.

## Observations / Risks

1. **Module vs Capability overlap.** Both \`OrganizationSettings.modules\` (interim)
   and \`OrganizationCapability\` can express enablement. Pick \`OrganizationCapability\`
   as canonical in Sprint 3 and treat \`settings.modules\` as deprecated-on-arrival.
2. **AIEmployee model still pending.** \`Permission.aiEmployeeId\` is a loose
   reference; the \`AIEmployee\` generalization of \`AIAgent\` (Sprint 1.5 R4) is not
   yet a table. Recommend landing it in Sprint 3 so permissions/DNA inheritance
   have a concrete subject.
3. **Permission storage.** Deny-by-default is modeled; the *resolution engine*
   beyond the shared \`isAllowed\` helper (caching, wildcard/hierarchy semantics)
   needs a spec before enforcement.
4. **Secrets manager dependency.** \`credentialsRef\` assumes a secrets backend;
   choose one (architecture) before any provider integration.

## Recommendations for Sprint 3

- **S3-R1:** Implement \`AIEmployee\` (from Sprint 1.5 R4) and wire DNA inheritance
  + permissions + capability reach to it. **(P0)**
- **S3-R2:** Make \`OrganizationCapability\` the single source of enablement;
  deprecate \`settings.modules\`. **(P0)**
- **S3-R3:** Specify the permission resolution engine (wildcards, resource
  hierarchy, conditions, caching) on top of \`isAllowed\`. **(P1)**
- **S3-R4:** Land Sprint 1.5 R2/R3 (interaction \`kind\` spine + internal event
  stream) so the OS core is ready for customer interactions. **(P1)**
- **S3-R5:** Decide the secrets-manager approach for \`credentialsRef\`. **(P2)**
- **S3-R6:** Add seed data for the \`Capability\` catalog and default \`Role\` rows
  per organization. **(P2)**

## Non-Goals Confirmed

No production auth, no live provider integrations, no business/customer features,
and no merge to \`main\`. The identity and OS core is now modeled and documented,
ready for Sprint 3.

## Note on Branch History

During Sprint 2 the schema file briefly received a duplicated intermediate
commit; it was corrected in a subsequent commit. The branch HEAD schema is
clean (28 unique models, balanced, no duplicates). Worth squashing on PR.
