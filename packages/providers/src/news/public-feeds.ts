import { PUBLIC_NEWS_FEEDS, type PublicNewsFeed, type PublicNewsArticle } from '@emgloop/shared';
export { PUBLIC_NEWS_FEEDS } from '@emgloop/shared';
export type { PublicNewsFeed, PublicNewsArticle } from '@emgloop/shared';

export type PublicNewsFailureCode = 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'EMPTY_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'INVALID_FEED';
export interface PublicNewsFailure { readonly code: PublicNewsFailureCode; readonly httpStatus?: number }

/** Fixed codes only: neither response bodies, URLs nor network exception messages leave this boundary. */
export class PublicNewsReadError extends Error {
  constructor(readonly code: PublicNewsFailureCode, readonly httpStatus?: number) {
    super(code);
    this.name = 'PublicNewsReadError';
  }
}
export function publicNewsFailure(error: unknown): PublicNewsFailure {
  if (error instanceof PublicNewsReadError) return { code: error.code, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  return { code: name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
}

const text = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (v) => {
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  if (named[v]) return named[v];
  const n = v[2]?.toLowerCase() === 'x' ? parseInt(v.slice(3, -1), 16) : parseInt(v.slice(2, -1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
}).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Deliberately narrow RSS subset: no HTML bodies, DTDs, entity expansion or external references. */
export function parsePublicNewsRss(xml: string, feed: PublicNewsFeed, now: Date): PublicNewsArticle[] {
  if (Buffer.byteLength(xml) > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) throw new PublicNewsReadError('INVALID_FEED');
  const tag = (item: string, name: string) => text(item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'))?.[1] ?? '');
  const out = new Map<string, PublicNewsArticle>();
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
    const item = match[1]!;
    const title = tag(item, 'title');
    const rawUrl = tag(item, 'link');
    const publishedAt = new Date(tag(item, 'pubDate') || tag(item, 'dc:date'));
    if (!title || title.length > 400 || !Number.isFinite(publishedAt.getTime()) || publishedAt > now || publishedAt.getTime() < now.getTime() - 14 * 864e5) continue;
    let url: URL;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(feed.hosts as readonly string[]).includes(url.hostname)) continue;
    url.hash = '';
    out.set(url.href, { sourceId: feed.id, publisher: feed.name, title, url: url.href, publishedAt });
    if (out.size >= 40) break;
  }
  return [...out.values()];
}

export async function fetchPublicNews(feed: PublicNewsFeed, now: Date, fetcher: typeof fetch = fetch): Promise<PublicNewsArticle[]> {
  try {
    const response = await fetcher(feed.url, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'EMGLoop/1.0 (+public-news-metadata)' } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicNewsReadError('HTTP_ERROR', response.status);
    }
    if (Number(response.headers.get('content-length') ?? 0) > 1_000_000) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicNewsReadError('RESPONSE_TOO_LARGE');
    }
    if (!response.body) throw new PublicNewsReadError('EMPTY_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_000_000) throw new PublicNewsReadError('RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return parsePublicNewsRss(Buffer.concat(chunks).toString('utf8'), feed, now);
  } catch (error) {
    const failure = publicNewsFailure(error);
    throw new PublicNewsReadError(failure.code, failure.httpStatus);
  }
}
