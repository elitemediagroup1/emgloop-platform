/** Read-only TikTok One Creator Marketplace API. No downloading of video/image bytes. */
export interface TtoVideo {
    id: string;
    caption: string;
    thumbnailUrl: string | null;
    thumbnailExpiresAt: string;
    url: string;
    createdAt: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
}
export interface TtoReport {
    handle: string;
    creatorId: string;
    displayName: string;
    avatarUrl: string | null;
    followers: number | null;
    medianViews: number | null;
    videos: TtoVideo[];
}
export class TtoReadError extends Error {
    constructor(readonly failure: 'UNAVAILABLE' | 'RATE_LIMITED' | 'PERMISSION_REQUIRED' | 'INVALID_RESPONSE' | 'IDENTITY_MISMATCH') { super(failure); }
}
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function ttoHandle(raw: unknown): string | null {
    if (typeof raw !== 'string')
        return null;
    let value = raw.trim();
    if (/^https:\/\//i.test(value)) {
        try {
            const u = new URL(value);
            if (!['www.tiktok.com', 'tiktok.com'].includes(u.hostname) || u.search || u.hash)
                return null;
            value = u.pathname.replace(/^\/+|\/+$/g, '');
        }
        catch {
            return null;
        }
    }
    value = value.replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_][a-z0-9_.]{0,23}$/.test(value) ? value : null;
}
export function ttoImage(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 4096)
        return null;
    try {
        const u = new URL(raw);
        const roots = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokcdn-eu.net', 'byteoversea.com', 'ibytedtos.com', 'byteimg.com', 'muscdn.com', 'tiktokv.com'];
        return u.protocol === 'https:' && !u.username && !u.password && !u.port && roots.some(d => u.hostname === d || u.hostname.endsWith('.' + d)) ? u.toString() : null;
    }
    catch {
        return null;
    }
}
function timestamp(v: unknown): string | null { const n = typeof v === 'string' && /^\d{10,16}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN; return Number.isSafeInteger(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString() : null; }
export function parseTtoReport(handle: string, profileRaw: unknown, videosRaw: unknown, now: Date): TtoReport {
    const p = obj(profileRaw), media = obj(videosRaw);
    if (ttoHandle(p.handle_name) !== handle || typeof p.creator_id !== 'string' || !p.creator_id || p.creator_id.length > 128)
        throw new TtoReadError('IDENTITY_MISMATCH');
    if (!Array.isArray(media.posts) || media.posts.length > 25)
        throw new TtoReadError('INVALID_RESPONSE');
    const seen = new Set<string>();
    const videos: TtoVideo[] = [];
    for (const raw of media.posts) {
        const v = obj(raw);
        if (typeof v.video_id !== 'string' || !/^\d{5,32}$/.test(v.video_id) || seen.has(v.video_id))
            continue;
        seen.add(v.video_id);
        let expires = +now + 6 * 86400000;
        const thumbnail = ttoImage(v.thumbnail_url);
        if (thumbnail) {
            const exp = Number(new URL(thumbnail).searchParams.get('x-expires'));
            if (Number.isSafeInteger(exp) && exp > 0)
                expires = Math.min(expires, exp * 1000);
        }
        videos.push({ id: v.video_id, caption: typeof v.caption === 'string' ? v.caption.slice(0, 160) : '', thumbnailUrl: expires > +now ? thumbnail : null, thumbnailExpiresAt: new Date(expires).toISOString(), url: `https://www.tiktok.com/@${handle}/video/${v.video_id}`, createdAt: timestamp(v.create_time), views: count(v.video_views), likes: count(v.likes), comments: count(v.comments), shares: count(v.shares) });
    }
    return { handle, creatorId: p.creator_id, displayName: typeof p.display_name === 'string' ? p.display_name.slice(0, 160) : handle, avatarUrl: ttoImage(p.profile_image), followers: count(p.followers_count), medianViews: count(p.median_views), videos: videos.slice(0, 10) };
}
/** Persisted report parser: no assertions that bypass the URL and shape checks. */
export function readTtoReport(raw: unknown, now: Date): TtoReport | null {
    const r = obj(raw);
    const handle = ttoHandle(r.handle);
    if (!handle || !Array.isArray(r.videos))
        return null;
    try {
        return parseTtoReport(handle, { handle_name: handle, creator_id: r.creatorId, display_name: r.displayName, profile_image: r.avatarUrl, followers_count: r.followers, median_views: r.medianViews }, { posts: r.videos.map(raw => { const v = obj(raw); return { video_id: v.id, caption: v.caption, thumbnail_url: typeof v.thumbnailExpiresAt === 'string' && Date.parse(v.thumbnailExpiresAt) > +now ? v.thumbnailUrl : null, create_time: typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : null, video_views: v.views, likes: v.likes, comments: v.comments, shares: v.shares }; }) }, now);
    }
    catch {
        return null;
    }
}
export class TtoPublicApi {
    constructor(private readonly config: {
        appId: string;
        secret: string;
    }, private readonly request: typeof fetch = fetch) { }
    private async get(path: string, accessToken: string, params: Record<string, string>) {
        const url = new URL(`https://business-api.tiktok.com/open_api/v1.3/${path}/`);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        try {
            const res = await this.request(url.toString(), { headers: { 'Access-Token': accessToken }, redirect: 'error', signal: AbortSignal.timeout(8000) });
            if (res.status === 429)
                throw new TtoReadError('RATE_LIMITED');
            if ([401, 403].includes(res.status))
                throw new TtoReadError('PERMISSION_REQUIRED');
            if (!res.ok)
                throw new TtoReadError('UNAVAILABLE');
            const text = await res.text();
            if (text.length > 500000)
                throw new TtoReadError('INVALID_RESPONSE');
            const envelope = obj(JSON.parse(text));
            if (envelope.code !== 0)
                throw new TtoReadError([40001, 40100, 40102, 40104, 40105, 40106].includes(Number(envelope.code)) ? 'PERMISSION_REQUIRED' : 'UNAVAILABLE');
            return obj(envelope.data);
        }
        catch (e) {
            if (e instanceof TtoReadError)
                throw e;
            throw new TtoReadError('UNAVAILABLE');
        }
    }
    async accounts(accessToken: string): Promise<string[]> {
        // TikTok explicitly requires app_id and secret in this server-only GET. Never log the URL.
        const data = await this.get('tto/oauth2/tcm', accessToken, { app_id: this.config.appId, secret: this.config.secret });
        if (!Array.isArray(data.tto_tcm_account_ids) || data.tto_tcm_account_ids.length > 100 || data.tto_tcm_account_ids.some(v => typeof v !== 'string' || !/^\d{5,32}$/.test(v)))
            throw new TtoReadError('INVALID_RESPONSE');
        return [...new Set(data.tto_tcm_account_ids as string[])];
    }
    async report(accessToken: string, accountId: string, handle: string, now: Date) {
        const params = { tto_tcm_account_id: accountId, handle_name: handle };
        const [profile, videos] = await Promise.all([this.get('tto/tcm/creator/public', accessToken, params), this.get('tto/tcm/creator/public/video/list', accessToken, { ...params, limit: '10', cursor: '0' })]);
        return parseTtoReport(handle, profile, videos, now);
    }
}
