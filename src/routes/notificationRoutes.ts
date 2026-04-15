import express from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { enrollForStreet, unenrollFromStreet } from '../services/notificationService.js';

const router = express.Router();

const EnrollSchema = z.object({
  fcmToken: z.string().min(1),
  streetLocation: z.string().min(1),
});

const UnenrollSchema = z.object({
  streetLocation: z.string().min(1),
  /** If set, removes only this device’s enrollment for the street; otherwise all devices for that street. */
  fcmToken: z.string().min(1).optional(),
});

// Enroll current user's device for notifications on a street
router.post('/enroll', async (req, res, next) => {
  try {
    const parsed = EnrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'fcmToken and streetLocation are required' });
    }

    const userId = req.user!.id;
    const { fcmToken, streetLocation } = parsed.data;
    await enrollForStreet(userId, fcmToken, streetLocation);

    return res.status(200).json({ message: `Enrolled for notifications on "${streetLocation}"` });
  } catch (err) {
    return next(err);
  }
});

// Notification history for the authenticated user
router.get('/history', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      select: { id: true, title: true, body: true, streetLocation: true, ticketId: true, sentAt: true },
    });

    return res.json({ userId, notifications });
  } catch (err) {
    return next(err);
  }
});

// Street enrollments for the authenticated user
router.get('/enrollments', async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const enrollments = await prisma.fcmEnrollment.findMany({
      where: { userId },
      select: {
        id: true,
        streetLocation: true,
        createdAt: true,
        fcmToken: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const masked = enrollments.map(({ id, streetLocation, createdAt, fcmToken }) => ({
      id,
      streetLocation,
      createdAt,
      fcmTokenSuffix: fcmToken.length > 8 ? fcmToken.slice(-8) : fcmToken,
    }));

    return res.json({ userId, enrollments: masked });
  } catch (err) {
    return next(err);
  }
});

// Unenroll current user from notifications on a street
router.post('/unenroll', async (req, res, next) => {
  try {
    const parsed = UnenrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'streetLocation is required' });
    }

    const userId = req.user!.id;
    const { streetLocation, fcmToken } = parsed.data;
    await unenrollFromStreet(userId, streetLocation, fcmToken);

    return res.status(200).json({ message: `Unenrolled from notifications on "${streetLocation}"` });
  } catch (err) {
    return next(err);
  }
});

export default router;
