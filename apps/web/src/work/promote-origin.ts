// Promote to Work: how an origin travels in a URL on the page that shows it (Loop Intelligence Phase C).
// PURE. The confirmation is rendered on the SAME page (no new subpage): `?promote=...` names the origin,
// the server re-resolves it inside the signed session's own scope, and a person confirms.
//
// The URL carries only what identifies the origin inside the viewer's OWN scope -- a keyed reference,
// never content, never an organization or a user. Anything that does not parse is ignored.

import type { PromoteOrigin } from '@emgloop/shared';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN = /^[A-Z][A-Z_]{1,31}$/;
const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/;
const SIGNAL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Search params for an origin. */
export function promoteParams(origin: PromoteOrigin): Record<string, string> {
  switch (origin.kind) {
    case 'WORK_ITEM':
      return { promote: 'item', id: origin.itemId };
    case 'CASE':
      return { promote: 'case', id: origin.caseId };
    case 'DIGEST_SIGNAL':
      return { promote: origin.scope === 'PRINCIPAL' ? 'signal' : 'org-signal', d: origin.domain, k: origin.subjectKind, s: origin.subjectRef, g: origin.signalKey };
  }
}

export function promoteHref(path: string, origin: PromoteOrigin): string {
  return `${path}?${new URLSearchParams(promoteParams(origin)).toString()}#promote`;
}

/** The origin named by a page's search params (or a form), or null when none parses. */
export function promoteOriginFrom(get: (key: string) => string | null | undefined): PromoteOrigin | null {
  const kind = get('promote');
  const one = (k: string) => {
    const v = get(k);
    return typeof v === 'string' ? v : '';
  };
  if (kind === 'item') return ID.test(one('id')) ? { kind: 'WORK_ITEM', itemId: one('id') } : null;
  if (kind === 'case') return ID.test(one('id')) ? { kind: 'CASE', caseId: one('id') } : null;
  if (kind === 'signal' || kind === 'org-signal') {
    const [d, k, s, g] = [one('d'), one('k'), one('s'), one('g')];
    if (!DOMAIN.test(d) || !DOMAIN.test(k) || !SUBJECT_REF.test(s) || !SIGNAL_KEY.test(g)) return null;
    return { kind: 'DIGEST_SIGNAL', scope: kind === 'signal' ? 'PRINCIPAL' : 'ORGANIZATION', domain: d, subjectKind: k, subjectRef: s, signalKey: g };
  }
  return null;
}
