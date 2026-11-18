import 'server-only';
import {
  prisma,
  CreatorPayoutRepository,
  stripePayoutConfig,
  plaidLedgerConfig,
  StripeGlobalPayoutsApi,
} from '@emgloop/database';
export function creatorPayouts() {
  const config = stripePayoutConfig();
  return config
    ? new CreatorPayoutRepository(prisma, config, new StripeGlobalPayoutsApi(config))
    : null;
}
export function creatorPayoutLedger(organizationId: string) {
  const enabled = creatorPayouts();
  if (enabled?.config.organizationId === organizationId) return enabled;
  const config = { ...plaidLedgerConfig(organizationId), provider: 'STRIPE' as const };
  return new CreatorPayoutRepository(prisma, config, new StripeGlobalPayoutsApi(config));
}
