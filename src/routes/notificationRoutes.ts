import express from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { enrollForStreet, unenrollFromStreet } from '../services/notificationService.js';

const router = express.Router();

const EnrollSchema = z.object({
  fcmToken: z.string().min(1),
  streetLocation: z.string().min(1),
});

// Enroll an FCM token for notifications on a street
router.post('/enroll', async (req, res, next) => {
  try {
    const parsed = EnrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'fcmToken and streetLocation are required' });
    }

    const { fcmToken, streetLocation } = parsed.data;
    await enrollForStreet(fcmToken, streetLocation);

    return res.status(200).json({ message: `Enrolled for notifications on "${streetLocation}"` });
  } catch (err) {
    return next(err);
  }
});

// Get notification history for an FCM token
router.get('/history/:fcmToken', async (req, res, next) => {
  try {
    const { fcmToken } = req.params;

    const notifications = await prisma.notification.findMany({
      where: { fcmToken },
      orderBy: { sentAt: 'desc' },
      select: { id: true, title: true, body: true, streetLocation: true, ticketId: true, sentAt: true },
    });

    return res.json({ fcmToken, notifications });
  } catch (err) {
    return next(err);
  }
});

// Get all street enrollments for an FCM token
router.get('/enrollments/:fcmToken', async (req, res, next) => {
  try {
    const { fcmToken } = req.params;

    const enrollments = await prisma.fcmEnrollment.findMany({
      where: { fcmToken },
      select: { streetLocation: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ fcmToken, enrollments });
  } catch (err) {
    return next(err);
  }
});

// Unenroll an FCM token from notifications on a street
router.post('/unenroll', async (req, res, next) => {
  try {
    const parsed = EnrollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'fcmToken and streetLocation are required' });
    }

    const { fcmToken, streetLocation } = parsed.data;
    await unenrollFromStreet(fcmToken, streetLocation);

    return res.status(200).json({ message: `Unenrolled from notifications on "${streetLocation}"` });
  } catch (err) {
    return next(err);
  }
});

export default router;
