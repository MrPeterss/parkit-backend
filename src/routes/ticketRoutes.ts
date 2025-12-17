import express from 'express';

import { prisma } from '../prisma.js';

const router = express.Router();

// Get all tickets
router.get('/', async (_req, res, next) => {
  try {
    const tickets = await prisma.ticket.findMany({
      orderBy: {
        timestamp: 'desc',
      },
    });

    res.json(tickets);
  } catch (err) {
    next(err);
  }
});

// Get tickets from last 24 hours
router.get('/recent', async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const tickets = await prisma.ticket.findMany({
      where: {
        timestamp: {
          gte: since,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    res.json(tickets);
  } catch (err) {
    next(err);
  }
});

// Get all streets with latest ticket coordinates
router.get('/streets', async (_req, res, next) => {
  try {
    // Use a performant SQL query with window function to get the latest ticket per street
    // This query uses ROW_NUMBER() to rank tickets by timestamp for each street,
    // then filters to only the most recent ticket (rn = 1)
    const streets = await prisma.$queryRaw<
      Array<{
        street: string;
        lat: number | null;
        lng: number | null;
      }>
    >`
      SELECT DISTINCT
        ranked.streetLocation as street,
        ranked.lat,
        ranked.lng
      FROM (
        SELECT 
          streetLocation,
          lat,
          lng,
          ROW_NUMBER() OVER (
            PARTITION BY streetLocation 
            ORDER BY timestamp DESC
          ) as rn
        FROM Ticket
        WHERE streetLocation IS NOT NULL
          AND streetLocation != ''
      ) ranked
      WHERE ranked.rn = 1
      ORDER BY ranked.streetLocation
    `;

    // Transform to the desired JSON format
    const result = streets.map(({ street, lat, lng }) => ({
      street,
      coordinates: {
        lat,
        lng,
      },
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Get last ticket for a specific street
router.get('/street/:streetName', async (req, res, next) => {
  try {
    const { streetName } = req.params;

    if (!streetName) {
      return res.status(400).json({ error: 'Street name is required' });
    }

    // Find the most recent ticket for this street
    const lastTicket = await prisma.ticket.findFirst({
      where: {
        streetLocation: {
          contains: streetName,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      select: {
        streetLocation: true,
        timestamp: true,
        lat: true,
        lng: true,
      },
    });

    if (!lastTicket) {
      return res.status(404).json({ 
        error: 'No tickets found for this street',
        street: streetName 
      });
    }

    return res.json({
      street: lastTicket.streetLocation,
      lastTicketTime: lastTicket.timestamp,
      coordinates: {
        lat: lastTicket.lat,
        lng: lastTicket.lng,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;


