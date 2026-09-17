// The functions that reach Neon: one restricted role each, from a secret. Slice B6.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PrismaClient } from '@prisma/client';

import { NotConfigured } from './config';

const secrets = new SecretsManagerClient({});

/**
 * A database URL from a secret shaped `{"url": "postgresql://..."}`. The stack creates the
 * secret as `{"state":"UNSET", ...}`; until an operator writes a URL, nothing connects.
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
  return url;
}

let client: { url: string; prisma: PrismaClient } | null = null;

/** One client per warm function instance, with one connection (the queue caps concurrency). */
export function prismaFor(url: string): PrismaClient {
  if (client && client.url === url) return client.prisma;
  const withLimit = url.includes('connection_limit=') ? url : `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
  client = { url, prisma: new PrismaClient({ datasources: { db: { url: withLimit } }, log: ['error'] }) };
  return client.prisma;
}
