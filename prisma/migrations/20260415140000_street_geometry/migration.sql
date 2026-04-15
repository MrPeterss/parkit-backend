-- CreateTable
CREATE TABLE "StreetGeometry" (
    "streetLocation" TEXT NOT NULL PRIMARY KEY,
    "segments" TEXT NOT NULL,
    "notFound" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
