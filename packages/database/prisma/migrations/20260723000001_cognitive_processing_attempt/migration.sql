-- Loop Cognitive Architecture - Increment 2 (processing pipeline).
--
-- Additive-only: adds cognitive_processing_attempts (+ ProcessingAttemptStatus
-- enum) for the retry/dead-letter foundation. No existing table altered/dropped.
-- Validated on clean Postgres from-zero and from the Increment-1 schema.

-- CreateEnum
CREATE TYPE "ProcessingAttemptStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED');

-- CreateTable
CREATE TABLE "cognitive_processing_attempts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memoryEventId" TEXT,
    "stage" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "ProcessingAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorCode" TEXT,
    "safeErrorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cognitive_processing_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cognitive_processing_attempts_organizationId_status_nextRet_idx" ON "cognitive_processing_attempts"("organizationId", "status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "cognitive_processing_attempts_organizationId_memoryEventId_idx" ON "cognitive_processing_attempts"("organizationId", "memoryEventId");

