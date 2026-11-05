import { createHash } from 'crypto';
import type { CreatorProfile } from '@prisma/client';
import { creatorDeclaredSocialHandles, type CreatorBrandUpdate, type AiOutputRejection } from '@emgloop/shared';

export type MailCreatorIdentity = Pick<CreatorProfile, 'id' | 'displayName' | 'handle' | 'preferences' | 'socialAccounts'>;
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export const mailEvidenceHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function exactMailPhrase(text: string, phrase: string): boolean {
  const term = normalized(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!term && new RegExp(`(?<![\\p{L}\\p{N}_])${term}(?![\\p{L}\\p{N}_])`, 'u').test(normalized(text));
}
/** Candidate evidence only: full company name equals an external participant's domain stem.
 * No substring/fuzzy match, URL scraping, local-part match, or public email-provider match.
 */
export function companyMailDomainMatch(company: string, addresses: readonly string[]): boolean {
  const name = normalized(company).replace(/[^\p{L}\p{N}]/gu, '');
  if (name.length < 4) return false;
  const personal = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com']);
  return addresses.some(address => {
    const domain = address.trim().toLowerCase().split('@');
    if (domain.length !== 2 || !domain[0] || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,24}$/.test(domain[1]!)) return false;
    const labels = domain[1]!.split('.');
    const host = labels.slice(-2).join('.');
    return !personal.has(host) && labels.at(-2)!.replace(/-/g, '') === name;
  });
}
/** Explicit manager keywords replace inferred aliases, including when a first name is intentional. */
export function parseCreatorMailKeywords(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some(v => typeof v !== 'string')) return null;
  const words = [...new Set((value as string[]).map(v => normalized(v).replace(/^@/, '')))];
  return words.every(v => v.length >= 2 && v.length <= 100 && /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(v)) ? words.sort() : null;
}
export function creatorMailAliases(profile: MailCreatorIdentity): string[] {
  const preferences = profile.preferences;
  if (preferences && typeof preferences === 'object' && !Array.isArray(preferences) && Object.hasOwn(preferences, 'staffMailKeywords')) return parseCreatorMailKeywords(preferences.staffMailKeywords) ?? [];

  const names = normalized(profile.displayName).split(' ').filter(Boolean).length >= 2 ? [profile.displayName] : [];
  const social = Array.isArray(profile.socialAccounts) ? profile.socialAccounts : [];
  const handles = [profile.handle, ...Object.values(creatorDeclaredSocialHandles(profile.preferences)), ...social.flatMap(s => s && typeof s === 'object' && !Array.isArray(s) && typeof s.handle === 'string' ? [s.handle] : [])];
  for (const raw of handles) {
    if (!raw) continue;
    let handle = raw;
    if (raw.startsWith('https://')) {
      try { const u = new URL(raw); if (!['instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com', 'youtube.com', 'www.youtube.com', 'facebook.com', 'www.facebook.com'].includes(u.hostname)) continue; handle = u.pathname.replace(/\/$/, '').split('/').pop() ?? ''; } catch { continue; }
    }
    handle = handle.replace(/^@/, '');
    if (/^[\p{L}\p{N}_.-]{4,100}$/u.test(handle) && !['videos', 'reels', 'posts', 'featured'].includes(handle)) names.push(handle);
  }
  return [...new Set(names.map(normalized))].sort();
}
// Invalidate pre-fix automatic attribution/readings; a manager must explicitly restart the pilot.
export const creatorCaptureScopeHash = (profile: MailCreatorIdentity) => mailEvidenceHash(JSON.stringify({ version: 2, aliases: creatorMailAliases(profile) }));
export function creatorMailQuery(profile: MailCreatorIdentity, assigned: boolean, since: Date): string | null {
  const terms = creatorMailAliases(profile).map(s => s.replace(/["{}\\:\r\n]/g, ' ').trim()).filter(Boolean);
  if (!assigned && !terms.length) return null;
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:spam -in:trash -in:drafts${assigned ? '' : ` {${terms.map(s => `"${s}"`).join(' ')}}`}`;
  return q.length <= 1500 ? q : null;
}

/** Conservative fallback for companies not yet entered in CRM.
 * The candidate is never published without creator-specific model approval.
 */
export function externalBrandCandidate(addresses: readonly string[]): string | null {
  const excluded = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com', 'google.com', 'microsoft.com', 'sendgrid.net', 'mailchimp.com']);
  const names = new Set<string>();
  for (const address of addresses) {
    const domain = address.trim().toLowerCase().split('@')[1];
    if (!domain || !/^[a-z0-9-]+(?:\\.[a-z0-9-]+)+$/.test(domain)) return null;
    const labels = domain.split('.');
    if (excluded.has(labels.slice(-2).join('.'))) continue;
    if (labels.length > 2 && ['co', 'com', 'org', 'net'].includes(labels.at(-2)!)) return null;
    const name = labels.at(-2)!.replace(/-/g, ' ');
    if (name.length < 4 || name.length > 80) return null;
    names.add(name);
  }
  return names.size === 1 ? [...names][0]! : null;
}

export type CaptureReadingState = 'CURRENT' | 'WITHHELD' | 'UNMATCHED_CREATOR' | 'MIXED_CREATORS' | 'UNMAPPED_BRAND' | 'SOURCE_UNAVAILABLE' | 'MODEL_UNAVAILABLE';
export interface ManagedCaptureReading {
  readonly threadId: string;
  readonly brandId: string | null;
  readonly candidateBrandName?: string;
  readonly evidenceKey: string;
  readonly fingerprint: string;
  readonly evidenceAt: string | null;
  readonly checkedAt: string;
  readonly generatedAt: string | null;
  readonly messageCount: number;
  readonly incomplete: boolean;
  readonly state: CaptureReadingState;
  readonly update?: CreatorBrandUpdate;
  /** Validation-only cooldown. Other model failures still back off the entire source. */
  readonly retryAfter?: string;
  readonly rejections?: readonly AiOutputRejection[];
}
