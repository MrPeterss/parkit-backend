import type { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after Firebase verification and DB sync. */
      user?: {
        id: number;
        firebaseUid: string;
        email: string | null;
        displayName: string | null;
        role: Role;
      };
    }
  }
}

export {};
