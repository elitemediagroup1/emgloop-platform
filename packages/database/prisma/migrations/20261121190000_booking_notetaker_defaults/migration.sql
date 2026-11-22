CREATE TYPE "BookingNotetakerPolicy" AS ENUM ('OFF', 'EXTERNAL_ONLY', 'ALL_MEETINGS');

ALTER TABLE "EmployeeBookingProfile"
    ADD COLUMN "notetakerDefault" "BookingNotetakerPolicy" NOT NULL DEFAULT 'OFF';

-- A null event policy inherits the employee's policy.
ALTER TABLE "EmployeeBookingEventType"
    ADD COLUMN "notetakerPolicy" "BookingNotetakerPolicy";
