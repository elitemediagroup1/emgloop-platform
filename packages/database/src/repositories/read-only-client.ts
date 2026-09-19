// A database client that can only read -- for diagnostics that run against production.
//
// A read-only diagnostic is read-only because its code names no write. That is proved by tests
// that scan the source, and it stays true only while every future edit is reviewed. This makes it
// structural at run time as well: wrap the client, and every model offers only its read methods.
// Anything else -- create, update, upsert, delete, the *Many writes, raw SQL, a transaction --
// throws before a query is built, so a mistake fails the run instead of changing a row.
//
// NOT A SECURITY BOUNDARY AGAINST HOSTILE CODE: code holding the unwrapped client can still
// write. It is a guard against the honest mistake, in the one process that reads production.

/** The only operations a wrapped model offers. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`${what} is not available to a read-only reader`);
    this.name = 'ReadOnlyViolation';
  }
}

function readOnlyModel(model: object, name: string): object {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (!READ_ONLY_METHODS.has(prop)) throw new ReadOnlyViolation(`${name}.${prop}`);
      const method = Reflect.get(target, prop, receiver) as unknown;
      return typeof method === 'function' ? (method as (...a: unknown[]) => unknown).bind(target) : method;
    },
    set() {
      throw new ReadOnlyViolation(`assigning to ${name}`);
    },
  });
}

/**
 * The same client, able only to read. Every `$` member -- raw SQL, transactions, middleware,
 * disconnect -- is refused; the caller keeps the unwrapped client for its own `$disconnect`.
 */
export function readOnlyClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop.startsWith('$')) throw new ReadOnlyViolation(prop);
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (value !== null && typeof value === 'object') return readOnlyModel(value, prop);
      if (typeof value === 'function') throw new ReadOnlyViolation(prop);
      return value;
    },
    set(_target, prop) {
      throw new ReadOnlyViolation(`assigning ${String(prop)}`);
    },
  }) as T;
}
