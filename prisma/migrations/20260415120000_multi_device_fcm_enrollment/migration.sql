-- DropIndex
DROP INDEX "FcmEnrollment_userId_streetLocation_key";

-- CreateIndex
CREATE UNIQUE INDEX "FcmEnrollment_userId_streetLocation_fcmToken_key" ON "FcmEnrollment"("userId", "streetLocation", "fcmToken");
