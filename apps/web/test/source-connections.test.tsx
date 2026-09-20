// Microsoft Teams + Telegram connections on the web tier.
//
// WHAT THESE PROVE
//   - The deployment environment is read in ONE server-only module, off until a valid key AND at
//     least one enabled provider are set; no connection variable is ever NEXT_PUBLIC, and no client
//     component can reach the environment, the runtime, the sealer or the service.
//   - The Connections page renders the Teams/Telegram panel and takes the person and organization
//     from the signed session only; each page guards itself.
//   - The actions run under `sourceConnections:update`, re-derived from the session, and never read
//     org/user from the form.
//   - The panel is honest: with nothing configured it says so and offers no Connect; a connection
//     that is authenticated but not observing reads "Connected (limited)", never "Ready".
//
// NO VALUE HERE IS A REAL CREDENTIAL. The key is generated for the test and discarded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, resolveDisplayTimeZone, connectionProviderProfile } from '@emgloop/shared';
import type { SourceConnectionStatus, ProviderConnectionView } from '@emgloop/database';

import { CONNECTION_ENVIRONMENT, readConnectionEnvironment } from '../src/connections/connection-environment';
import { SourceConnectionsPanel } from '../src/app/app/_connections/source-connections-panel';

const WEB = resolve(__dirname, '..');
const SRC = join(WEB, 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const NOW = new Date('2026-09-20T12:00:00Z');
const time = createTimeView(resolveDisplayTimeZone({ device: 'UTC' }), NOW);
const KEY = randomBytes(32).toString('base64');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next', 'dist', 'test'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('the deployment environment', () => {
  it('names exactly three variables, none public, and holds NO session-sealing key', () => {
    assert.deepEqual({ ...CONNECTION_ENVIRONMENT }, {
      providers: 'LOOP_CONNECTION_PROVIDERS',
      workerUrl: 'LOOP_CONNECTIONS_WORKER_URL',
      workerSecret: 'LOOP_CONNECTIONS_WORKER_SECRET',
    });
    for (const name of Object.values(CONNECTION_ENVIRONMENT)) assert.ok(!name.startsWith('NEXT_PUBLIC'), `${name} must not be public`);
    // The web tier must NOT read the session-sealing key -- only the worker seals/opens sessions.
    assert.ok(!Object.values(CONNECTION_ENVIRONMENT).includes('LOOP_CONNECTION_SECRET_KEY' as never), 'web must not read the session key');
  });

  it('is off until a provider is enabled AND the worker is reachable', () => {
    const url = 'https://worker.staging.example';
    const secret = 'worker-control-secret';
    assert.equal(readConnectionEnvironment({}).state, 'NOT_CONFIGURED');
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM' }).state, 'NOT_CONFIGURED'); // no worker
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.workerUrl]: url, [CONNECTION_ENVIRONMENT.workerSecret]: secret }).state, 'NOT_CONFIGURED'); // no provider
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM', [CONNECTION_ENVIRONMENT.workerUrl]: 'not-a-url', [CONNECTION_ENVIRONMENT.workerSecret]: secret }).state, 'NOT_CONFIGURED'); // bad url
    const env = readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM, MICROSOFT_TEAMS, SLACK', [CONNECTION_ENVIRONMENT.workerUrl]: url, [CONNECTION_ENVIRONMENT.workerSecret]: secret });
    assert.equal(env.state, 'CONFIGURED');
    if (env.state !== 'CONFIGURED') return;
    // Unknown provider names are ignored; only the two real providers survive.
    assert.deepEqual([...env.providers].sort(), ['MICROSOFT_TEAMS', 'TELEGRAM']);
    assert.equal(env.worker.url, url);
  });

  it('is the only module that reads any of the variables, anywhere in the product', () => {
    const ENV_MODULE = join(SRC, 'connections', 'connection-environment.ts');
    for (const file of walk(SRC)) {
      if (file === ENV_MODULE) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of Object.values(CONNECTION_ENVIRONMENT)) {
        assert.ok(!text.includes(name), `${relative(WEB, file)} reads ${name}; only connection-environment.ts may`);
      }
    }
    // No web file reads the session-sealing key -- it belongs to the worker alone.
    for (const file of walk(SRC)) assert.ok(!readFileSync(file, 'utf8').includes('LOOP_CONNECTION_SECRET_KEY'), `${relative(WEB, file)} must not read the session key`);
    // The env reader and the runtime are server-only.
    assert.match(read('connections/connection-environment.ts'), /^import 'server-only';/m);
    assert.match(read('connections/source-connection-runtime.ts'), /^import 'server-only';/m);
  });
});

describe('the Connections page and actions', () => {
  it('renders the Teams/Telegram panel with the session principal, and guards itself', () => {
    const page = code(read('app/app/connections/page.tsx'));
    assert.match(page, /<SourceConnectionsPanel\b/);
    assert.match(page, /sourceConnections\(\)\.status\(\{ organizationId: session\.organizationId, userId: session\.userId/);
    assert.match(page, /requirePermission\(/); // the page establishes a session before any read
  });

  it('the source-connection read is wrapped so a DB failure degrades instead of crashing the page', () => {
    const page = code(read('app/app/connections/page.tsx'));
    // The read is inside try/catch and the status is nullable; on failure the panel gets null.
    assert.match(page, /let connectionStatus: SourceConnectionStatus \| null = null;/);
    assert.match(page, /try \{[\s\S]*?connectionStatus = await sourceConnections\(\)\.status\(/);
    assert.match(page, /\} catch \(err\) \{/);
    // Only the error class is logged -- never a connection string or secret.
    assert.doesNotMatch(page, /console\.(error|log)\([^)]*DATABASE_URL/);
  });

  it('the actions act under sourceConnections:update from the session, never the form', () => {
    const actions = code(read('connections/actions.ts'));
    assert.match(actions, /^\s*'use server';/);
    assert.equal((actions.match(/await requirePermission\('sourceConnections', 'update'\)/g) ?? []).length, 2);
    assert.doesNotMatch(actions, /formData\.get\('(organizationId|userId|org|user)'\)/);
    // Only the provider (which tile) is read from the form.
    assert.match(actions, /formData\.get\('provider'\)/);
  });
});

function view(over: Partial<ProviderConnectionView> & { provider: 'MICROSOFT_TEAMS' | 'TELEGRAM' }): ProviderConnectionView {
  return {
    profile: connectionProviderProfile(over.provider),
    configured: false,
    state: 'NOT_CONNECTED',
    accountLabel: null,
    connectedAt: null,
    lastObservedAt: null,
    reconnectRequiredAt: null,
    disconnectedAt: null,
    canConnect: false,
    canDisconnect: false,
    ...over,
  };
}

describe('the panel is honest', () => {
  it('with nothing configured, says so and offers no Connect', () => {
    const status: SourceConnectionStatus = {
      permitted: true,
      providers: [view({ provider: 'MICROSOFT_TEAMS' }), view({ provider: 'TELEGRAM' })],
    };
    const html = renderToStaticMarkup(<SourceConnectionsPanel status={status} outcome={null} time={time} />);
    assert.match(html, /not available yet/i);
    assert.doesNotMatch(html, /Connect Microsoft Teams|Connect Telegram/);
    // The intelligence-source framing and the not-a-chat-client boundary are stated up front.
    assert.match(html, /intelligence source/i);
    assert.match(html, /not a chat client/i);
    assert.match(html, /mirror or archive/i);
  });

  it('an authenticated-but-not-observing connection reads "Connected (limited)", never "Ready"', () => {
    const status: SourceConnectionStatus = {
      permitted: true,
      providers: [
        view({ provider: 'MICROSOFT_TEAMS', configured: true, state: 'CONNECTED_LIMITED', canDisconnect: true }),
        view({ provider: 'TELEGRAM', configured: true, state: 'NOT_CONNECTED', canConnect: true }),
      ],
    };
    const html = renderToStaticMarkup(<SourceConnectionsPanel status={status} outcome={null} time={time} />);
    assert.match(html, /Connected \(limited\)/);
    assert.doesNotMatch(html, />Ready</);
    // Telegram is configured and not live, so Connect is offered for it.
    assert.match(html, /Connect Telegram/);
  });

  it('refuses the whole panel to a person who may not view', () => {
    const html = renderToStaticMarkup(<SourceConnectionsPanel status={{ permitted: false }} outcome={null} time={time} />);
    assert.match(html, /cannot connect communication sources/i);
  });

  it('a failed status read (null) renders an honest "could not load" state, never a crash', () => {
    // Regression for the Server Component crash (Prisma P2021: source_connections missing) -- a read
    // failure must degrade, not throw. Rendering must not throw, and the copy must say it plainly.
    let html = '';
    assert.doesNotThrow(() => {
      html = renderToStaticMarkup(<SourceConnectionsPanel status={null} outcome={null} time={time} />);
    });
    assert.match(html, /could not be loaded/i);
  });
});
