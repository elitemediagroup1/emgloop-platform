/** Least-privilege scopes for the creator's read-only YouTube connection. */
export const YOUTUBE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const);
export const YOUTUBE_CALLBACK_PATH = '/api/integrations/youtube/callback';
export const YOUTUBE_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000;
