// Which declared external website sources an organization has NOT connected -- for website.domain@2's coverage
// limitation and nothing else. A registry entry is a declaration; only a CONNECTED organization connection
// (OrganizationConnectionRepository) is a connection. A source is EXPECTED only where the organization has a LIVE
// web property (websiteCoverageVerdict): an organization whose properties are all OWNED / BUILDING / PAUSED /
// RETIRED has nothing to be missing, so it gets no limitation -- a known, not-yet-live site is never a gap. Before the website evidence migration is applied the
// connection columns do not exist: every declared source is then, truthfully, not connected.

import type { PrismaClient } from '@prisma/client';
import { INTELLIGENCE_SOURCE_REGISTRY, WEBSITE_SOURCE_CONNECTIONS, websiteCoverageVerdict } from '@emgloop/shared';
import { absentUntilMigrated } from '../../creator/until-migrated';
import { OrganizationConnectionRepository } from '../../repositories/organization-connection.repository';
import type { WebsiteCoveragePort } from './domains/records';

/** The declared external website sources: registered for WEBSITE, owned by an organization connection. */
export function declaredExternalWebsiteSources() {
  return INTELLIGENCE_SOURCE_REGISTRY.filter((s) => s.domains.includes('WEBSITE') && s.basis === 'ORGANIZATION_CONNECTION' && WEBSITE_SOURCE_CONNECTIONS[s.sourceId]);
}

export function websiteCoveragePort(prisma: PrismaClient): WebsiteCoveragePort {
  const connections = new OrganizationConnectionRepository(prisma);
  return {
    async unconnectedSources(organizationId, now) {
      const liveProperties = (await absentUntilMigrated(prisma.webProperty.count({ where: { organizationId, lifecycle: 'LIVE' } }))) ?? 0;
      if (liveProperties === 0) return [];
      const declared = declaredExternalWebsiteSources();
      const keys = declared.map((s) => WEBSITE_SOURCE_CONNECTIONS[s.sourceId]!);
      const states = (await absentUntilMigrated(connections.states(organizationId, keys, now))) ?? new Map<string, 'NOT_CONNECTED'>();
      return declared
        .filter((s) => websiteCoverageVerdict({ firstParty: false, liveProperties, liveIngestingProperties: 0, connection: states.get(WEBSITE_SOURCE_CONNECTIONS[s.sourceId]!.provider) ?? 'NOT_CONNECTED', hasRecentEvidence: false }) === 'GAP_NOT_CONNECTED')
        .map((s) => s.label);
    },
  };
}
