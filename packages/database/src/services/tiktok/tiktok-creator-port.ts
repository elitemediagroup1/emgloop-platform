// The creator seat, as the TikTok connection needs it. ONE assembly over the creator domain's
// own repository, so the web runtime and the tests bind the same behaviour.
//
// AUTHORITY IS THE PROFILE BOUND TO THE LOGIN. A TikTok connection belongs to a managed
// creator, and a creator holds no organization permission (the CREATOR matrix row is empty by
// design). So the whole authorization is: does a CreatorProfile bind this login in this
// organization. No profile, no connection -- never a default.
//
// WHAT IS WRITTEN BACK, AND WHERE. What a read returns is merged (never replaced) into the
// profile's TikTok `socialAccounts` entry, and a follower count becomes an audience
// observation labelled as coming from the platform -- recorded when it changed, or once a day
// while it has not, so the audience history is a record of observations rather than of visits.

import type { Prisma } from '@prisma/client';
import { mergeTikTokSocialAccount } from '@emgloop/shared';

import type { CreatorRepository } from '../../creator/creator.repository';
import type { TikTokCreatorPort } from './tiktok.service';

/** An unchanged count is re-recorded no more than once in this long. */
export const TIKTOK_AUDIENCE_REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function tiktokCreatorPort(creator: CreatorRepository): TikTokCreatorPort {
  return {
    async seatOf(principal) {
      const profile = await creator.profileForUser(principal.organizationId, principal.userId);
      return profile ? { creatorProfileId: profile.id } : null;
    },
    async mergeSocialAccount(organizationId, creatorProfileId, patch) {
      const profile = await creator.profileById(organizationId, creatorProfileId);
      if (!profile) return;
      const merged = mergeTikTokSocialAccount(profile.socialAccounts, patch) as Prisma.InputJsonValue;
      await creator.updateProfile(organizationId, creatorProfileId, { socialAccounts: merged });
    },
    async recordAudience(organizationId, creatorProfileId, followers, now) {
      const latest = await creator.latestAudience(organizationId, creatorProfileId, 'TIKTOK', 'PLATFORM');
      if (latest && latest.followers === followers && now.getTime() - latest.observedAt.getTime() < TIKTOK_AUDIENCE_REPEAT_INTERVAL_MS) return;
      await creator.addAudience({ organizationId, creatorProfileId, platform: 'TIKTOK', observedAt: now, followers, growth30dPct: null, source: 'PLATFORM' });
    },
  };
}
