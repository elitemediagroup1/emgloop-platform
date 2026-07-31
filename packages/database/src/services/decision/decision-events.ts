// Lifecycle change -> domain event, bound to the Prisma enum.
//
// THE VOCABULARY IS NOT DEFINED HERE. It lives in `@emgloop/shared`
// (`decision-events.ts`) as the Decision Event Contract v1, because a subscriber
// must be able to depend on it without depending on persistence. This file does
// one thing the contract cannot: it binds that map to the PRISMA enum, so the
// database's notion of an observation type and the contract's notion cannot
// drift apart silently.
//
// The binding is the check. `Record<OperationalObservationType, DecisionEventName>`
// fails to compile if the Prisma enum gains a member the contract does not map,
// or if the contract maps one to a name that is not in the vocabulary. A test
// then walks it in the other direction — every contract event reachable, every
// published name declared.
//
// ONE event per lifecycle operation, published through the platform's single
// outbox. The Decision Engine knows nothing about who consumes them: no
// subscriber is named here, no delivery is attempted here, and adding a consumer
// never requires touching this file.

import type { OperationalObservationType } from '@prisma/client';
import {
  DECISION_EVENT_TYPE as CONTRACT_EVENT_TYPE,
  type DecisionEventName,
} from '@emgloop/shared';

/**
 * The event a given observation announces, keyed by the Prisma enum.
 *
 * A re-export with a stricter type, never a second table. If this line stops
 * compiling, the contract and the schema have diverged — fix the contract, do
 * not widen this type.
 */
export const DECISION_EVENT_TYPE: Record<OperationalObservationType, DecisionEventName> =
  CONTRACT_EVENT_TYPE;

export { decisionStateKey, type DecisionEventName } from '@emgloop/shared';
