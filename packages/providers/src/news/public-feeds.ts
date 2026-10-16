/** Public RSS metadata only. Fixed endpoints, no search terms, private data or credentials. */
export const PUBLIC_NEWS_FEEDS = [
  { id: 'ftc', name: 'FTC', url: 'https://www.ftc.gov/feeds/press-release.xml', hosts: ['www.ftc.gov', 'ftc.gov'] },
  { id: 'google-ads', name: 'Google Ads & Commerce', url: 'https://blog.google/products/ads-commerce/rss/', hosts: ['blog.google'] },
  { id: 'youtube', name: 'YouTube', url: 'https://blog.youtube/rss/', hosts: ['blog.youtube'] },
  { id: 'digiday', name: 'Digiday', url: 'https://digiday.com/feed/', hosts: ['digiday.com', 'www.digiday.com'] },
  { id: 'search-engine-land', name: 'Search Engine Land', url: 'https://searchengineland.com/feed', hosts: ['searchengineland.com', 'www.searchengineland.com'] },
] as const;
export type PublicNewsFeed = (typeof PUBLIC_NEWS_FEEDS)[number];
export interface PublicNewsArticle { sourceId: string; publisher: string; title: string; url: string; publishedAt: Date }

const text = (value: string) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (v) => {
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  if (named[v]) return named[v];
  const n = v[2]?.toLowerCase() === 'x' ? parseInt(v.slice(3, -1), 16) : parseInt(v.slice(2, -1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
}).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Deliberately narrow RSS subset: no HTML bodies, DTDs, entity expansion or external references. */
export function parsePublicNewsRss(xml: string, feed: PublicNewsFeed, now: Date): PublicNewsArticle[] {
  if (Buffer.byteLength(xml) > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) throw new Error('INVALID_NEWS_FEED');
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
  const response = await fetcher(feed.url, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'EMGLoop/1.0 (+public-news-metadata)' } });
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('NEWS_FETCH_FAILED');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1_000_000) throw new Error('NEWS_FEED_TOO_LARGE');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return parsePublicNewsRss(Buffer.concat(chunks).toString('utf8'), feed, now);
}
