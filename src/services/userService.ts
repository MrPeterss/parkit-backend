import type { Role } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';

import { prisma } from '../prisma.js';

/** Comma-separated list from `FIREBASE_ADMIN_EMAILS`; compared case-insensitively. */
function parseAdminEmailSet(): Set<string> {
  const raw = process.env.FIREBASE_ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseAdminEmailSet().has(email.trim().toLowerCase());
}

function resolveRoleForNewUser(email: string | null): Role {
  return isAdminEmail(email) ? 'ADMIN' : 'VIEWER';
}

export async function upsertUserFromToken(decoded: DecodedIdToken) {
  const firebaseUid = decoded.uid;
  const email = decoded.email ?? null;
  const displayName = decoded.name ?? null;

  const existing = await prisma.user.findUnique({
    where: { firebaseUid },
  });

  if (existing) {
    const effectiveEmail = email ?? existing.email;
    return prisma.user.update({
      where: { firebaseUid },
      data: {
        email: email ?? existing.email,
        displayName: displayName ?? existing.displayName,
        ...(isAdminEmail(effectiveEmail) ? { role: 'ADMIN' as Role } : {}),
      },
    });
  }

  return prisma.user.create({
    data: {
      firebaseUid,
      email,
      displayName,
      role: resolveRoleForNewUser(email),
    },
  });
}
