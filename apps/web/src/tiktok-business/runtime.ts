import 'server-only';
import { prisma, TikTokBusinessRepository, TikTokBusinessService, type BusinessPrincipal } from '@emgloop/database';
import { TikTokBusinessApi, type TikTokBusinessKind } from '@emgloop/providers';
import { getSessionBinding } from '../auth/auth';
import { readBusinessEnvironment } from './environment';
export const BUSINESS_SETTINGS = '/app/integrations/tiktok-business';
export const businessRepository = () => new TikTokBusinessRepository(prisma);
export function businessService(kind: TikTokBusinessKind) {
  const config = readBusinessEnvironment(kind);
  const api = config ? new TikTokBusinessApi(config) : null;
  return new TikTokBusinessService(businessRepository(), config && api ? { ...config, exchange: (k, code) => api.exchange(k, code) } : null);
}
export async function businessPrincipal(): Promise<BusinessPrincipal | null> {
  const bound = await getSessionBinding();
  return bound ? { organizationId: bound.session.organizationId, userId: bound.session.userId, sessionId: bound.sessionId } : null;
}

import { TtoMediaRepository, TtoMediaService } from '@emgloop/database';
import { TtoPublicApi } from '@emgloop/providers';
export const ttoMediaRepository = () => new TtoMediaRepository(prisma);
export function ttoMediaService() {
  const config = readBusinessEnvironment('TTO');
  return new TtoMediaService(ttoMediaRepository(), config ? {key:config.key,api:new TtoPublicApi(config)} : null);
}
