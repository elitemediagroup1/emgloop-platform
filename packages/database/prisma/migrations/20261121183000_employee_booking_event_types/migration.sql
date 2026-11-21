CREATE TYPE "EmployeeBookingEventStyle" AS ENUM ('ONE_ON_ONE', 'GROUP');

CREATE TABLE "EmployeeBookingEventType" (
    "id" TEXT PRIMARY KEY,
    "profileUserId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "style" "EmployeeBookingEventStyle" NOT NULL DEFAULT 'ONE_ON_ONE',
    "durationMinutes" INTEGER NOT NULL CHECK ("durationMinutes" > 0),
    "groupCapacity" INTEGER,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmployeeBookingEventType_profileUserId_fkey" FOREIGN KEY ("profileUserId")
      REFERENCES "EmployeeBookingProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmployeeBookingEventType_capacity_check" CHECK (
      ("style" = 'ONE_ON_ONE' AND "groupCapacity" IS NULL) OR
      ("style" = 'GROUP' AND "groupCapacity" IS NOT NULL AND "groupCapacity" >= 2)
    )
);

CREATE UNIQUE INDEX "EmployeeBookingEventType_profileUserId_slug_key"
    ON "EmployeeBookingEventType"("profileUserId", "slug");
