import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import type { Ticket } from '@prisma/client';

import { prisma } from '../prisma.js';

const STREET_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Initialize Firebase Admin SDK once
if (!admin.apps.length) {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountPath) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT env var not set — FCM notifications disabled');
  } else {
    console.log(`🔑 Loading Firebase service account from: ${serviceAccountPath}`);
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'));
    console.log(`🔑 Service account project: ${serviceAccount.project_id}, client: ${serviceAccount.client_email}`);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin initialized');
  }
}

const fcm = () => {
  if (!admin.apps.length) return null;
  return admin.messaging();
};

// Enroll an FCM token for a street. Safe to call multiple times (upsert).
export const enrollForStreet = async (fcmToken: string, streetLocation: string): Promise<void> => {
  await prisma.fcmEnrollment.upsert({
    where: { fcmToken_streetLocation: { fcmToken, streetLocation } },
    update: {},
    create: { fcmToken, streetLocation },
  });
};

// Unenroll an FCM token from a street.
export const unenrollFromStreet = async (fcmToken: string, streetLocation: string): Promise<void> => {
  await prisma.fcmEnrollment.deleteMany({
    where: { fcmToken, streetLocation },
  });
};

// Called by the scraper whenever a new ticket is saved.
// Sends FCM notifications to all tokens enrolled for that street,
// but only if the previous ticket on that street was more than 30 minutes ago.
export const emitNewTicket = async (ticket: Ticket): Promise<void> => {
  if (!ticket.streetLocation) return;

  const messaging = fcm();
  if (!messaging) return;

  // Find the most recent previous ticket on the same street
  const previousTicket = await prisma.ticket.findFirst({
    where: {
      streetLocation: ticket.streetLocation,
      ticketId: { not: ticket.ticketId },
    },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });

  const timeSinceLast = previousTicket
    ? ticket.timestamp.getTime() - previousTicket.timestamp.getTime()
    : Infinity;

  if (timeSinceLast < STREET_COOLDOWN_MS) {
    console.log(
      `🔕 Skipping notification for "${ticket.streetLocation}" — last ticket was ${Math.round(timeSinceLast / 60000)}m ago (cooldown: 30m)`
    );
    return;
  }

  // Find all enrolled tokens for this street
  const enrollments = await prisma.fcmEnrollment.findMany({
    where: { streetLocation: ticket.streetLocation },
    select: { fcmToken: true },
  });

  if (enrollments.length === 0) return;

  const tokens = enrollments.map((e) => e.fcmToken);
  console.log(`📲 Sending notification for "${ticket.streetLocation}" to ${tokens.length} device(s)`);

  const title = '🚨 Parking Enforcement Active';
  const body = `A ticket was just issued on ${ticket.streetLocation}.`;

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: {
      ticketId: ticket.ticketId,
      streetLocation: ticket.streetLocation,
      timestamp: ticket.timestamp.toISOString(),
    },
  });

  // Persist a Notification record for each successfully notified token
  const successfulTokens = response.responses
    .map((r, i) => (r.success ? tokens[i] ?? null : null))
    .filter((t): t is string => t !== null);

  if (successfulTokens.length > 0) {
    await prisma.notification.createMany({
      data: successfulTokens.map((fcmToken) => ({
        fcmToken,
        title,
        body,
        streetLocation: ticket.streetLocation!,
        ticketId: ticket.ticketId,
      })),
    });
  }

  // Log result per token and collect failures
  const staleTokens: string[] = [];
  response.responses.forEach((r, i) => {
    const token = tokens[i] ?? '(unknown)';
    if (r.success) {
      console.log(`  ✅ [${i}] Sent to token ...${token.slice(-8)}`);
    } else {
      const err = r.error;
      console.error(`  ❌ [${i}] Failed for token ...${token.slice(-8)}`);
      console.error(`       Code: ${err?.code ?? 'unknown'}`);
      console.error(`       Message: ${err?.message ?? 'no message'}`);
      if (err && 'toJSON' in err) {
        console.error(`       Detail:`, err.toJSON());
      }
      // Only remove tokens that Firebase explicitly says are invalid/unregistered
      const isStale =
        err?.code === 'messaging/invalid-registration-token' ||
        err?.code === 'messaging/registration-token-not-registered';
      if (isStale && tokens[i]) staleTokens.push(tokens[i]!);
    }
  });

  if (staleTokens.length > 0) {
    console.log(`🗑️  Removing ${staleTokens.length} stale FCM token(s)`);
    await prisma.fcmEnrollment.deleteMany({
      where: { fcmToken: { in: staleTokens } },
    });
  }

  console.log(`✅ Sent ${response.successCount}/${tokens.length} notifications for "${ticket.streetLocation}"`);
};
