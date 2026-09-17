// The runner's ports, bound to AWS: the key-service signer. Slice B6.

import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { Es256Signer } from '@emgloop/brain-executor';

/** Signs with the key service. The private key never leaves it; the signature comes back as DER. */
export class KmsEs256Signer implements Es256Signer {
  constructor(
    readonly keyId: string,
    private readonly keyArn: string,
    private readonly client: Pick<KMSClient, 'send'> = new KMSClient({}),
  ) {}

  async sign(signingInput: Uint8Array): Promise<Uint8Array> {
    const out = await this.client.send(new SignCommand({ KeyId: this.keyArn, Message: signingInput, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }));
    if (!out.Signature) throw new Error('the key service returned no signature');
    return out.Signature;
  }
}
