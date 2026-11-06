import 'server-only';
import { MetaConnectionRepository, MetaService, MetaTokenSealer, MetaAnalyticsService, prisma } from '@emgloop/database';
import { MetaApi } from '@emgloop/providers';
import { readMetaEnvironment } from './meta-environment';
import { governedGateway } from '../ai/governed-gateway';
export const metaRepository = () => new MetaConnectionRepository(prisma);
export function metaService() {
  const env = readMetaEnvironment();
  return new MetaService(metaRepository(), env ? { api: new MetaApi(env.config), sealer: new MetaTokenSealer(env.key) } : null);
}
export const metaReturnPath = (outcome: string) => `/app/creator/profile?${new URLSearchParams({ meta: outcome })}`;

export const metaAnalyticsService = () => new MetaAnalyticsService(metaRepository(), governedGateway().gateway);
