-- AlterTable
ALTER TABLE "ScraperState" ADD COLUMN "lastDiscoveryAt" DATETIME;

-- CreateTable
CREATE TABLE "ScraperLane" (
    "blockStartId" TEXT NOT NULL PRIMARY KEY,
    "blockEndId" TEXT NOT NULL,
    "nextCursorId" TEXT NOT NULL,
    "lastFoundId" TEXT,
    "lastFoundAt" DATETIME,
    "missStreak" INTEGER NOT NULL DEFAULT 0,
    "cadenceLevel" INTEGER NOT NULL DEFAULT 0,
    "nextDueAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "retiredAt" DATETIME,
    "retiredReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ScraperLane_status_nextDueAt_idx" ON "ScraperLane"("status", "nextDueAt");
