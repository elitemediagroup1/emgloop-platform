// What deserves your attention first, and why.
//
// THE USER COMES FROM THE SIGNED SESSION. Never from a param — a queue that
// could be asked for on somebody else's behalf would be a cross-user read
// wearing a URL.
//
// THIS IS NOT THE ALL-CLEAR SCREEN. An empty personal queue means nothing is
// currently yours; whether anything needs the organization's attention is a
// different question, answered by Headlines from governed coverage. Collapsing
// the two would let "nobody has asked me anything" read as "the business is
// fine".

import Link from 'next/link';

import { PersonalPriorityService, prisma } from '@emgloop/database';
import type { PersonalQueueView } from '@emgloop/database';

import { requirePermission } from '../../../../auth/guard';
import { greeting } from '../../_loop-os/format';
import { ReadError } from '../../_loop-os/product-state';
import { PersonalQueue } from './queue-ui';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  const session = await requirePermission('commercialIntelligence', 'view');

  let queue: PersonalQueueView | null = null;
  let failed = false;
  try {
    queue = await new PersonalPriorityService(prisma).queueFor(
      session.organizationId,
      // FROM THE SESSION. The service also scopes every read to the
      // organization first, so a user id from another tenant matches nothing.
      session.userId,
    );
  } catch {
    failed = true;
  }

  return (
    <div className="hl-page">
      <header className="hl-page__head">
        <p className="hl-page__eyebrow">Your queue</p>
        <h1 className="hl-page__title">
          {greeting()}
          {session.name ? ', ' + session.name.split(' ')[0] : ''}.
        </h1>
        <p className="hl-page__sub">
          What is waiting on you, in the order Loop can defend.
        </p>
      </header>

      {failed || !queue ? (
        <ReadError what="your queue" retryHref="/app/admin/queue" />
      ) : (
        <PersonalQueue queue={queue} />
      )}

      <footer className="hl-page__foot">
        <Link href="/app/admin/headlines" className="hl-page__link">
          Today's Headlines
        </Link>
      </footer>
    </div>
  );
}
