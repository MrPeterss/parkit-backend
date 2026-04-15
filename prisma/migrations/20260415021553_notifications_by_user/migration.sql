/*
  Warnings:

  - You are about to drop the column `fcmToken` on the `Notification` table. All the data in the column will be lost.
  - Added the required column `userId` to the `FcmEnrollment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `Notification` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FcmEnrollment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "streetLocation" TEXT NOT NULL,
    "fcmToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FcmEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FcmEnrollment" ("createdAt", "fcmToken", "id", "streetLocation") SELECT "createdAt", "fcmToken", "id", "streetLocation" FROM "FcmEnrollment";
DROP TABLE "FcmEnrollment";
ALTER TABLE "new_FcmEnrollment" RENAME TO "FcmEnrollment";
CREATE UNIQUE INDEX "FcmEnrollment_userId_streetLocation_key" ON "FcmEnrollment"("userId", "streetLocation");
CREATE TABLE "new_Notification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "streetLocation" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("body", "id", "sentAt", "streetLocation", "ticketId", "title") SELECT "body", "id", "sentAt", "streetLocation", "ticketId", "title" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
