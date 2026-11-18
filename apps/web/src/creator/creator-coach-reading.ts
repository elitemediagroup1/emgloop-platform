import { parseDomainReadingOutput } from '@emgloop/shared';
export function acceptedCreatorCoachReading(value: unknown) {
  const raw = value && typeof value === 'object' ? value : {};
  // The gateway omits empty entity lists in its canonical persisted signals. Restore
  // that optional field before validating the saved reading against the wire schema.
  const saved = raw as Record<string, unknown>;
  const signals = Array.isArray(saved.signals)
    ? saved.signals.map((signal) =>
        signal && typeof signal === 'object' ? { entities: [], ...signal } : signal,
      )
    : saved.signals;
  return parseDomainReadingOutput({ schemaId: 'domain-reading.v1', ...saved, signals })
    ?.domainReading;
}
