import express from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../prisma.js';

const router = express.Router();

const AuthorizeSchema = z.object({
  fcmToken: z.string().min(1),
});

/** Call after Firebase login with the same Bearer ID token + device FCM token. */
router.post('/authorize', requireAuth, async (req, res, next) => {
  try {
    const parsed = AuthorizeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'fcmToken is required' });
    }

    const userId = req.user!.id;
    const { fcmToken } = parsed.data;

    await prisma.userFcmDevice.upsert({
      where: {
        userId_fcmToken: { userId, fcmToken },
      },
      update: {},
      create: { userId, fcmToken },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Current user + role (for frontend gating)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Devices registered via /auth/authorize (for notification settings UI)
router.get('/devices', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const devices = await prisma.userFcmDevice.findMany({
      where: { userId },
      select: { id: true, createdAt: true, updatedAt: true, fcmToken: true },
      orderBy: { updatedAt: 'desc' },
    });
    const masked = devices.map(({ id, createdAt, updatedAt, fcmToken }) => ({
      id,
      createdAt,
      updatedAt,
      fcmTokenSuffix: fcmToken.length > 8 ? fcmToken.slice(-8) : fcmToken,
    }));
    return res.json({ devices: masked });
  } catch (err) {
    return next(err);
  }
});

export default router;
