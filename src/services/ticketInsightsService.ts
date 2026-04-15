import { prisma } from '../prisma.js';
import { getHourInTimeZone, getWeekdayIndexInTimeZone } from '../utils/timezone.js';

const MS_DAY = 24 * 60 * 60 * 1000;

/** Default ~2 months; override with env `TICKET_INSIGHTS_LOOKBACK_DAYS` (1–365). */
function insightLookbackDays(): number {
  const raw = process.env.TICKET_INSIGHTS_LOOKBACK_DAYS;
  const n = raw ? Number.parseInt(raw, 10) : 60;
  if (!Number.isFinite(n)) return 60;
  return Math.min(365, Math.max(1, Math.trunc(n)));
}

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

export type StreetInsightsOptions = {
  /** IANA time zone for hour-of-day and weekday bucketing (e.g. `America/New_York`). */
  timeZone: string;
};

/** Street Insights screen: history + simple distributions from ticket timestamps. */
export async function getStreetInsights(streetName: string, options: StreetInsightsOptions) {
  const { timeZone } = options;
  const where = streetFilter(streetName);
  const now = new Date();
  const since24h = new Date(now.getTime() - MS_DAY);
  const since30d = new Date(now.getTime() - 30 * MS_DAY);
  const lookbackDays = insightLookbackDays();
  const sinceLookback = new Date(now.getTime() - lookbackDays * MS_DAY);

  const [lastTicket, count24h, count7d, count30d, countLookback] = await Promise.all([
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
    prisma.ticket.count({ where: { ...where, timestamp: { gte: sinceLookback } } }),
  ]);

  if (!lastTicket) {
    return null;
  }

  const ticketsLookback = await prisma.ticket.findMany({
    where: { ...where, timestamp: { gte: sinceLookback } },
    select: { timestamp: true },
  });

  // Hour-of-day totals in `timeZone` over the lookback: when do tickets usually occur locally?
  const bucketsByHour = Array.from({ length: 24 }, () => 0);
  for (const t of ticketsLookback) {
    const h = getHourInTimeZone(t.timestamp, timeZone);
    bucketsByHour[h]! += 1;
  }

  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  for (const t of ticketsLookback) {
    weekdayCounts[getWeekdayIndexInTimeZone(t.timestamp, timeZone)]! += 1;
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
    ticketCountLookback: countLookback,
    lookbackDays,
    enforcementLevel: enforcementLevelFromCount(count24h),
    averageFineUsd: null as number | null,
    distribution24h: {
      aggregation: 'hourOfDay' as const,
      /** IANA zone used for `bucketsByHour` and `activityByDay` (same as request `tz`). */
      timezone: timeZone,
      lookbackDays,
      windowStart: sinceLookback.toISOString(),
      windowEnd: now.toISOString(),
      /**
       * Length 24. Total tickets in the lookback whose local clock hour in `timezone` is `i`
       * (0 = midnight–1:00 in that zone). Not a timeline—use for “what time of day” patterns.
       */
      bucketsByHour,
    },
    activityByDay,
    /** Placeholder for future community-sourced data (Stitch UI). */
    communityReports: [] as Array<{ id: string; summary: string; reportedAt: string }>,
  };
}
