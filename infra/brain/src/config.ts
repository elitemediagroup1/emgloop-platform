// What every Brain function reads from its deployment, closed by default. Slice B6.
//
// Names come from the function's environment (set by the stack); values come from
// Parameter Store at run time, with short caches. Nothing here is taken from a request.

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export class NotConfigured extends Error {
  constructor(what: string) {
    super(`not configured: ${what}`);
    this.name = 'NotConfigured';
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new NotConfigured(name);
  return value;
}

const ssm = new SSMClient({});

/** A parameter value, re-read after `ttlMs`. A read failure returns undefined (closed). */
export function cachedParameter(name: string, ttlMs: number, client: Pick<SSMClient, 'send'> = ssm): () => Promise<string | undefined> {
  let value: string | undefined;
  let readAt = 0;
  return async () => {
    if (Date.now() - readAt < ttlMs) return value;
    try {
      const out = await client.send(new GetParameterCommand({ Name: name }));
      value = out.Parameter?.Value;
    } catch {
      value = undefined;
    }
    readAt = Date.now();
    return value;
  };
}
