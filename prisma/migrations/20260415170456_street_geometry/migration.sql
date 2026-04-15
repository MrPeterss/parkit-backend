/*
  Warnings:

  - You are about to alter the column `segments` on the `StreetGeometry` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StreetGeometry" (
    "streetLocation" TEXT NOT NULL PRIMARY KEY,
    "segments" JSONB NOT NULL,
    "notFound" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_StreetGeometry" ("fetchedAt", "notFound", "segments", "streetLocation", "updatedAt") SELECT "fetchedAt", "notFound", "segments", "streetLocation", "updatedAt" FROM "StreetGeometry";
DROP TABLE "StreetGeometry";
ALTER TABLE "new_StreetGeometry" RENAME TO "StreetGeometry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
