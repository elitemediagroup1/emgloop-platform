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

