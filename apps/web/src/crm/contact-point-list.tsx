// A Party's CRM Contact Points as the Contact Point authority returned them (PD-F-05). Server
// component; it renders the service's answer and decides nothing: a value is shown only when the
// service revealed it (EMPLOYEE and above), otherwise why it is not. One rendering for the Person
// record and the Opportunity record, so the two can never word it differently.

import type { CrmContactPointViewV1 } from '@emgloop/shared';
import type { TimeView } from '@emgloop/shared';
import { governedTerm } from './subject-display';

const CONTACT_KIND: Record<string, string> = { EMAIL: 'Email', PHONE: 'Phone' };

export type ContactPointsRead = { outcome: 'OK'; value: CrmContactPointViewV1[] } | { outcome: 'NOT_AUTHORIZED' } | null;

export function ContactPointList({ read, time, none }: { read: ContactPointsRead; time: TimeView; none: string }) {
  if (read === null) return <p className="loop-note">Contact points are not available on this workspace yet.</p>;
  if (read.outcome !== 'OK') return <p className="loop-note">Your role cannot see contact points.</p>;
  if (read.value.length === 0) return <p className="loop-note">{none}</p>;
  return (
    <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {read.value.map((point) => (
        <li key={point.id} className="loop-note">
          {CONTACT_KIND[point.kind]}: {point.value ?? (point.valueWithheld === 'ERASED' ? 'removed under retention' : 'hidden for your role')} ·{' '}
          {governedTerm(point.classification)} · {governedTerm(point.state)} · unverified, {point.basis === 'IMPORTED' ? 'imported' : 'recorded'}{' '}
          {time.date(point.addedAt)}
        </li>
      ))}
    </ul>
  );
}
