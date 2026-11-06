// Meta Facebook Login / Graph API. No persistence, environment reads or provider error text.
// One Facebook Page and its linked professional Instagram account are explicitly selected.
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights'] as const;
export type MetaFailure = 'TOKEN_EXPIRED' | 'PERMISSION_REQUIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'METRIC_UNAVAILABLE';
export type MetaOAuthStage = 'CODE_EXCHANGE' | 'LONG_LIVED_EXCHANGE' | 'IDENTITY_READ' | 'PERMISSIONS_READ';
export interface MetaApiDiagnostic {
  stage?: MetaOAuthStage;
  httpStatus?: number;
  graphCode?: number;
  graphSubcode?: number;
  invalidResponse?: 'TOKEN_MISSING' | 'EXPIRY_MISSING' | 'IDENTITY_MISSING' | 'PERMISSIONS_MISSING';
}
export class MetaApiError extends Error {
  constructor(readonly failure: MetaFailure, readonly diagnostic: MetaApiDiagnostic = {}) { super(failure); }
}
export interface MetaConfig { appId: string; appSecret: string; redirectUri: string; version: string; configId?: string }
export interface MetaPage { id: string; name: string; accessToken: string; instagramId: string | null }
export interface MetaMetric { name: string; value: number | null; failure: MetaFailure | null }
export interface MetaMedia { id: string; type: string; publishedAt: string | null; permalink: string | null; metrics: MetaMetric[] }
export interface MetaReport {
  platform: 'INSTAGRAM' | 'FACEBOOK'; accountId: string; name: string;
  followers: number | null; windowStart: string; windowEnd: string;
  metrics: MetaMetric[]; media: MetaMedia[]; limitations: string[];
}
export const metaObject = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const id = (v: unknown): string | null => typeof v === 'string' && /^\d+(?:_\d+)?$/.test(v) ? v : null;
const errorNumber = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

export function metaAuthorizationUrl(config: MetaConfig, state: string): string {
  const query = new URLSearchParams({ client_id: config.appId, redirect_uri: config.redirectUri, state, response_type: 'code' });
  if (config.configId) query.set('config_id', config.configId);
  else { query.set('scope', META_SCOPES.join(',')); query.set('auth_type', 'rerequest'); }
  return `https://www.facebook.com/${config.version}/dialog/oauth?${query}`;
}

export class MetaApi {
  private readonly deadline = Date.now() + 40_000;
  constructor(readonly config: MetaConfig, private readonly fetcher: typeof fetch = fetch) {}
  async request(path: string, token: string | null, params: Record<string, string> = {}, method = 'GET'): Promise<Record<string, unknown>> {
    const url = new URL(`https://graph.facebook.com/${this.config.version}/${path}`);
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = { accept: 'application/json', 'cache-control': 'no-store' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (method === 'GET') url.search = query.toString();
    else headers['content-type'] = 'application/x-www-form-urlencoded';
    try {
      if (Date.now() >= this.deadline) throw new MetaApiError('UNAVAILABLE');
      const response = await this.fetcher(url, { method, headers, ...(method === 'GET' ? {} : { body: query.toString() }), redirect: 'error', signal: AbortSignal.timeout(Math.min(8_000, this.deadline - Date.now())) });
      const body = metaObject(await response.json());
      const error = metaObject(body.error);
      if (!response.ok || body.error) {
        const code = error.code;
        throw new MetaApiError(code === 190 ? 'TOKEN_EXPIRED' : [4, 17, 32, 613].includes(Number(code)) || response.status === 429 ? 'RATE_LIMITED' : [10, 200].includes(Number(code)) ? 'PERMISSION_REQUIRED' : code === 100 ? 'METRIC_UNAVAILABLE' : 'UNAVAILABLE', { httpStatus: response.status, graphCode: errorNumber(code), graphSubcode: errorNumber(error.error_subcode) });
      }
      return body;
    } catch (error) { if (error instanceof MetaApiError) throw error; throw new MetaApiError('UNAVAILABLE'); }
  }
  private async authorizationRequest(stage: MetaOAuthStage, path: string, token: string | null, params: Record<string, string> = {}, method = 'GET') {
    try { return await this.request(path, token, params, method); }
    catch (error) {
      if (error instanceof MetaApiError) throw new MetaApiError(error.failure, { ...error.diagnostic, stage });
      throw new MetaApiError('UNAVAILABLE', { stage });
    }
  }
  async exchange(code: string): Promise<{ token: string; expiresIn: number; userId: string; scopes: string[] }> {
    const credentials = { client_id: this.config.appId, client_secret: this.config.appSecret };
    const short = await this.authorizationRequest('CODE_EXCHANGE', 'oauth/access_token', null, { ...credentials, code, redirect_uri: this.config.redirectUri }, 'POST');
    if (!str(short.access_token)) throw new MetaApiError('UNAVAILABLE', { stage: 'CODE_EXCHANGE', invalidResponse: 'TOKEN_MISSING' });
    const long = await this.authorizationRequest('LONG_LIVED_EXCHANGE', 'oauth/access_token', null, { ...credentials, grant_type: 'fb_exchange_token', fb_exchange_token: String(short.access_token) }, 'POST');
    const token = str(long.access_token);
    if (!token) throw new MetaApiError('UNAVAILABLE', { stage: 'LONG_LIVED_EXCHANGE', invalidResponse: 'TOKEN_MISSING' });
    if (!num(long.expires_in)) throw new MetaApiError('UNAVAILABLE', { stage: 'LONG_LIVED_EXCHANGE', invalidResponse: 'EXPIRY_MISSING' });
    const me = await this.authorizationRequest('IDENTITY_READ', 'me', token, { fields: 'id' });
    if (!id(me.id)) throw new MetaApiError('UNAVAILABLE', { stage: 'IDENTITY_READ', invalidResponse: 'IDENTITY_MISSING' });
    const permissions = await this.authorizationRequest('PERMISSIONS_READ', 'me/permissions', token);
    if (!Array.isArray(permissions.data)) throw new MetaApiError('UNAVAILABLE', { stage: 'PERMISSIONS_READ', invalidResponse: 'PERMISSIONS_MISSING' });
    const scopes = (Array.isArray(permissions.data) ? permissions.data : []).map(metaObject).filter(p => p.status === 'granted').map(p => str(p.permission)).filter((p): p is string => p !== null);
    return { token, expiresIn: Number(long.expires_in), userId: String(me.id), scopes };
  }
  async pages(token: string): Promise<MetaPage[]> {
    const pages: MetaPage[] = [];
    let after: string | undefined;
    for (let n = 0; n < 10; n++) {
      const body = await this.request('me/accounts', token, { fields: 'id,name,access_token,tasks,instagram_business_account', limit: '100', ...(after ? { after } : {}) });
      for (const raw of Array.isArray(body.data) ? body.data : []) {
        const page = metaObject(raw);
        const tasks = Array.isArray(page.tasks) ? page.tasks : [];
        if (id(page.id) && str(page.access_token) && (tasks.includes('ANALYZE') || tasks.includes('MANAGE'))) pages.push({ id: String(page.id), name: str(page.name) ?? 'Facebook Page', accessToken: String(page.access_token), instagramId: id(metaObject(page.instagram_business_account).id) });
      }
      const paging = metaObject(body.paging);
      after = str(metaObject(paging.cursors).after) ?? undefined;
      if (!paging.next) return pages;
      if (!after) throw new MetaApiError('UNAVAILABLE');
    }
    // Never silently omit pages from a capped list.
    throw new MetaApiError('UNAVAILABLE');
  }
  async metric(accountId: string, token: string, name: string, params: Record<string, string>): Promise<MetaMetric> {
    try {
      const result = await this.request(`${accountId}/insights`, token, { metric: name, ...params });
      const row = metaObject(Array.isArray(result.data) ? result.data[0] : null);
      const total = num(metaObject(row.total_value).value);
      const values = Array.isArray(row.values) ? row.values.map(v => num(metaObject(v).value)) : [];
      const value = total ?? (values.length > 0 && values.every(v => v !== null) ? values.reduce<number>((sum, v) => sum + (v as number), 0) : null);
      return { name, value, failure: value === null ? 'METRIC_UNAVAILABLE' : null };
    } catch (error) {
      if (!(error instanceof MetaApiError) || ['TOKEN_EXPIRED', 'RATE_LIMITED', 'UNAVAILABLE'].includes(error.failure)) throw error;
      return { name, value: null, failure: error.failure };
    }
  }
  async report(page: MetaPage, platform: 'INSTAGRAM' | 'FACEBOOK', now: Date, userToken?: string): Promise<MetaReport> {
    const accountId = platform === 'INSTAGRAM' ? page.instagramId : page.id;
    if (!accountId || !id(accountId)) throw new MetaApiError('UNAVAILABLE');
    const analyticsToken = platform === 'INSTAGRAM' ? userToken ?? page.accessToken : page.accessToken;
    // Complete UTC days, excluding today's partially reported day. Reach is not summed across days.
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - 28 * 86400_000);
    const profile = await this.request(accountId, analyticsToken, { fields: platform === 'INSTAGRAM' ? 'id,username,followers_count' : 'id,name,followers_count' });
    const params = { since: String(start.getTime() / 1000), until: String(end.getTime() / 1000 - 1), period: 'day' };
    const metrics = await Promise.all((platform === 'INSTAGRAM' ? ['views', 'reach', 'total_interactions'] : ['page_media_view', 'page_post_engagements']).map(name => this.metric(accountId, analyticsToken, name, platform === 'INSTAGRAM' ? { ...params, metric_type: 'total_value' } : params)));
    const media: MetaMedia[] = [];
    const limitations = ['Last 28 complete UTC days. Meta may delay insights by up to 48 hours, withhold metrics or estimate reach. Unavailable is not zero.', 'Recent content is a bounded sample of up to 6 items; content metrics are lifetime counts, not window totals.'];
    try {
      const posts = await this.request(`${accountId}/${platform === 'INSTAGRAM' ? 'media' : 'posts'}`, analyticsToken, { fields: platform === 'INSTAGRAM' ? 'id,media_type,media_product_type,timestamp,permalink' : 'id,created_time,permalink_url', limit: '6' });
      const rawPosts = (Array.isArray(posts.data) ? posts.data : []).slice(0, 6);
      for (let offset = 0; offset < rawPosts.length; offset += 3) {
        const batch = await Promise.all(rawPosts.slice(offset, offset + 3).map(async raw => {
        const post = metaObject(raw);
        if (!id(post.id)) return null;
        const postMetrics = await Promise.all((platform === 'INSTAGRAM' ? ['views', 'reach', 'total_interactions'] : ['post_media_view']).map(name => this.metric(String(post.id), analyticsToken, name, {})));
        return { id: String(post.id), type: str(post.media_product_type) ?? str(post.media_type) ?? 'POST', publishedAt: str(post.timestamp) ?? str(post.created_time), permalink: str(post.permalink) ?? str(post.permalink_url), metrics: postMetrics };
        }));
        media.push(...batch.filter((row): row is NonNullable<typeof row> => row !== null));
      }
    } catch (error) { if (error instanceof MetaApiError && error.failure === 'TOKEN_EXPIRED') throw error; limitations.push('Recent content could not be fully read.'); }
    return { platform, accountId, name: str(profile.username) ?? str(profile.name) ?? page.name, followers: num(profile.followers_count), windowStart: start.toISOString(), windowEnd: end.toISOString(), metrics, media, limitations };
  }
}
