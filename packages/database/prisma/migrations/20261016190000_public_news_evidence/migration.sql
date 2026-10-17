-- CreateTable
CREATE TABLE "public_news_articles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_news_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_news_feed_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "succeededAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "public_news_feed_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_news_articles_organizationId_publishedAt_idx" ON "public_news_articles"("organizationId", "publishedAt");

-- CreateIndex
CREATE INDEX "public_news_articles_expiresAt_idx" ON "public_news_articles"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "public_news_articles_organizationId_url_key" ON "public_news_articles"("organizationId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "public_news_feed_states_organizationId_sourceId_key" ON "public_news_feed_states"("organizationId", "sourceId");

-- AddForeignKey
ALTER TABLE "public_news_articles" ADD CONSTRAINT "public_news_articles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_news_feed_states" ADD CONSTRAINT "public_news_feed_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

