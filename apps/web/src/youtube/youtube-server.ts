import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@emgloop/database';
import { YOUTUBE_SCOPES, YOUTUBE_SYNC_MIN_INTERVAL_MS } from '@emgloop/shared';
import { readYouTubeEnvironment } from './youtube-environment';

export interface YouTubePrincipal {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
}

type TokenReply = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown };
const STATE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[\x21-\x7e]{16,8192}$/;
const CODE = /^[\x21-\x7e]{8,2048}$/;
const NO_STORE = { cache: 'no-store' as const };

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const binding = (p: YouTubePrincipal) => Buffer.from(`emgloop-youtube|v1|${p.organizationId}|${p.userId}`, 'utf8');

function seal(p: YouTubePrincipal, value: string, key: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(binding(p));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function open(p: YouTubePrincipal, sealed: Uint8Array, key: Uint8Array): string {
  const bytes = Buffer.from(sealed);
  if (bytes.length < 29) throw new Error('SEALED_TOKEN_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(binding(p));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const value = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  if (!TOKEN.test(value)) throw new Error('TOKEN_INVALID');
  return value;
}

async function creatorProfileId(p: Pick<YouTubePrincipal, 'organizationId' | 'userId'>): Promise<string | null> {
  const profile = await prisma.creatorProfile.findFirst({
    where: { organizationId: p.organizationId, userId: p.userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

function redirectUrl(state: string, clientId: string, redirectUri: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<TokenReply> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(12_000),
    ...NO_STORE,
  });
  if (!response.ok) throw new Error('GOOGLE_TOKEN_REQUEST_FAILED');
  return await response.json() as TokenReply;
}

async function exchange(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<{ access: string; refresh: string; expiresAt: Date; scopes: string[] }> {
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const result = await tokenRequest(body);
  const access = typeof result.access_token === 'string' ? result.access_token : '';
  const refresh = typeof result.refresh_token === 'string' ? result.refresh_token : '';
  const expiry = Number(result.expires_in);
  const scopes = typeof result.scope === 'string' ? result.scope.split(/\s+/).filter(Boolean) : [];
  if (!TOKEN.test(access) || !TOKEN.test(refresh) || !Number.isFinite(expiry) || expiry < 60 || (scopes.length !== YOUTUBE_SCOPES.length || !YOUTUBE_SCOPES.every(scope => scopes.includes(scope)))) {
    throw new Error('GOOGLE_GRANT_INVALID');
  }
  return { access, refresh, expiresAt: new Date(Date.now() + expiry * 1000), scopes };
}

async function refreshAccess(refreshToken: string, env: NonNullable<ReturnType<typeof readYouTubeEnvironment>>): Promise<{ access: string; refresh: string | null; expiresAt: Date }> {
  const body = new URLSearchParams({ refresh_token: refreshToken, client_id: env.clientId, client_secret: env.clientSecret, grant_type: 'refresh_token' });
  const result = await tokenRequest(body);
  const access = typeof result.access_token === 'string' ? result.access_token : '';
  const expiry = Number(result.expires_in);
  const rotated = typeof result.refresh_token === 'string' && TOKEN.test(result.refresh_token) ? result.refresh_token : null;
  if (!TOKEN.test(access) || !Number.isFinite(expiry) || expiry < 60) throw new Error('GOOGLE_REFRESH_INVALID');
  return { access, refresh: rotated, expiresAt: new Date(Date.now() + expiry * 1000) };
}

async function googleJson(url: URL, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(12_000), ...NO_STORE });
  if (!response.ok) throw new Error('YOUTUBE_API_FAILED');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('YOUTUBE_RESPONSE_INVALID');
  return body as Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dailyRows(report: Record<string, unknown>): Array<{ date: string; metrics: Record<string, number | null> }> {
  const headers = Array.isArray(report.columnHeaders) ? report.columnHeaders.map(h => String(object(h).name ?? '')) : [];
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const names = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'];
  return rows.slice(0, 31).flatMap(row => {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return [];
    const metrics: Record<string, number | null> = {};
    names.forEach(name => {
      const index = headers.indexOf(name);
      const value = index >= 0 ? Number(row[index]) : NaN;
      metrics[name] = Number.isFinite(value) ? value : null;
    });
    return [{ date: row[0], metrics }];
  });
}

export async function beginYouTubeConnect(p: YouTubePrincipal): Promise<string | 'NOT_CONFIGURED' | 'NOT_PERMITTED'> {
  const env = readYouTubeEnvironment();
  if (!env) return 'NOT_CONFIGURED';
  const profileId = await creatorProfileId(p);
  if (!profileId) return 'NOT_PERMITTED';
  const state = randomBytes(32).toString('base64url');
  const now = new Date();
  await prisma.youTubeOAuthState.deleteMany({
    where: { organizationId: p.organizationId, userId: p.userId, OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: now } }] },
  });
  const count = await prisma.youTubeOAuthState.count({ where: { organizationId: p.organizationId, userId: p.userId } });
  if (count >= 5) return 'TOO_MANY_ATTEMPTS';
  await prisma.youTubeOAuthState.create({
    data: { organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId, sessionId: p.sessionId, stateHash: hash(state), expiresAt: new Date(now.getTime() + 10 * 60_000) },
  });
  return redirectUrl(state, env.clientId, env.redirectUri);
}

export async function completeYouTubeConnect(p: YouTubePrincipal, input: { state: string | null; code: string | null; error: string | null }): Promise<string> {
  const env = readYouTubeEnvironment();
  if (!env) return 'NOT_CONFIGURED';
  if (!input.state || !STATE.test(input.state)) return 'STATE_INVALID';
  const now = new Date();
  const consumed = await prisma.youTubeOAuthState.updateMany({
    where: { organizationId: p.organizationId, userId: p.userId, sessionId: p.sessionId, stateHash: hash(input.state), consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return 'STATE_INVALID';
  if (input.error) return 'DECLINED';
  if (!input.code || !CODE.test(input.code)) return 'INVALID_REQUEST';
  const profileId = await creatorProfileId(p);
  if (!profileId) return 'NOT_PERMITTED';
  try {
    const grant = await exchange(input.code, env.clientId, env.clientSecret, env.redirectUri);
    const channelsUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelsUrl.searchParams.set('part', 'snippet,statistics');
    channelsUrl.searchParams.set('mine', 'true');
    const channels = await googleJson(channelsUrl, grant.access);
    const items = Array.isArray(channels.items) ? channels.items : [];
    const channel = object(items[0]);
    const snippet = object(channel.snippet);
    const statistics = object(channel.statistics);
    const channelId = typeof channel.id === 'string' ? channel.id : '';
    const channelTitle = typeof snippet.title === 'string' ? snippet.title.slice(0, 200) : '';
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(channelId) || !channelTitle) return 'CHANNEL_UNAVAILABLE';
    const previous = await prisma.youTubeConnection.findFirst({ where: { organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId }, select: { id: true, channelId: true } });
    await prisma.youTubeConnection.upsert({
      where: { creatorProfileId: profileId },
      create: {
        organizationId: p.organizationId,
        creatorProfileId: profileId,
        userId: p.userId,
        channelId,
        channelTitle,
        subscriberCount: typeof statistics.subscriberCount === 'string' ? statistics.subscriberCount : null,
        lifetimeViewCount: typeof statistics.viewCount === 'string' ? statistics.viewCount : null,
        videoCount: typeof statistics.videoCount === 'string' ? statistics.videoCount : null,
        refreshTokenSealed: seal(p, grant.refresh, env.tokenKey),
        scopes: [...grant.scopes],
        status: 'CONNECTED',
      },
      update: {
        userId: p.userId,
        channelId,
        channelTitle,
        subscriberCount: typeof statistics.subscriberCount === 'string' ? statistics.subscriberCount : null,
        lifetimeViewCount: typeof statistics.viewCount === 'string' ? statistics.viewCount : null,
        videoCount: typeof statistics.videoCount === 'string' ? statistics.videoCount : null,
        refreshTokenSealed: seal(p, grant.refresh, env.tokenKey),
        scopes: [...grant.scopes],
        status: 'CONNECTED',
        connectedAt: now,
        revokedAt: null,
        ...(previous && previous.channelId !== channelId ? { lastSyncedAt: null } : {}),
      },
    });
    if (previous && previous.channelId !== channelId) {
      await prisma.youTubeAnalyticsObservation.deleteMany({ where: { organizationId: p.organizationId, creatorProfileId: profileId, connectionId: previous.id } });
    }
    return 'CONNECTED';
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return 'ACCOUNT_IN_USE';
    return 'FAILED';
  }
}

export async function syncYouTubeAnalytics(p: YouTubePrincipal): Promise<'SYNCED' | 'NOT_CONNECTED' | 'NOT_CONFIGURED' | 'FAILED'> {
  const env = readYouTubeEnvironment();
  if (!env) return 'NOT_CONFIGURED';
  const profileId = await creatorProfileId(p);
  if (!profileId) return 'NOT_CONNECTED';
  const connection = await prisma.youTubeConnection.findFirst({ where: { organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId, status: 'CONNECTED' } });
  if (!connection?.refreshTokenSealed) return 'NOT_CONNECTED';
  if (connection.lastSyncedAt && Date.now() - connection.lastSyncedAt.getTime() < YOUTUBE_SYNC_MIN_INTERVAL_MS) return 'SYNCED';
  try {
    const refreshToken = open(p, connection.refreshTokenSealed, env.tokenKey);
    const fresh = await refreshAccess(refreshToken, env);
    const tokenToStore = fresh.refresh ?? refreshToken;
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 27);
    const reportUrl = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    reportUrl.searchParams.set('ids', 'channel==MINE');
    reportUrl.searchParams.set('startDate', dateOnly(start));
    reportUrl.searchParams.set('endDate', dateOnly(end));
    reportUrl.searchParams.set('metrics', 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost');
    reportUrl.searchParams.set('dimensions', 'day');
    reportUrl.searchParams.set('sort', 'day');
    const raw = await googleJson(reportUrl, fresh.access);
    const report = {
      period: { startDate: dateOnly(start), endDate: dateOnly(end) },
      columns: Array.isArray(raw.columnHeaders) ? raw.columnHeaders.map(h => String(object(h).name ?? '')) : [],
      daily: dailyRows(raw),
    };
    const savedAt = new Date();
    await prisma.youTubeConnection.update({
      where: { id: connection.id, organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId, status: 'CONNECTED' },
      data: {
        refreshTokenSealed: seal(p, tokenToStore, env.tokenKey),
        lastSyncedAt: savedAt,
      },
    });
    await prisma.youTubeAnalyticsObservation.create({
      data: {
        organizationId: p.organizationId,
        creatorProfileId: profileId,
        connectionId: connection.id,
        observedAt: savedAt,
        report: report as Prisma.InputJsonValue,
      },
    });
    return 'SYNCED';
  } catch {
    return 'FAILED';
  }
}

export async function disconnectYouTube(p: YouTubePrincipal): Promise<boolean> {
  const profileId = await creatorProfileId(p);
  if (!profileId) return false;
  const result = await prisma.youTubeConnection.updateMany({
    where: { organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId, status: 'CONNECTED' },
    data: { status: 'DISCONNECTED', refreshTokenSealed: null, revokedAt: new Date() },
  });
  if (result.count === 1) await prisma.youTubeAnalyticsObservation.deleteMany({ where: { organizationId: p.organizationId, creatorProfileId: profileId } });
  await prisma.youTubeOAuthState.deleteMany({ where: { organizationId: p.organizationId, userId: p.userId } });
  return result.count === 1;
}

export async function getYouTubeCreatorConnection(p: Pick<YouTubePrincipal, 'organizationId' | 'userId'>) {
  const profileId = await creatorProfileId(p);
  if (!profileId) return null;
  const connection = await prisma.youTubeConnection.findFirst({
    where: { organizationId: p.organizationId, creatorProfileId: profileId, userId: p.userId, status: 'CONNECTED' },
    select: { id: true, channelTitle: true, channelId: true, subscriberCount: true, lifetimeViewCount: true, videoCount: true, connectedAt: true, lastSyncedAt: true },
  });
  if (!connection) return null;
  const observation = await prisma.youTubeAnalyticsObservation.findFirst({
    where: { organizationId: p.organizationId, creatorProfileId: profileId, connectionId: connection.id },
    orderBy: { observedAt: 'desc' },
    select: { observedAt: true, report: true },
  });
  return { connection, observation };
}
