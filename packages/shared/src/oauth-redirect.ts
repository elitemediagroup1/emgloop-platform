// The redirect URI an OAuth provider must send a person back to. PURE.
//
// One rule for every provider connection (Google Workspace, TikTok): the URI is this
// deployment's canonical origin plus the provider's one static callback path. Only an https
// origin, or plain http on localhost for a separate development client, is accepted; a path,
// query, fragment or credential in the origin is refused, because the registered redirect
// URI must match the request byte for byte.

export function oauthRedirectUri(origin: string, callbackPath: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return `${url.origin}${callbackPath}`;
}
