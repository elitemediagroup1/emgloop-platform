// @emgloop/api — API service entrypoint.
//
// Sprint 1 scaffold only. This wires together the shared packages (database,
// providers, shared) to prove the monorepo boundaries compile. No HTTP server,
// routes, or real provider calls are implemented yet.

import { PLATFORM, PROVIDER_CATEGORIES } from '@emgloop/shared';
import { listProviders } from '@emgloop/providers';
import type { ProviderCategory } from '@emgloop/providers';

export interface HealthReport {
  service: string;
  status: 'ok';
  sprint: string;
  providers: Record<ProviderCategory, number>;
}

/** Returns a health snapshot. Provider counts are 0 in Sprint 1 (none registered). */
export function getHealth(): HealthReport {
  const providers = Object.fromEntries(
    PROVIDER_CATEGORIES.map((c) => [c, listProviders(c).length]),
  ) as Record<ProviderCategory, number>;

  return {
    service: 'emgloop-api',
    status: 'ok',
    sprint: 'sprint-1-platform-foundation',
    providers,
  };
}

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(\`\${PLATFORM.name} API — \`, getHealth());
}
