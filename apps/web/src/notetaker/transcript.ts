type Segment = {
  participant?: { name?: string | null };
  words?: { text?: string; start_timestamp?: { relative?: number } }[];
};

export function recallTranscriptDownloadUrl(address: string): URL {
  const url = new URL(address);
  const supportedHost = url.hostname === 'recall.ai' || url.hostname.endsWith('.recall.ai') ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(url.hostname) ||
    url.hostname === 'storage.googleapis.com';
  if (!supportedHost || url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Unexpected Recall transcript download host: ' + url.hostname);
  }
  return url;
}

export function formatRecallTranscript(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('Unexpected Recall transcript format.');
  return (value as Segment[]).flatMap(segment => {
    if (!segment || !Array.isArray(segment.words)) return [];
    const words = segment.words.filter(word => typeof word?.text === 'string');
    const speech = words.map(word => word.text).join(' ').trim();
    if (!speech) return [];
    const seconds = words[0]?.start_timestamp?.relative;
    const timestamp = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? `[${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}] `
      : '';
    const speaker = typeof segment.participant?.name === 'string' ? segment.participant.name.trim() : '';
    return [`${timestamp}${speaker || 'Unidentified speaker'}: ${speech}`];
  }).join('\n\n');
}
