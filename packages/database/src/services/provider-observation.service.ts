// ProviderObservationService -- certifying that a business date was observed.
//
// It does ONE thing: read a bounded provider window covering one complete Eastern
// business day, work out whether that read exhausted, and write a single
// ProviderObservationDay recording the answer.
//
// IT NEVER INGESTS. No Interaction, no MarketplaceCall, no projection, no
// IngestionService, no IntegrationEvent. Certification and recovery are different
// operations with different risks, and folding them together would make it
// impossible to establish that a day was genuinely empty without also writing to
// it. Recovering a historical day is a separate operation and a separate decision.
//
// IT NEVER INFERS. A day certifies because a bounded query over its exact UTC
// interval exhausted the provider's pagination without error -- not because rows
// exist, not because a webhook arrived, not because the neighbouring days look
// healthy, and not because a human said so. Those are all evidence that SOMETHING
// arrived; none of them is evidence that EVERYTHING did.
//
// THE CAP IS A SAFETY BOUND, NOT A COMPLETENESS MECHANISM. Reaching it while the
// provider still has pages produces PARTIAL_PAGINATION, which does not certify.
// Raising the cap until the symptom disappears would restore precisely the defect
// this exists to remove: the previous adapter stopped at 25 pages and reported a
// clean finish, so a 6,918-call day came back as 2,500 and read as the whole day.

import type { PrismaClient } from '@prisma/client';
import {
  BUSINESS_TIME_ZONE,
  easternBusinessDayWindow,
  isBusinessDate,
  type BusinessDate,
  type ProviderObservationStatus,
} from '@emgloop/shared';
import {
  ProviderObservationRepository,
  type ObservationDayView,
} from '../repositories/provider-observation.repository';

/** The only provider this version can certify. */
export const CALLGRID_PROVIDER = 'callgrid';
/** The only stream this version can certify: the calls endpoint. */
export const CALLS_STREAM = 'calls';
/** The only way a day may be established. Recorded on every row. */
export const PROVIDER_QUERY_SOURCE = 'provider-query';

/**
 * Page budget for a one-day certification.
 *
 * Sized from observed production volume rather than guessed: the busiest Eastern
 * day on record carried 6,918 calls, which is 70 pages at the adapter's 100
 * records per page. 100 pages leaves headroom above that while still bounding a
 * provider that always reports another page. It is NOT a claim that 10,000 calls
 * is the maximum -- a day beyond it is reported PARTIAL_PAGINATION and does not
 * certify, which is the entire point of keeping a cap at all.
 */
export const CERTIFICATION_PAGE_CAP = 100;

export interface CertifyDayInput {
  organizationId: string;
  /** The Eastern calendar day to certify, 'YYYY-MM-DD'. */
  businessDate: BusinessDate;
  /** Provider credential. Never stored, never logged, never returned. */
  apiKey: string;
  apiBaseUrl?: string;
  /** Injected so the caller owns the clock and a test can pin it. */
  now: Date;
  /** Override the page budget. Lowering it in a test is how truncation is proved. */
  pageCap?: number;
}

/** Map a provider failure to the outcome that describes it. */
function statusForErrorKind(kind: string | undefined): ProviderObservationStatus {
  switch (kind) {
    case 'non-json':
      return 'MALFORMED_RESPONSE';
    case 'unrecognised-envelope':
      // A shape we cannot read is NEVER an empty day. The adapter already refuses
      // to conflate the two; this keeps that refusal in the ledger.
      return 'UNKNOWN_ENVELOPE';
    case 'no-occurrence':
      // A record with no usable timestamp means the page could not be interpreted,
      // so the window was not observed. It is a malformed payload, not a zero.
      return 'MALFORMED_RESPONSE';
    case 'no-identity':
      // Same argument, the other half of the contract. A record with no provider
      // id cannot enter an identity comparison, so a window containing one was
      // not interpretable either. Certifying or not is unchanged -- both were
      // already non-certifying -- this only stops the ledger recording an
      // endpoint failure for a payload defect.
      return 'MALFORMED_RESPONSE';
    default:
      return 'ENDPOINT_FAILURE';
  }
}

export class ProviderObservationService {
  private readonly observations: ProviderObservationRepository;

  constructor(
    prisma: PrismaClient,
    observations?: ProviderObservationRepository,
  ) {
    this.observations = observations ?? new ProviderObservationRepository(prisma);
  }

  /**
   * Observe one complete Eastern business day and record what was seen.
   *
   * Always writes exactly one row, including for a failure: "we tried on this date
   * and the provider was unreachable" is a fact worth keeping, and a run that
   * silently wrote nothing on failure would leave the day looking untried.
   */
  async certifyDay(input: CertifyDayInput): Promise<ObservationDayView> {
    if (!isBusinessDate(input.businessDate)) {
      throw new Error(`Not a business date: ${String(input.businessDate)} (expected YYYY-MM-DD)`);
    }
    // The window comes from business-time.ts, the ONE place allowed to decide what
    // an Eastern day is. Deriving it here -- or adding 24 hours to a midnight --
    // would put certification and measurement on different boundaries twice a year.
    const window = easternBusinessDayWindow(input.businessDate);
    const pageCap = input.pageCap && input.pageCap > 0 ? input.pageCap : CERTIFICATION_PAGE_CAP;

    const base = {
      provider: CALLGRID_PROVIDER,
      stream: CALLS_STREAM,
      businessDate: input.businessDate,
      timezone: BUSINESS_TIME_ZONE,
      windowStart: window.start,
      windowEnd: window.end,
      observedAt: input.now,
      source: PROVIDER_QUERY_SOURCE,
      pageCap,
    };

    const providers = await import('@emgloop/providers');
    const provider = providers.getCallGridProvider();

    let page: Awaited<ReturnType<typeof provider.poll>>;
    try {
      page = await provider.poll(
        {
          organizationId: input.organizationId,
          credentials: { apiKey: input.apiKey },
          config: input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {},
        },
        { since: window.start, until: window.end, maxPages: pageCap },
      );
    } catch (error) {
      // The message may name a host or a status. It must never carry the key, and
      // the adapter's own messages do not -- but scrub defensively anyway, because
      // this string is persisted and later rendered.
      const kind = (error as { kind?: string }).kind;
      const detail =
        error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'unknown';
      return this.observations.recordDay(input.organizationId, {
        ...base,
        status: statusForErrorKind(kind),
        recordsObserved: 0,
        providerStatedTotal: null,
        pagesFetched: 0,
        truncated: false,
        reason: detail,
      });
    }

    const recordsObserved = page.recordsFetched ?? page.events.length;
    const pagesFetched = page.pagesFetched ?? 0;
    const truncated = page.truncated === true;

    // ORDER MATTERS. Truncation is checked BEFORE emptiness, because a truncated
    // read that happened to map zero events is not an empty day -- it is a day we
    // did not finish looking at. Testing `records === 0` first would certify the
    // most dangerous case of all.
    const status: ProviderObservationStatus = truncated
      ? 'PARTIAL_PAGINATION'
      : recordsObserved === 0
        ? 'EMPTY'
        : 'SUCCESS';

    return this.observations.recordDay(input.organizationId, {
      ...base,
      status,
      recordsObserved,
      // CallGrid's calls endpoint states no total. Left null rather than echoing
      // our own count back as if the provider had confirmed it.
      providerStatedTotal: null,
      pagesFetched,
      truncated,
      reason: truncated
        ? `Stopped at the ${pageCap}-page budget while the provider still had pages. ` +
          'What was read is a lower bound, so this day is not certified.'
        : null,
    });
  }
}
