export function supportedMeetingUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;

    const host = url.hostname;
    const meet = host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname);
    const zoom = (host === 'zoom.us' || host.endsWith('.zoom.us')) && /^\/j\/\d{9,11}\/?$/.test(url.pathname);
    const teams = host === 'teams.microsoft.com' && /^\/(?:l\/meetup-join\/[^/]+\/[^/]+|meet\/\d+)\/?$/.test(url.pathname);
    const webex = host.endsWith('.webex.com') && (
      /^\/meet\/[a-z\d._-]+\/?$/i.test(url.pathname) ||
      (/^\/webappng\/sites\/[a-z\d-]+\/meeting\/join$/i.test(url.pathname) && url.searchParams.has('MTID'))
    );
    if (!meet && !zoom && !teams && !webex) return null;
    url.hash = '';
    if (meet) {
      url.search = '';
      url.pathname = url.pathname.replace(/\/$/, '');
    }
    return url.href;
  } catch {
    return null;
  }
}
