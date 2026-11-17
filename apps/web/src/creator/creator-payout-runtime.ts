import 'server-only';
import {
  prisma,
  CreatorPayoutRepository,
  plaidConfig,
  plaidLedgerConfig,
  PlaidApi,
} from '@emgloop/database';
export function creatorPayouts() {
  const config = plaidConfig();
  return config ? new CreatorPayoutRepository(prisma, config, new PlaidApi(config)) : null;
}

export function creatorPayoutLedger(organizationId: string) {
  const enabled = creatorPayouts();
  if (enabled?.config.organizationId === organizationId) return enabled;
  const config = plaidLedgerConfig(organizationId);
  return new CreatorPayoutRepository(prisma, config, new PlaidApi(config));
}
