// Loop OS — routing verification harness (pure).
//
// A tiny framework-free checker over the pure, deterministic pieces of the
// shell — the role router, the role authority table and LOOP_NAV. It asserts:
// every SystemRole resolves to an authority, routing is table-driven, isolation
// holds (an Employee never holds Admin authority), the default fails closed,
// every home is Loop Home, and every nav item states the role authority of the
// route tree its destination lives in. No React, no DOM, no I/O; it may be
// invoked via runWorkspaceRoutingVerification().

import {
  LOOP_NAV,
  WORKSPACES,
  WORKSPACE_ROLES,
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

  // 7. Every role's home is Loop Home (/app): one application, one home. The
  //    role decides what the home shows, never a different address.
  for (const role of WORKSPACE_ROLES) {
    const ws = WORKSPACES[role];
    c.eq(role + ' home is Loop Home', ws.home, '/app');
    c.eq(
      role + ' home route resolves for a hinted session',
      resolveHomeRoute({ systemRole: 'x', workspaceRole: role }),
      ws.home,
    );
  }

  // 8. One registry, honest about authority: every LOOP_NAV item opens the
  //    application (/app or /crm), and an item whose destination lives in a
  //    role-guarded tree states exactly that tree's role; any other item states
  //    none. A mismatch would show someone a link that sends them away, or hide
  //    one they can open.
  const items = LOOP_NAV.nav.flatMap((g) => g.items);
  c.ok('LOOP_NAV has nav items', items.length > 0);
  for (const item of items) {
    const within = (prefix: string) => item.href === prefix || item.href.startsWith(prefix + '/');
    c.ok('nav link stays in the application (' + item.href + ')', within('/app') || within('/crm'));
    const tree = WORKSPACE_ROLES.find((role) => within(WORKSPACES[role].basePath));
    c.eq('nav authority matches its route tree (' + item.href + ')', item.workspace, tree);
  }

  const failures = c.checks.filter((x) => !x.passed).length;
  return { passed: failures === 0, total: c.checks.length, failures, checks: c.checks };
}
