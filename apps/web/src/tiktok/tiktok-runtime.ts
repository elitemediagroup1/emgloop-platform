// The TikTok Login Kit connection, assembled for a web request. SERVER ONLY.
//
// This is where the pieces meet: the deployment's client key, secret and token key (read by
// tiktok-environment.ts and nowhere else), TikTok's endpoints (@emgloop/providers, through the
// one port assembled in @emgloop/database), the token sealer, and the creator seat as the
// authority. Nothing here decides anything those pieces do not already decide.
//
// WITH THE DEFAULT ENVIRONMENT NOTHING CONNECTS. No client or key is configured, so every
// connect attempt is refused as NOT_CONFIGURED before anything is stored.

import 'server-only';

import { TikTokService, TikTokTokenSealer, createTikTokOAuthPort, prisma, tiktokCreatorPort } from '@emgloop/database';
import type { TikTokConnectOutcome } from '@emgloop/shared';

import { CREATOR_HREFS, creatorDomain } from '../creator/creator-runtime';
import { readTikTokEnvironment } from './tiktok-environment';

/** The connection lifecycle for a signed-in creator. The principal is always the session's. */
export function tiktok(): TikTokService {
  const env = readTikTokEnvironment();
  return new TikTokService(prisma, {
    configured: env.state === 'CONFIGURED' ? { oauth: createTikTokOAuthPort(env), sealer: new TikTokTokenSealer(env.tokenKey) } : null,
    creator: tiktokCreatorPort(creatorDomain().creator),
  });
}

/** Where a connect, callback or disconnect returns the creator: their Profile page, with the outcome. */
export function tiktokReturnPath(outcome: TikTokConnectOutcome): string {
  return `${CREATOR_HREFS.profile}?${new URLSearchParams({ tiktok: outcome }).toString()}`;
}
