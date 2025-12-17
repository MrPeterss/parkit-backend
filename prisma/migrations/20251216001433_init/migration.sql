-- CreateTable
CREATE TABLE "Ticket" (
    "ticketId" TEXT NOT NULL PRIMARY KEY,
    "licensePlateNumber" TEXT,
    "licensePlateState" TEXT,
    "lat" REAL,
    "lng" REAL,
    "streetLocation" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScraperState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "lastCheckedId" TEXT NOT NULL,
    "status" TEXT NOT NULL
);
