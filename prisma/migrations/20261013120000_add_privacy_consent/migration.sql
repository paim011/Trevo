-- AlterTable
ALTER TABLE "User" ADD COLUMN     "privacyAcceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FamilyProfile" ADD COLUMN     "healthDataConsentAt" TIMESTAMP(3);
