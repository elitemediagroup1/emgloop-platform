// Structured logs and metrics that can carry identifiers and codes, and nothing else. Slice B6.
//
// NOTHING SENSITIVE CAN BE LOGGED BY ACCIDENT. A log line is built only from the fields
// named below, each a scalar or a short list of codes. There is no free-text message
// field, no payload field and no error-object passthrough: a prompt, a reply, a context
// block, a model answer, a token or a secret has no key to travel under. Unknown keys
// are dropped and counted.
//
// Metrics use CloudWatch's embedded format with low-cardinality dimensions only
// (component and outcome). Organization and job ids appear in logs, never as dimensions.

export const BRAIN_LOG_FIELDS = [
  'correlationId',
  'revision',
  'mode',
  'component',
  'jobId',
  'generation',
  'commandId',
  'commandType',
  'messageId',
  'reason',
  'stepKey',
  'stepKind',
  'attempt',
  'state',
  'outcome',
  'refusals',
  'failureClass',
  'endReason',
  'queue',
  'delaySeconds',
  'durationMs',
  'retryAfterMs',
  'tokenId',
  'caller',
  'organizationId',
  'waitId',
  'count',
  'status',
  'planVersion',
  'commitGate',
  'callKey',
] as const;
export type BrainLogField = (typeof BRAIN_LOG_FIELDS)[number];

export type BrainLogValue = string | number | boolean | null | readonly string[];
export type BrainLogFields = Partial<Record<BrainLogField, BrainLogValue>>;

export interface BrainLogger {
  info(event: string, fields?: BrainLogFields): void;
  warn(event: string, fields?: BrainLogFields): void;
  error(event: string, fields?: BrainLogFields): void;
  metric(name: string, value: number, dimensions?: { readonly outcome?: string }): void;
}

const EVENT = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_STRING = 200;
const MAX_LIST = 20;

function clean(value: unknown): BrainLogValue | undefined {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').slice(0, MAX_LIST).map((v) => v.slice(0, 64));
  return undefined;
}

/** A logger that writes one JSON object per line through `write`. */
export function jsonLogger(base: BrainLogFields, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): BrainLogger {
  const emit = (level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: BrainLogFields = {}) => {
    const out: Record<string, unknown> = { level, event: EVENT.test(event) ? event : 'invalid.event', time: new Date().toISOString() };
    let dropped = 0;
    for (const [k, v] of Object.entries({ ...base, ...fields })) {
      if (!(BRAIN_LOG_FIELDS as readonly string[]).includes(k)) {
        dropped += 1;
        continue;
      }
      const c = clean(v);
      if (c === undefined) dropped += 1;
      else out[k] = c;
    }
    if (dropped > 0) out.droppedFields = dropped;
    write(JSON.stringify(out));
  };
  return {
    info: (e, f) => emit('INFO', e, f),
    warn: (e, f) => emit('WARN', e, f),
    error: (e, f) => emit('ERROR', e, f),
    metric(name, value, dimensions = {}) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) || !Number.isFinite(value)) return;
      const component = typeof base.component === 'string' ? base.component : 'unknown';
      const outcome = dimensions.outcome && /^[A-Z_]{1,40}$/.test(dimensions.outcome) ? dimensions.outcome : undefined;
      const dims = outcome ? [['Component', 'Outcome']] : [['Component']];
      write(
        JSON.stringify({
          _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Loop/Brain', Dimensions: dims, Metrics: [{ Name: name, Unit: 'Count' }] }] },
          Component: component,
          ...(outcome ? { Outcome: outcome } : {}),
          [name]: value,
        }),
      );
    },
  };
}

/** A logger that records lines in memory, for tests. */
export function memoryLogger(base: BrainLogFields = {}): BrainLogger & { readonly lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = jsonLogger(base, (line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return Object.assign(logger, { lines });
}
