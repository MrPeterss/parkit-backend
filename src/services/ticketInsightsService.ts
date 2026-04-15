import { prisma } from '../prisma.js';

const MS_DAY = 24 * 60 * 60 * 1000;

function enforcementLevelFromCount(count24h: number): 'low' | 'medium' | 'high' {
  if (count24h >= 20) return 'high';
  if (count24h >= 5) return 'medium';
  return 'low';
}

/** Map + Area Insights card (Stitch: Active Enforcement, ticket volume). */
export async function getAreaOverview() {
  const now = new Date();
  const since24h = new Date(now.getTime() - MS_DAY);
  const since7d = new Date(now.getTime() - 7 * MS_DAY);

  const [count24h, count7d, distinctStreets24h] = await Promise.all([
    prisma.ticket.count({ where: { timestamp: { gte: since24h } } }),
    prisma.ticket.count({ where: { timestamp: { gte: since7d } } }),
    prisma.ticket.groupBy({
      by: ['streetLocation'],
      where: {
        timestamp: { gte: since24h },
        AND: [{ streetLocation: { not: null } }, { NOT: { streetLocation: '' } }],
      },
    }),
  ]);

  return {
    ticketCount24h: count24h,
    ticketCount7d: count7d,
    activeStreets24h: distinctStreets24h.length,
    enforcementLevel: enforcementLevelFromCount(count24h),
    /** Not tracked in DB yet; null until fines exist on Ticket. */
    averageFineUsd: null as number | null,
  };
}

function streetFilter(streetName: string) {
  const decoded = decodeURIComponent(streetName);
  return {
    streetLocation: { contains: decoded },
  };
}

/** Street Insights screen: history + simple distributions from ticket timestamps. */
export async function getStreetInsights(streetName: string) {
  const where = streetFilter(streetName);
  const now = new Date();
  const since24h = new Date(now.getTime() - MS_DAY);
  const since30d = new Date(now.getTime() - 30 * MS_DAY);

  const [lastTicket, count24h, count7d, count30d] = await Promise.all([
    prisma.ticket.findFirst({
      where,
      orderBy: { timestamp: 'desc' },
      select: {
        ticketId: true,
        streetLocation: true,
        timestamp: true,
        lat: true,
        lng: true,
        licensePlateNumber: true,
        licensePlateState: true,
      },
    }),
    prisma.ticket.count({ where: { ...where, timestamp: { gte: since24h } } }),
    prisma.ticket.count({ where: { ...where, timestamp: { gte: new Date(now.getTime() - 7 * MS_DAY) } } }),
    prisma.ticket.count({ where: { ...where, timestamp: { gte: since30d } } }),
  ]);

  if (!lastTicket) {
    return null;
  }

  const tickets24h = await prisma.ticket.findMany({
    where: { ...where, timestamp: { gte: since24h } },
    select: { timestamp: true },
  });

  const hourlyCounts = Array.from({ length: 24 }, () => 0);
  for (const t of tickets24h) {
    const h = t.timestamp.getHours();
    hourlyCounts[h] += 1;
  }

  const tickets30d = await prisma.ticket.findMany({
    where: { ...where, timestamp: { gte: since30d } },
    select: { timestamp: true },
  });

  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  for (const t of tickets30d) {
    weekdayCounts[t.timestamp.getDay()] += 1;
  }

  const maxW = Math.max(...weekdayCounts, 1);
  const activityByDay = weekdayLabels.map((label, i) => {
    const c = weekdayCounts[i]!;
    let level: 'none' | 'low' | 'medium' | 'peak' = 'none';
    if (c > 0) {
      if (c >= maxW * 0.75) level = 'peak';
      else if (c >= maxW * 0.35) level = 'medium';
      else level = 'low';
    }
    return { day: label, count: c, level };
  });

  return {
    street: lastTicket.streetLocation,
    lastTicket: {
      ticketId: lastTicket.ticketId,
      timestamp: lastTicket.timestamp,
      coordinates: { lat: lastTicket.lat, lng: lastTicket.lng },
      licensePlateNumber: lastTicket.licensePlateNumber,
      licensePlateState: lastTicket.licensePlateState,
    },
    ticketCount24h: count24h,
    ticketCount7d: count7d,
    ticketCount30d: count30d,
    enforcementLevel: enforcementLevelFromCount(count24h),
    averageFineUsd: null as number | null,
    distribution24h: {
      /** Counts indexed by hour 0–23 for tickets in the last 24h on this street. */
      bucketsByHour: hourlyCounts,
    },
    activityByDay,
    /** Placeholder for future community-sourced data (Stitch UI). */
    communityReports: [] as Array<{ id: string; summary: string; reportedAt: string }>,
  };
}
