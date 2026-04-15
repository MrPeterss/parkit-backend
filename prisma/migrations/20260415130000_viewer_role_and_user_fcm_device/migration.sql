-- Map old role to VIEWER before enum value is removed from Prisma schema
UPDATE "User" SET "role" = 'VIEWER' WHERE "role" = 'ENFORCEMENT';

-- CreateTable
CREATE TABLE "UserFcmDevice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "fcmToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserFcmDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserFcmDevice_userId_fcmToken_key" ON "UserFcmDevice"("userId", "fcmToken");
