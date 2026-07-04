// Loop OS — Workspace routing verification harness (pure, PR #47).
//
// Mirrors the PR #45/#46 proof pattern: a tiny framework-free checker over the
// pure, deterministic pieces of the Phase 2 shell — the role router and the
// workspace config. It asserts the invariants the Phase 2 brief requires:
// every SystemRole routes somewhere, routing is config-driven (not hard-coded),
// isolation holds (an Employee never lands in Admin), the default fails closed,
// and every workspace's nav points inside its own basePath. No React, no DOM,
// no I/O, no runtime wiring; it compiles under typecheck and may be invoked via
// runWorkspaceRoutingVerification().

import {
  WORKSPACES,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from './config';
import {
  SYSTEM_ROLE_TO_WORKSPACE,
  DEFAULT_WORKSPACE_ROLE,
  resolveWorkspaceRole,
  resolveHomeRoute,
} from './role-router';

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}
export interface VerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  checks: CheckResult[];
}

class Checker {
  readonly checks: CheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({ name, passed: condition, detail: condition ? undefined : detail ?? 'expected true' });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
}

/** Every SystemRole the platform ships maps to a real workspace. */
const KNOWN_SYSTEM_ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'EMPLOYEE',
  'AI_EMPLOYEE',
  'READ_ONLY',
];

export function runWorkspaceRoutingVerification(): VerificationReport {
  const c = new Checker();

  // 1. Every workspace role has a config whose role field matches its key.
  for (const role of WORKSPACE_ROLES) {
    c.eq('workspace exists for ' + role, WORKSPACES[role]?.role, role);
  }

  // 2. Every known SystemRole resolves to a defined workspace (no dead ends).
  for (const sys of KNOWN_SYSTEM_ROLES) {
    const wr = resolveWorkspaceRole({ systemRole: sys });
    c.ok('systemRole ' + sys + ' routes to a workspace', wr in WORKSPACES);
  }

  // 3. Routing is config-driven: resolveWorkspaceRole agrees with the table.
  for (const sys of KNOWN_SYSTEM_ROLES) {
    c.eq(
      'systemRole ' + sys + ' routes per table',
      resolveWorkspaceRole({ systemRole: sys }),
      SYSTEM_ROLE_TO_WORKSPACE[sys],
    );
  }

  // 4. Isolation: privileged DB roles land in ADMIN; EMPLOYEE never does.
  c.eq('OWNER -> ADMIN', resolveWorkspaceRole({ systemRole: 'OWNER' }), 'ADMIN');
  c.eq('EMPLOYEE -> EMPLOYEE', resolveWorkspaceRole({ systemRole: 'EMPLOYEE' }), 'EMPLOYEE');
  c.ok('EMPLOYEE never lands in ADMIN', resolveWorkspaceRole({ systemRole: 'EMPLOYEE' }) !== 'ADMIN');

  // 5. Fail-closed: an unknown role gets the most isolated workspace, not ADMIN.
  const unknown = resolveWorkspaceRole({ systemRole: 'NON_EXISTENT_ROLE' });
  c.eq('unknown role uses fail-closed default', unknown, DEFAULT_WORKSPACE_ROLE);
  c.ok('fail-closed default is not ADMIN', DEFAULT_WORKSPACE_ROLE !== 'ADMIN');

  // 6. Product roles via explicit hint (no schema change needed).
  c.eq(
    'BUSINESS_OWNER hint routes to business workspace',
    resolveWorkspaceRole({ systemRole: 'READ_ONLY', workspaceRole: 'BUSINESS_OWNER' }),
    'BUSINESS_OWNER',
  );
  c.eq(
    'CREATOR hint routes to creator workspace',
    resolveWorkspaceRole({ systemRole: 'EMPLOYEE', workspaceRole: 'CREATOR' }),
    'CREATOR',
  );
  c.ok(
    'invalid hint is ignored (falls back to systemRole)',
    resolveWorkspaceRole({ systemRole: 'ADMIN', workspaceRole: 'NOPE' }) === 'ADMIN',
  );

  // 7. Home routes are inside each workspace's own basePath (config integrity).
  for (const role of WORKSPACE_ROLES) {
    const ws = WORKSPACES[role];
    c.ok(
      role + ' home is within its basePath',
      ws.home === ws.basePath || ws.home.startsWith(ws.basePath),
    );
    c.eq(
      role + ' home route resolves for a hinted session',
      resolveHomeRoute({ systemRole: 'x', workspaceRole: role }),
      ws.home,
    );
  }

  // 8. Nav integrity: every workspace has at least one group with items, and
  //    every intra-app link stays inside the workspace basePath (except a few
  //    deliberate cross-links, e.g. Admin -> /crm, which are absolute app roots).
  for (const role of WORKSPACE_ROLES) {
    const ws = WORKSPACES[role];
    const items = ws.nav.flatMap((g) => g.items);
    c.ok(role + ' has nav items', items.length > 0);
    for (const item of items) {
      const insideOwnWorkspace = item.href.startsWith(ws.basePath);
      const knownCrossLink = item.href === '/crm' || item.href.startsWith('/crm/');
      c.ok(
        role + ' nav link is scoped (' + item.href + ')',
        insideOwnWorkspace || knownCrossLink,
      );
    }
  }

  const failures = c.checks.filter((x) => !x.passed).length;
  return { passed: failures === 0, total: c.checks.length, failures, checks: c.checks };
}
