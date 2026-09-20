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
  it('names exactly two variables, neither public', () => {
    assert.deepEqual({ ...CONNECTION_ENVIRONMENT }, { secretKey: 'LOOP_CONNECTION_SECRET_KEY', providers: 'LOOP_CONNECTION_PROVIDERS' });
    for (const name of Object.values(CONNECTION_ENVIRONMENT)) assert.ok(!name.startsWith('NEXT_PUBLIC'), `${name} must not be public`);
  });

  it('is off until a valid key AND at least one enabled provider are set', () => {
    assert.equal(readConnectionEnvironment({}).state, 'NOT_CONFIGURED');
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.secretKey]: KEY }).state, 'NOT_CONFIGURED');
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM' }).state, 'NOT_CONFIGURED');
    // A key that is not 32 bytes is treated as absent, not sealed with.
    assert.equal(readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.secretKey]: Buffer.from('short').toString('base64'), [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM' }).state, 'NOT_CONFIGURED');
    const env = readConnectionEnvironment({ [CONNECTION_ENVIRONMENT.secretKey]: KEY, [CONNECTION_ENVIRONMENT.providers]: 'TELEGRAM, MICROSOFT_TEAMS, SLACK' });
    assert.equal(env.state, 'CONFIGURED');
    if (env.state !== 'CONFIGURED') return;
    // Unknown provider names are ignored; only the two real providers survive.
    assert.deepEqual([...env.providers].sort(), ['MICROSOFT_TEAMS', 'TELEGRAM']);
  });

  it('is the only module that reads either variable, anywhere in the product', () => {
    const ENV_MODULE = join(SRC, 'connections', 'connection-environment.ts');
    for (const file of walk(SRC)) {
      if (file === ENV_MODULE) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of Object.values(CONNECTION_ENVIRONMENT)) {
        assert.ok(!text.includes(name), `${relative(WEB, file)} reads ${name}; only connection-environment.ts may`);
      }
    }
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
    // The consent line -- what Loop observes -- is stated up front.
    assert.match(html, /never message text/i);
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
});
