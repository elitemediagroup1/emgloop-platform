// The functions that reach Neon: one restricted role each, from a secret. Slice B6.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PrismaClient } from '@prisma/client';

import { NotConfigured } from './config';

const secrets = new SecretsManagerClient({});

/**
 * A database URL from a secret shaped `{"url": "postgresql://..."}`. The stack creates the
 * secret as `{"state":"UNSET", ...}`; until an operator writes a URL, nothing connects.
 *
 * Neon is reached over the public internet, so the URL must require TLS (`sslmode=require`)
 * and may not relax certificate checks (`sslaccept`, if present, is `strict`). A URL that
 * fails either check is treated as not configured; the URL itself is never echoed.
 */
export async function databaseUrl(secretId: string, client: Pick<SecretsManagerClient, 'send'> = secrets): Promise<string> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.SecretString ?? '');
  } catch {
    throw new NotConfigured('database secret');
  }
  const url = (parsed as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//.test(url)) throw new NotConfigured('database secret');
  let query: URLSearchParams;
  try {
    query = new URL(url).searchParams;
  } catch {
    throw new NotConfigured('database secret');
  }
  if (query.get('sslmode') !== 'require') throw new NotConfigured('database secret');
  if (query.has('sslaccept') && query.get('sslaccept') !== 'strict') throw new NotConfigured('database secret');
  return url;
}

/**
 * The URL the client connects with: one connection (the queue caps concurrency) and a verified
 * server certificate. Prisma 5 accepts any certificate unless `sslaccept=strict` is given.
 */
export function connectionUrl(url: string): string {
  const add = [
    ...(url.includes('connection_limit=') ? [] : ['connection_limit=1']),
    ...(url.includes('sslaccept=') ? [] : ['sslaccept=strict']),
  ];
  return add.length === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}${add.join('&')}`;
}

let client: { url: string; prisma: PrismaClient } | null = null;

/** One client per warm function instance. */
export function prismaFor(url: string): PrismaClient {
  if (client && client.url === url) return client.prisma;
  client = { url, prisma: new PrismaClient({ datasources: { db: { url: connectionUrl(url) } }, log: ['error'] }) };
  return client.prisma;
}
