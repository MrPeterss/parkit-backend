import 'dotenv/config';

import express from 'express';
import type { Request, Response } from 'express';

import { globalErrorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import { prisma } from './prisma.js';
import adminRoutes from './routes/adminRoutes.js';
import authRoutes from './routes/authRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import { backfillMissingStreetGeometriesOnStartup } from './services/streetGeometryService.js';
import { startTicketWatcher } from './worker/ticketScraper.js';

const app = express();

app.use(express.json({ limit: '10kb' }));

// Health check endpoint
app.get('/health', async (_: Request, res: Response) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    database: 'unknown',
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    healthCheck.database = 'connected';
    res.status(200).json(healthCheck);
  } catch {
    healthCheck.status = 'unhealthy';
    healthCheck.database = 'disconnected';
    res.status(503).json(healthCheck);
  }
});

// Auth: /auth/authorize and /auth/me verify Bearer token inside the router
app.use('/auth', authRoutes);

// Everything below requires a valid Bearer token (except /health and /auth/* above)
const protectedRoutes = express.Router();
protectedRoutes.use(requireAuth);
protectedRoutes.use('/admin', adminRoutes);
protectedRoutes.use('/tickets', ticketRoutes);
protectedRoutes.use('/notifications', notificationRoutes);
app.use(protectedRoutes);

app.use(globalErrorHandler);

const port = process.env.PORT || '8000';

const server = app.listen(port, async () => {
  console.log(`Ticket app listening at http://localhost:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  try {
    await prisma.$connect();
    console.log('Database connected successfully');
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }

  // Start the ticket watcher in the background (non-blocking)
  void startTicketWatcher().catch((error) => {
    console.error('Fatal error in ticket watcher:', error);
    process.exit(1);
  });
  console.log('Ticket watcher started in background');

  void backfillMissingStreetGeometriesOnStartup().catch((error) => {
    console.error('Street geometry backfill failed:', error);
  });
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');

  server.close(async () => {
    console.log('HTTP server closed');

    await prisma.$disconnect();
    console.log('Database disconnected');

    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
