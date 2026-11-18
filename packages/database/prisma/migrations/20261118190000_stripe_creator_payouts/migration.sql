-- Preserve existing provider ownership; no existing authorization is converted to Stripe.
ALTER TABLE "CreatorPayoutBank" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID';
ALTER TABLE "CreatorPayoutLink" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID', ADD COLUMN "recipientId" TEXT;
ALTER TABLE "CreatorPayout" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PLAID';
