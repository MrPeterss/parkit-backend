import express from 'express';
import { z } from 'zod';

import { requireAdmin } from '../middleware/auth.js';
import { prisma } from '../prisma.js';
import { NotFoundError } from '../utils/AppError.js';

const router = express.Router();

const UpdateRoleSchema = z.object({
  role: z.enum(['ADMIN', 'VIEWER']),
});

// Change a user's role by Firebase UID (ADMIN only)
router.patch('/users/:firebaseUid/role', requireAdmin, async (req, res, next) => {
  try {
    const { firebaseUid } = req.params;
    const parsed = UpdateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body must include role: ADMIN | VIEWER' });
    }

    const existing = await prisma.user.findUnique({ where: { firebaseUid } });
    if (!existing) {
      throw new NotFoundError('User not found for this Firebase UID');
    }

    const user = await prisma.user.update({
      where: { firebaseUid },
      data: { role: parsed.data.role },
      select: { id: true, firebaseUid: true, email: true, role: true },
    });

    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

export default router;
