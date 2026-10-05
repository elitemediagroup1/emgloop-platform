// Display helpers shared by the Website Visitors list and the journey page. Pure, no I/O.

import type { JourneyCounts, JourneyTraffic } from '@emgloop/shared';

/** How a visit arrived, for a person: "google / cpc", a referring host, or "Direct". */
export function trafficLabel(t: JourneyTraffic): string {
  if (t.kind === 'CAMPAIGN') return [t.source, t.medium].filter(Boolean).join(' / ') || 'Campaign';
  if (t.kind === 'REFERRAL') return t.referrerHost;
  return 'Direct';
}

/** The actions worth a glance, in the order a visit tends to deepen. */
export function actionSummary(c: JourneyCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(n === 1 ? one : `${n} ${many}`);
  };
  add(c.searches, '1 search', 'searches');
  add(c.ctaClicks, '1 CTA click', 'CTA clicks');
  add(c.outboundClicks, '1 outbound click', 'outbound clicks');
  add(c.downloads, '1 download', 'downloads');
  add(c.formStarts, 'form started', 'forms started');
  add(c.formSubmits, 'form submitted', 'forms submitted');
  add(c.phoneClicks, 'phone click', 'phone clicks');
  add(c.emailClicks, 'email click', 'email clicks');
  add(c.appointmentRequests, 'appointment requested', 'appointment requests');
  add(c.chat, 'chat', 'chat events');
  add(c.planner, 'planner', 'planner events');
  return parts.length > 0 ? parts.join(' · ') : 'Browsing only';
}
