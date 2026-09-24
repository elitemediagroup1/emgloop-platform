import { SOCIAL_PLATFORM_LABELS, tiktokSocialAccountOf } from '@emgloop/shared';
import { requireWorkspace } from '../../../../workspaces/guard';
import { creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { loadAnalytics, refusedFrom } from '../../../../creator/creator-data';
import { updatePreferencesAction, updateProfileAction } from '../../../../creator/creator-actions';
import { tiktok } from '../../../../tiktok/tiktok-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { settle } from '../../_home/settle';
import { ActionButton, Facts, LoopPage, PageHead, Panel, StateBlock } from '../../_loop-os/record';
import { Pill, compactNumber, param, refusalText } from '../_parts/vocabulary';
import { TikTokConnectionRow, readTikTokEntry, tiktokOutcomeParam, type TikTokReadProblem } from '../_parts/tiktok-connection';

// Profile (Creator Hub): what the creator maintains about themselves, and the honest state of
// everything Loop cannot do yet. TikTok is the one platform a creator can connect (Login Kit);
// the other platforms' controls are labelled and inert, never a button that pretends. Payouts
// are not built. Rate information appears only when EMG designated it visible to the creator.
//
// THE TIKTOK READ HAPPENS ON VISIT, BOUNDED. Before the profile is loaded, Loop asks the TikTok
// service to read the account's facts if the last read is old enough (TIKTOK_READ_MIN_INTERVAL_MS);
// the page then renders what the profile holds, with the read's own verdict beside it. A read
// that fails never hides the page and never presents old counts as new.

export const dynamic = 'force-dynamic';

interface SocialAccount {
  platform: string;
  handle: string | null;
  state: string;
  audience: number | null;
}

function readSocial(raw: unknown): SocialAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.platform === 'string')
    .map((r) => ({
      platform: r.platform as string,
      handle: typeof r.handle === 'string' ? r.handle : null,
      state: typeof r.state === 'string' ? r.state : 'NOT_CONNECTED',
      audience: typeof r.audience === 'number' ? r.audience : null,
    }));
}

function readObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function readDocuments(raw: unknown): { name: string; url: string | null }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.name === 'string')
    .map((r) => ({ name: r.name as string, url: typeof r.url === 'string' && /^https?:\/\//.test(r.url) ? r.url : null }));
}

export default async function CreatorProfilePage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const domain = creatorDomain();
  const principal = { organizationId: seat.actor.organizationId, userId: seat.actor.userId, name: seat.session.name };

  // The TikTok read first, so the profile loaded below already holds what it returned.
  const tiktokRead = await settle(() => tiktok().readOnVisit(principal));
  const tiktokStatus = await settle(() => tiktok().status(principal));
  const readProblem: TikTokReadProblem = !tiktokRead.ok
    ? 'READ_FAILED'
    : !tiktokRead.value.ok && (tiktokRead.value.state === 'UNAVAILABLE' || tiktokRead.value.state === 'INSUFFICIENT_SCOPE')
      ? tiktokRead.value.state
      : null;

  const profile = await domain.creator.profileById(seat.actor.organizationId, seat.profileId);
  const analytics = await settle(() => loadAnalytics(seat));
  const saved = param(searchParams.saved);
  const refused = refusedFrom(searchParams);
  const social = readSocial(profile?.socialAccounts).filter((s) => s.platform !== 'TIKTOK');
  const tiktokEntry = readTikTokEntry(tiktokSocialAccountOf(profile?.socialAccounts));
  const rate = readObject(profile?.rateInfo);
  const rateVisible = rate.visibleToCreator === true;
  const preferences = readObject(profile?.preferences);
  const documents = readDocuments(profile?.documents);
  const audience = analytics.ok ? analytics.value.latestAudience : [];

  return (
    <LoopPage label="Profile">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Profile' }]} title={profile?.displayName ?? seat.displayName} subtitle={profile?.handle ? `@${profile.handle}` : undefined} />
      {saved ? <StateBlock kind="empty" compact title="Saved." body={saved === 'preferences' ? 'Your preference is saved to your profile.' : 'Your profile is updated.'} /> : null}
      {refused ? <StateBlock kind="attention" compact title={refusalText(refused.reason, refused.detail).title} body={refusalText(refused.reason, refused.detail).body} /> : null}

      <Panel title="Creator information">
        <form className="ch-form" action={updateProfileAction}>
          <label className="loop-field">
            <span className="loop-label">Display name</span>
            <input className="loop-input" type="text" name="displayName" required maxLength={120} defaultValue={profile?.displayName ?? seat.displayName} />
          </label>
          <label className="loop-field">
            <span className="loop-label">Handle</span>
            <input className="loop-input" type="text" name="handle" maxLength={60} defaultValue={profile?.handle ?? ''} placeholder="yourname" />
          </label>
          <label className="loop-field">
            <span className="loop-label">Bio</span>
            <textarea className="loop-textarea" name="bio" rows={4} maxLength={2000} defaultValue={profile?.bio ?? ''} />
          </label>
          <label className="loop-field">
            <span className="loop-label">Categories</span>
            <input className="loop-input" type="text" name="categories" defaultValue={(profile?.categories ?? []).join(', ')} placeholder="beauty, travel, food" />
            <span className="loop-note">Comma-separated, up to twelve.</span>
          </label>
          <div className="loop-btnrow">
            <button type="submit" className="loop-btn loop-btn--primary">
              Save
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Social accounts">
        {tiktokStatus.ok ? (
          <TikTokConnectionRow status={tiktokStatus.value} entry={tiktokEntry} outcome={tiktokOutcomeParam(searchParams.tiktok)} readProblem={readProblem} time={time} />
        ) : (
          <StateBlock kind="error" compact title="Loop could not check your TikTok connection just now." body="This is a failure to read, not a finding that there is none." />
        )}
        {social.length === 0 ? null : (
          <ul className="ch-list" aria-label="Other social accounts" style={{ marginTop: 12 }}>
            {social.map((s) => (
              <li key={`${s.platform}:${s.handle ?? ''}`} className="ch-row ch-row--static" data-social-state={s.state}>
                <span className="ch-row__main">
                  <span className="ch-row__title">{(SOCIAL_PLATFORM_LABELS as Record<string, string>)[s.platform] ?? s.platform}</span>
                  <span className="ch-row__meta">
                    {s.handle ? `@${s.handle.replace(/^@/, '')}` : 'No handle recorded'}
                    {s.audience !== null ? ` · ${compactNumber(s.audience)} followers (as listed)` : ''}
                  </span>
                </span>
                <span className="ch-row__side">
                  {s.state === 'SEEDED_DEMO' ? (
                    <Pill tone="neutral" small>
                      Demo data
                    </Pill>
                  ) : s.state === 'NOT_CONNECTED' ? (
                    <ActionButton action={{ label: 'Connect', href: null, reason: 'Connecting this platform is not available yet' }} />
                  ) : (
                    <Pill tone="good" small>
                      {s.state.charAt(0) + s.state.slice(1).toLowerCase().replace(/_/g, ' ')}
                    </Pill>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Audience">
        {!analytics.ok ? (
          <StateBlock kind="error" compact title="Loop could not read your audience just now." body="This is a failure to read, not a finding that there is none." />
        ) : audience.length === 0 ? (
          <StateBlock kind="empty" compact title="No audience observed." body="Follower counts appear here once a connected platform reports them or EMG records them." />
        ) : (
          <Facts
            rows={audience.map((a) => ({
              label: (SOCIAL_PLATFORM_LABELS as Record<string, string>)[a.platform] ?? a.platform,
              value: `${a.followers.toLocaleString('en-US')} followers${a.growth30dPct !== null ? ` · ${a.growth30dPct > 0 ? '+' : ''}${a.growth30dPct}% in 30 days` : ''} · ${time.date(a.observedAt)}${a.source === 'SEEDED_DEMO' ? ' · seeded demo data' : a.source === 'PLATFORM' ? ' · from the platform' : ''}`,
            }))}
          />
        )}
      </Panel>

      {rateVisible ? (
        <Panel title="Rate information">
          <Facts rows={Object.entries(rate).filter(([k]) => k !== 'visibleToCreator').map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), value: typeof v === 'string' || typeof v === 'number' ? String(v) : null, unknownText: 'Not a simple value' }))} />
          <p className="loop-note" style={{ marginTop: 10 }}>
            Maintained by EMG; shown because EMG marked it visible to you.
          </p>
        </Panel>
      ) : null}

      <Panel title="Payouts">
        <p className="loop-panel__lead">{profile?.payoutState === 'SEEDED_DEMO' ? 'Payout details are seeded demo data. No bank detail is stored in Loop.' : 'Payouts are not set up. No bank detail is stored in Loop.'}</p>
        <ActionButton action={{ label: 'Set up payouts', href: null, reason: 'Payout setup is not available yet' }} />
      </Panel>

      <Panel title="Documents">
        {documents.length === 0 ? (
          <StateBlock kind="empty" compact title="No documents." body="Agreements and briefs EMG shares with you appear here." />
        ) : (
          <ul className="ch-list" aria-label="Documents">
            {documents.map((d) => (
              <li key={d.name} className="ch-row ch-row--static">
                <span className="ch-row__main">
                  <span className="ch-row__title">{d.url ? <a href={d.url} rel="noreferrer noopener">{d.name}</a> : d.name}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Preferences">
        <form className="ch-form" action={updatePreferencesAction}>
          <label className="ch-check">
            <input type="checkbox" name="notifyOnReturn" defaultChecked={preferences.notifyOnReturn === true} />
            <span>Tell me when an edit comes back for my review</span>
          </label>
          <p className="loop-note">Saved to your profile. Loop does not send notifications yet, so this changes nothing until it does.</p>
          <div className="loop-btnrow">
            <button type="submit" className="loop-btn">
              Save preferences
            </button>
          </div>
        </form>
      </Panel>
    </LoopPage>
  );
}
