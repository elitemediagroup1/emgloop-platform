CREATE TABLE "EmployeeBookingProfile" (
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL,
    "weeklyHours" JSONB NOT NULL DEFAULT '{}',
    "dateOverrides" JSONB NOT NULL DEFAULT '{}',
    "blockedTimes" JSONB NOT NULL DEFAULT '[]',
    CONSTRAINT "EmployeeBookingProfile_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "EmployeeBookingProfile_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeBookingProfile_slug_key" ON "EmployeeBookingProfile"("slug");
