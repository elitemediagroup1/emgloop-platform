// WHOSE WORK STATE. The type that makes an organization-only read unwriteable.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §20.1.
//
// THE PROBLEM THIS SOLVES. Loop's tenancy rules are organization-first, and every repository
// in this package takes `organizationId` as its first argument. Daily Loop is the first
// surface where that is not enough: an employee's mail-derived work state must be
// unreachable by every other member of the same organization, including OWNER and ADMIN.
// Sprint 29A already proved that caller-enforced isolation cannot be sustained by review --
// the safe call and the unsafe call look identical at the call site.
//
// SO THE UNSAFE CALL IS NOT EXPRESSIBLE. Every method in this directory takes this object,
// and TypeScript refuses a call that omits either field. There is no overload that takes an
// organization alone, no `listForOrganization`, no `countByOrganization`, and no method
// whose scope arrives as two loose strings that could be transposed or half-supplied.
//
// WHERE IT COMES FROM. The web tier builds it from the signed session and nothing else --
// never from a form, a query parameter, a path segment or a body.

/** One person, in one organization. Both are required, always, everywhere. */
export interface WorkPrincipal {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * The scope clause every work-state query starts from.
 *
 * Reading it from the principal rather than spelling it at each call site is what keeps a
 * half-scoped `where` from ever being written: there is one place the pair becomes a filter.
 */
export function workScope(principal: WorkPrincipal): { organizationId: string; userId: string } {
  const { organizationId, userId } = principal;
  if (!organizationId || !userId) {
    // Defensive: a caller that built a principal from partial input fails loudly here rather
    // than issuing a query scoped to one field.
    throw new Error('a work-state principal requires both organizationId and userId');
  }
  return { organizationId, userId };
}
