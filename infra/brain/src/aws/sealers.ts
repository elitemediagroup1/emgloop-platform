// The runner's ports, bound to AWS: checkpoint sealers from Secrets Manager. Slice B6.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { checkpointSealerFromSecret, type BrainSealerSource } from '@emgloop/brain-executor';

/**
 * Checkpoint sealers keyed by secret version. New checkpoints use the current version;
 * an older checkpoint is opened with the version its key reference names.
 */
export class SecretsSealerSource implements BrainSealerSource {
  private readonly cache = new Map<string, ReturnType<typeof checkpointSealerFromSecret>>();

  constructor(
    private readonly secretName: string,
    private readonly client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({}),
  ) {}

  private keyRefFor(versionId: string): string {
    return `secretsmanager:${this.secretName}:${versionId}`;
  }

  async current() {
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretName }));
    if (!out.SecretString || !out.VersionId) throw new Error('checkpoint secret unreadable');
    const keyRef = this.keyRefFor(out.VersionId);
    let sealer = this.cache.get(keyRef);
    if (!sealer) {
      sealer = checkpointSealerFromSecret(out.SecretString, keyRef);
      this.cache.set(keyRef, sealer);
    }
    return sealer;
  }

  async forKeyRef(keyRef: string) {
    const prefix = `secretsmanager:${this.secretName}:`;
    if (!keyRef.startsWith(prefix)) return null;
    const cached = this.cache.get(keyRef);
    if (cached) return cached;
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretName, VersionId: keyRef.slice(prefix.length) }));
      if (!out.SecretString) return null;
      const sealer = checkpointSealerFromSecret(out.SecretString, keyRef);
      this.cache.set(keyRef, sealer);
      return sealer;
    } catch {
      return null;
    }
  }
}
