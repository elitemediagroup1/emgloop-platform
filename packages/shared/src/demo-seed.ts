// demo-seed.ts — the ONE predicate every demo/fixture seeding path must consult.
//
// Seeding demo or sample identities (users, team members, AI employees, sample
// CRM/work/campaign data) is a DEVELOPMENT and REVIEW convenience only. In
// production it is a defect: it fabricates team members and — because a bootstrap
// tends to "ensure + activate" — it silently resurrects a member an admin has
// removed. Production MUST fail closed: never auto-create sample data.
//
// The gate is deliberately two independent conditions, BOTH required:
//   1. Explicit opt-in. `EMG_SEED_DEMO` must be exactly the string 'true'. Unset
//      (the default everywhere, including production) means OFF. We do not infer
//      "seed is fine" from NODE_ENV alone — Netlify sets NODE_ENV='production'
//      even on deploy previews, so NODE_ENV is not a reliable seed contract.
//   2. Not a production runtime. Even if the flag were mis-set on the live site,
//      a production host / Netlify CONTEXT=production hard-blocks seeding.
//
// Pure: every input is passed in, so it is trivially testable and imports nothing
// (no next/headers, no direct process access at the boundary).

/** The canonical production hosts for the live EMG Loop deploy. */
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(['app.emgloop.com']);

/** The subset of environment variables the seed gate reads. */
export interface SeedEnv {
  EMG_SEED_DEMO?: string;
  /** Netlify deploy context: production | deploy-preview | branch-deploy | dev. */
  CONTEXT?: string;
  NODE_ENV?: string;
}

/**
 * True only on the live production deploy (never on previews or locally). Mirrors
 * the host-first policy used by the webhook runtime: the live site is a fixed
 * production host; a *.netlify.app subdomain is explicitly non-production; only
 * then do we consider CONTEXT, and finally fall back to NODE_ENV.
 */
function isProductionRuntime(env: SeedEnv, host?: string | null): boolean {
  if (host) {
    const h = (host.toLowerCase().split(':')[0] ?? '').trim();
    if (h && PRODUCTION_HOSTS.has(h)) return true;
    if (h.endsWith('.netlify.app')) return false;
  }
  const ctx = (env.CONTEXT ?? '').toLowerCase();
  if (ctx) return ctx === 'production';
  return (env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Whether demo/fixture seeding is permitted in this environment. Fail-closed:
 * returns false unless BOTH the explicit opt-in is set AND the runtime is not
 * production. Production, and any environment that has not explicitly opted in,
 * seeds nothing.
 */
export function isDemoSeedEnabled(env: SeedEnv, host?: string | null): boolean {
  if (env.EMG_SEED_DEMO !== 'true') return false;
  return !isProductionRuntime(env, host);
}

/**
 * Whether a seed/bootstrap pass may ACTIVATE a user row it just ensured. A member
 * an admin removed or disabled (status 'DISABLED') is NEVER reactivated — that was
 * the mechanism by which a removed teammate "kept returning". Only a freshly
 * created row, or one still awaiting invitation acceptance ('INVITED'), may be
 * activated by a seed.
 */
export function seedMayActivate(status: string, justCreated: boolean): boolean {
  return justCreated || status === 'INVITED';
}
