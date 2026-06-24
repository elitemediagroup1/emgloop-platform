// Provider registry.
//
// Central place to register and resolve provider adapters by category + id.
// Sprint 1 ships the registry with NO concrete adapters registered. Real
// adapters (Claude, ElevenLabs, Twilio, Telnyx, Stripe, Google, ...) are added
// in later sprints without changing any consumer code.

import type { BaseProvider, ProviderCategory } from './types';

type Registry = {
  [K in ProviderCategory]: Map<string, BaseProvider>;
};

const registry: Registry = {
  ai: new Map(),
  voice: new Map(),
  sms: new Map(),
  email: new Map(),
  payment: new Map(),
  calendar: new Map(),
};

export function registerProvider(provider: BaseProvider): void {
  registry[provider.info.category].set(provider.info.id, provider);
}

export function getProvider<T extends BaseProvider>(
  category: ProviderCategory,
  id: string,
): T {
  const found = registry[category].get(id);
  if (!found) {
    throw new Error(
      \`No '\${category}' provider registered with id '\${id}'. \` +
        'Provider adapters are added in later sprints.',
    );
  }
  return found as T;
}

export function listProviders(category: ProviderCategory): BaseProvider[] {
  return [...registry[category].values()];
}
