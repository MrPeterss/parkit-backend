import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';

import { prisma } from '../prisma.js';
import { getFirebaseAuth } from '../config/firebase.js';
import { upsertUserFromToken } from '../services/userService.js';
import { ForbiddenError, UnauthorizedError } from '../utils/AppError.js';

function devAuthBypassEnabled(): boolean {
  if (process.env.AUTH_DEV_BYPASS === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'development';
}

function bearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  return token ?? null;
}

/**
 * Verifies a Firebase ID token, syncs/creates the User row, and sets req.user.
 * In development, skips verification and attaches a synthetic admin user (override with AUTH_DEV_BYPASS=false).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    if (devAuthBypassEnabled()) {
      const devUser = await prisma.user.upsert({
        where: { firebaseUid: '__dev__' },
        create: {
          firebaseUid: '__dev__',
          email: 'dev@localhost',
          displayName: 'Dev user',
          role: 'ADMIN',
        },
        update: {},
      });
      req.user = {
        id: devUser.id,
        firebaseUid: devUser.firebaseUid,
        email: devUser.email,
        displayName: devUser.displayName,
        role: devUser.role,
      };
      return next();
    }

    const token = bearerToken(req);
    if (!token) {
      throw new UnauthorizedError('No token provided or wrong format.');
    }

    const decoded = await getFirebaseAuth().verifyIdToken(token);
    const user = await upsertUserFromToken(decoded);

    req.user = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    return next();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return next(err);
    }
    return next(new UnauthorizedError('Invalid or expired token.'));
  }
}

/** Must run after requireAuth. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthorizedError('Not authenticated.'));
    }
    if (!allowed.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient role.'));
    }
    return next();
  };
}

/** Convenience: ADMIN role only. Use after requireAuth. */
export const requireAdmin = requireRole('ADMIN');
