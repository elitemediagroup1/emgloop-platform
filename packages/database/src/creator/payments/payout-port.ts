import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export type PayoutConfig = {
  provider?: 'PLAID' | 'STRIPE';
  feeReserveMinor?: number;
  fundingDashboard?: string;
  environment: 'sandbox' | 'production';
  clientId: string;
  secret: string;
  key: Buffer;
  organizationId: string;
  ledgerId: string;
  redirectUri?: string;
  fundingAccountId?: string;
  fundingAccountLabel?: string;
  recordingOnly?: boolean;
};
export type BankSecret = { accessToken: string; accountId: string; itemId: string };
export function sealBank(value: BankSecret, key: Buffer, aad: string) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((v) => v.toString('base64url')).join('.');
}
export function openBank(value: string, key: Buffer, aad: string): BankSecret {
  const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv!);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag!);
  const out = JSON.parse(Buffer.concat([d.update(data!), d.final()]).toString()) as BankSecret;
  if (!out.accessToken || !out.accountId || !out.itemId) throw Error('BANK_UNAVAILABLE');
  return out;
}
export const bankAAD = (
  p: { organizationId: string; creatorProfileId: string; userId: string },
  environment: string,
) => `${p.organizationId}:${p.creatorProfileId}:${p.userId}:${environment}`;
export type PayoutTransfer = {
  id: string;
  authorization_id?: string;
  recipient_id?: string;
  account_id: string;
  amount: string;
  type: string;
  ledger_id?: string;
  status: string;
};
export type PayoutSweep = {
  id: string;
  funding_account_id: string;
  ledger_id: string | null;
  amount: string;
  iso_currency_code: string;
  status: string | null;
};
export interface PayoutPort {
  hostedOnboarding?: {
    recipient(input: {
      email: string;
      name: string;
      entityType: 'individual' | 'company';
      id: string;
    }): Promise<string>;
    link(recipient: string, returnUrl: string): Promise<string>;
    inspect(
      recipient: string,
    ): Promise<{ accountId: string; mask: string; institution: string } | null>;
  };
  ledger(): Promise<{ ledger_id: string; balance: { available: string; pending: string } }>;
  deposit(amount: string, id: string): Promise<PayoutSweep>;
  sweep(id: string): Promise<PayoutSweep>;
  link(userId: string): Promise<string>;
  exchange(publicToken: string): Promise<{ access_token: string; item_id: string }>;
  accounts(accessToken: string): Promise<
    {
      account_id: string;
      mask: string | null;
      name: string;
      type: string;
      subtype: string | null;
      balances: { iso_currency_code: string | null };
    }[]
  >;
  remove(accessToken: string): Promise<void>;
  authorize(input: {
    accessToken: string;
    accountId: string;
    legalName: string;
    amount: string;
    id: string;
  }): Promise<{ id: string; decision: string }>;
  create(
    authorizationId: string,
    accessToken: string,
    accountId: string,
    payoutId: string,
    expectedAmount: string,
  ): Promise<PayoutTransfer>;
  get(input: { transferId?: string; authorizationId?: string }): Promise<PayoutTransfer>;
}
export function payoutState(status: string, provider = 'PLAID') {
  if (provider === 'STRIPE' && status === 'posted') return 'PAID';
  return status === 'settled'
    ? 'PAID'
    : status === 'returned'
      ? 'RETURNED'
      : ['failed', 'cancelled', 'canceled', 'requires_action'].includes(status)
        ? 'REVIEW'
        : 'PROCESSING';
}
export function usdAmount(minor: number) {
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 100000000)
    throw Error('INVALID_AMOUNT');
  return (minor / 100).toFixed(2);
}

export function decimalMinor(amount: string) {
  if (!/^\d{1,12}\.\d{2}$/.test(amount)) throw Error('INVALID_AMOUNT');
  const [whole, cents] = amount.split('.');
  const minor = Number(whole) * 100 + Number(cents);
  if (!Number.isSafeInteger(minor)) throw Error('INVALID_AMOUNT');
  return minor;
}
