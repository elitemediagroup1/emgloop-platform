-- Preserve existing provider ownership; no existing authorization is converted to Stripe.
ALTER TABLE "CreatorPayoutBank" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID';
ALTER TABLE "CreatorPayoutLink" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID', ADD COLUMN "recipientId" TEXT;
ALTER TABLE "CreatorPayout" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID';

-- Preserve proof semantics: Plaid settles; Stripe posts (sent, not guaranteed receipt).
ALTER TABLE "CreatorPayout" DROP CONSTRAINT "creator_payout_paid_proof";
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_paid_proof" CHECK (
  "state" <> 'PAID' OR (
    "transferId" IS NOT NULL AND (
      ("provider" = 'PLAID' AND "providerStatus" = 'settled') OR
      ("provider" = 'STRIPE' AND "providerStatus" = 'posted')
    )
  )
);
ALTER TABLE "CreatorPayout" ADD CONSTRAINT "creator_payout_provider" CHECK ("provider" IN ('PLAID','STRIPE'));
ALTER TABLE "CreatorPayoutBank" ADD CONSTRAINT "creator_payout_bank_provider" CHECK ("provider" IN ('PLAID','STRIPE'));
ALTER TABLE "CreatorPayoutLink" ADD CONSTRAINT "creator_payout_link_provider" CHECK ("provider" IN ('PLAID','STRIPE'));
