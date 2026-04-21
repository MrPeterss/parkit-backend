/**
 * Lane state management for the multi-block ticket scraper.
 *
 * A "lane" tracks one 500-wide block of ticket IDs (one device/officer).
 * Many lanes run in parallel; the scheduler picks the lane whose
 * `nextDueAt` is smallest and polls it.
 *
 * This module is pure state / DB orchestration. It does NOT touch Playwright
 * or the portal — the scraper loop in `ticketScraper.ts` drives the actual
 * HTTP calls and feeds results back in via `applyHit` / `applyMiss`.
 */

import type { ScraperLane } from '@prisma/client';
import { prisma } from '../prisma.js';
import {
  BLOCK_SIZE,
  blockEndIdOf,
  blockStartIdOf,
  formatLike,
  incrementTicketId,
  parseTicketIdOrThrow,
  remainingInBlock,
} from './blockMath.js';

export type LaneStatus = 'active' | 'retired';

export type LaneState = {
  blockStartId: string;
  blockEndId: string;
  nextCursorId: string;
  lastFoundId: string | null;
  lastFoundAt: Date | null;
  missStreak: number;
  cadenceLevel: number;
  nextDueAt: Date;
  status: LaneStatus;
  retiredAt: Date | null;
  retiredReason: string | null;
};

// ---------------------------------------------------------------------------
// Configuration (env-tunable)
// ---------------------------------------------------------------------------

const DEFAULT_CADENCE_LEVELS_MS = [
  2_000,       // 2s       — just hit, poll hot
  10_000,      // 10s
  30_000,      // 30s
  60_000,      // 1m
  300_000,     // 5m
  900_000,     // 15m
  1_800_000,   // 30m      — floor for a cold-but-alive lane
];

const parseIntList = (raw: string | undefined, fallback: number[]): number[] => {
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
};

export const LANE_CADENCE_LEVELS_MS: number[] = parseIntList(
  process.env.LANE_CADENCE_LEVELS_MS,
  DEFAULT_CADENCE_LEVELS_MS,
);

export const LANE_JITTER_PCT = (() => {
  const raw = parseFloat(process.env.LANE_JITTER_PCT ?? '0.15');
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.15;
})();

/** How far ahead of the current frontier we probe during discovery. */
export const LANE_LOOKAHEAD_BLOCKS = (() => {
  const raw = parseInt(process.env.LANE_LOOKAHEAD_BLOCKS ?? '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/** How many IDs at the head of a candidate block we probe to confirm liveness. */
export const LANE_DISCOVERY_PROBE_COUNT = (() => {
  const raw = parseInt(process.env.LANE_DISCOVERY_PROBE_COUNT ?? '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/** Minimum gap between discovery sweeps. */
export const LANE_DISCOVERY_INTERVAL_MS = (() => {
  const raw = parseInt(process.env.LANE_DISCOVERY_INTERVAL_MS ?? `${10 * 60_000}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
})();

/** Block tail threshold — within this many IDs of blockEnd we consider the lane "at tail". */
export const LANE_TAIL_THRESHOLD = (() => {
  const raw = parseInt(process.env.LANE_TAIL_THRESHOLD ?? '20', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();

/** Max cadence at the tail (don't let tail lanes decay past this). */
export const LANE_TAIL_MAX_CADENCE_MS = (() => {
  const raw = parseInt(process.env.LANE_TAIL_MAX_CADENCE_MS ?? `${5 * 60_000}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
})();

/** Retire a tail lane after it's been idle this long with no hits. */
export const LANE_TAIL_RETIRE_AFTER_MS = (() => {
  const raw = parseInt(process.env.LANE_TAIL_RETIRE_AFTER_MS ?? `${4 * 60 * 60_000}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4 * 60 * 60_000;
})();

/** Retire any lane (tail or not) after this much total idle time with no hits. */
export const LANE_MAX_IDLE_MS = (() => {
  const raw = parseInt(process.env.LANE_MAX_IDLE_MS ?? `${48 * 60 * 60_000}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 48 * 60 * 60_000;
})();

/** Comma-separated full ticket IDs used to seed lanes on first boot. */
export const LANE_BOOTSTRAP_BLOCK_STARTS: string[] = (() => {
  const raw = process.env.LANE_BOOTSTRAP_BLOCK_STARTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
})();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const jitter = (ms: number): number => {
  const delta = ms * LANE_JITTER_PCT;
  return Math.max(0, ms + (Math.random() * 2 - 1) * delta);
};

export const cadenceForLevel = (level: number): number => {
  const clamped = Math.min(Math.max(level, 0), LANE_CADENCE_LEVELS_MS.length - 1);
  return LANE_CADENCE_LEVELS_MS[clamped];
};

export const isAtTail = (lane: LaneState): boolean =>
  remainingInBlock(lane.nextCursorId) <= LANE_TAIL_THRESHOLD;

const rowToLane = (row: ScraperLane): LaneState => ({
  blockStartId: row.blockStartId,
  blockEndId: row.blockEndId,
  nextCursorId: row.nextCursorId,
  lastFoundId: row.lastFoundId,
  lastFoundAt: row.lastFoundAt,
  missStreak: row.missStreak,
  cadenceLevel: row.cadenceLevel,
  nextDueAt: row.nextDueAt,
  status: (row.status === 'retired' ? 'retired' : 'active') as LaneStatus,
  retiredAt: row.retiredAt,
  retiredReason: row.retiredReason,
});

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

export const loadLanes = async (): Promise<Map<string, LaneState>> => {
  const rows = await prisma.scraperLane.findMany();
  const map = new Map<string, LaneState>();
  for (const row of rows) {
    map.set(row.blockStartId, rowToLane(row));
  }
  return map;
};

export const persistLane = async (lane: LaneState): Promise<void> => {
  const data = {
    blockEndId: lane.blockEndId,
    nextCursorId: lane.nextCursorId,
    lastFoundId: lane.lastFoundId,
    lastFoundAt: lane.lastFoundAt,
    missStreak: lane.missStreak,
    cadenceLevel: lane.cadenceLevel,
    nextDueAt: lane.nextDueAt,
    status: lane.status,
    retiredAt: lane.retiredAt,
    retiredReason: lane.retiredReason,
  };

  await prisma.scraperLane.upsert({
    where: { blockStartId: lane.blockStartId },
    create: { blockStartId: lane.blockStartId, ...data },
    update: data,
  });
};

export const getLastDiscoveryAt = async (): Promise<Date | null> => {
  const row = await prisma.scraperState.findUnique({
    where: { id: 1 },
    select: { lastDiscoveryAt: true },
  });
  return row?.lastDiscoveryAt ?? null;
};

export const setLastDiscoveryAt = async (at: Date): Promise<void> => {
  await prisma.scraperState.update({
    where: { id: 1 },
    data: { lastDiscoveryAt: at },
  });
};

// ---------------------------------------------------------------------------
// Lane construction
// ---------------------------------------------------------------------------

export const createLane = (
  blockStartId: string,
  nextCursorId: string,
  now: Date = new Date(),
): LaneState => ({
  blockStartId,
  blockEndId: blockEndIdOf(blockStartId),
  nextCursorId,
  lastFoundId: null,
  lastFoundAt: null,
  missStreak: 0,
  cadenceLevel: 0,
  nextDueAt: now,
  status: 'active',
  retiredAt: null,
  retiredReason: null,
});

const FAR_FUTURE_MS = 365 * 24 * 60 * 60_000;

/**
 * Resolve env-provided seed ticket IDs. `LANE_BOOTSTRAP_BLOCK_STARTS` takes
 * precedence over `DEFAULT_START_TICKET_ID`; the latter is only used as a
 * single seed when the former is empty.
 */
const resolveEnvSeeds = (): { seeds: string[]; floorNumeric: number | null } => {
  const seeds: string[] = [];
  for (const raw of LANE_BOOTSTRAP_BLOCK_STARTS) seeds.push(raw);

  const envDefault = process.env.DEFAULT_START_TICKET_ID;
  if (seeds.length === 0 && envDefault) seeds.push(envDefault);

  let floorNumeric: number | null = null;
  for (const id of seeds) {
    const n = parseTicketIdOrThrow(id).numeric;
    if (floorNumeric === null || n < floorNumeric) floorNumeric = n;
  }
  return { seeds, floorNumeric };
};

/**
 * Always-runs bootstrap. Idempotent. Responsibilities:
 *   1. If env provides seed IDs, compute a "floor" = min(numeric) across seeds.
 *      - Retire any active DB lane whose entire block is behind the floor
 *        (reason: `bootstrap_floor`).
 *      - Fast-forward any active DB lane whose cursor is behind the floor
 *        (but whose block still overlaps).
 *   2. For each env seed, ensure a lane exists at that seed's block. If one
 *      exists, fast-forward its cursor to the seed value when the seed is
 *      ahead. If not, create a lane with the seed as the initial cursor.
 *   3. If after steps 1–2 there are still no active lanes, fall back to the
 *      highest ticket in the DB (first-boot convenience).
 *
 * Never un-retires a lane that was previously retired — retirement is sticky.
 */
export const bootstrapLanes = async (): Promise<void> => {
  const { seeds, floorNumeric } = resolveEnvSeeds();
  const now = new Date();

  // 1. Apply env floor to existing lanes.
  if (floorNumeric !== null) {
    const existing = await prisma.scraperLane.findMany({ where: { status: 'active' } });
    for (const row of existing) {
      const blockEndNum = parseTicketIdOrThrow(row.blockEndId).numeric;
      const cursorNum = parseTicketIdOrThrow(row.nextCursorId).numeric;

      if (blockEndNum < floorNumeric) {
        await prisma.scraperLane.update({
          where: { blockStartId: row.blockStartId },
          data: {
            status: 'retired',
            retiredAt: now,
            retiredReason: 'bootstrap_floor',
            nextDueAt: new Date(now.getTime() + FAR_FUTURE_MS),
          },
        });
        console.log(
          `🪦 Retiring lane ${row.blockStartId} — entirely behind bootstrap floor ` +
          `(blockEnd=${row.blockEndId}, floor numeric=${floorNumeric})`,
        );
        continue;
      }

      if (cursorNum < floorNumeric) {
        const newCursor = formatLike(row.blockStartId, floorNumeric);
        await prisma.scraperLane.update({
          where: { blockStartId: row.blockStartId },
          data: { nextCursorId: newCursor },
        });
        console.log(
          `⏩ Fast-forwarding lane ${row.blockStartId} cursor ${row.nextCursorId} → ${newCursor} ` +
          `(bootstrap floor)`,
        );
      }
    }
  }

  // 2. Ensure each env seed has a lane; fast-forward if seed is ahead of the
  //    existing cursor in that block.
  const seenBlocks = new Set<string>();
  for (const seedId of seeds) {
    const blockStartId = blockStartIdOf(seedId);
    if (seenBlocks.has(blockStartId)) continue;
    seenBlocks.add(blockStartId);

    const existing = await prisma.scraperLane.findUnique({ where: { blockStartId } });

    if (existing) {
      if (existing.status !== 'active') {
        console.log(
          `ℹ️  Env seed ${seedId} falls in retired lane ${blockStartId} — leaving retired ` +
          `(status=${existing.status}, reason=${existing.retiredReason ?? 'unknown'})`,
        );
        continue;
      }
      const cursorNum = parseTicketIdOrThrow(existing.nextCursorId).numeric;
      const seedNum = parseTicketIdOrThrow(seedId).numeric;
      if (seedNum > cursorNum) {
        await prisma.scraperLane.update({
          where: { blockStartId },
          data: { nextCursorId: seedId },
        });
        console.log(
          `⏩ Fast-forwarding lane ${blockStartId} cursor ${existing.nextCursorId} → ${seedId} ` +
          `(env seed)`,
        );
      }
      continue;
    }

    const resumeFrom = await resolveResumeCursor(blockStartId, seedId);
    const lane = createLane(blockStartId, resumeFrom);
    await persistLane(lane);
    console.log(`🌱 Bootstrapped lane for block ${blockStartId} (cursor=${resumeFrom})`);
  }

  // 3. If still no active lanes, fall back to the highest ticket in DB.
  const activeCount = await prisma.scraperLane.count({ where: { status: 'active' } });
  if (activeCount > 0) return;

  const highestTicket = await prisma.ticket.findFirst({
    orderBy: { ticketId: 'desc' },
    select: { ticketId: true },
  });

  if (!highestTicket) {
    throw new Error(
      'No active lanes and no tickets in DB (set LANE_BOOTSTRAP_BLOCK_STARTS or DEFAULT_START_TICKET_ID, or ensure at least one Ticket exists).',
    );
  }

  const blockStartId = blockStartIdOf(highestTicket.ticketId);
  const existing = await prisma.scraperLane.findUnique({ where: { blockStartId } });
  if (existing) {
    console.warn(
      `⚠️  All lanes retired; DB fallback block ${blockStartId} is also retired. ` +
      `Discovery will need to surface new blocks.`,
    );
    return;
  }

  const resumeFrom = await resolveResumeCursor(blockStartId, undefined);
  const lane = createLane(blockStartId, resumeFrom);
  await persistLane(lane);
  console.log(`🌱 Bootstrapped lane for block ${blockStartId} (cursor=${resumeFrom}) from DB fallback`);
};

/**
 * Pick a sensible `nextCursorId` within `blockStartId` based on whatever we
 * already know about that block (highest ticket already in DB, or the env
 * default, or the block start itself).
 */
const resolveResumeCursor = async (
  blockStartId: string,
  envDefault: string | undefined,
): Promise<string> => {
  const { numeric: startNum } = parseTicketIdOrThrow(blockStartId);
  const blockEndNum = startNum + BLOCK_SIZE - 1;

  let bestNumeric = startNum; // default: start of block

  // Highest ticket in DB that lies inside this block. String comparison is
  // safe here because every ticket in the same block shares prefix + width.
  const endId = formatLike(blockStartId, blockEndNum);
  const candidate = await prisma.ticket.findFirst({
    where: { ticketId: { gte: blockStartId, lte: endId } },
    orderBy: { ticketId: 'desc' },
    select: { ticketId: true },
  });
  if (candidate) {
    const n = parseTicketIdOrThrow(candidate.ticketId).numeric;
    if (n + 1 > bestNumeric) bestNumeric = n + 1;
  }

  // If env default lies in this block, respect it too
  if (envDefault) {
    const parsedEnv = parseTicketIdOrThrow(envDefault);
    if (parsedEnv.numeric >= startNum && parsedEnv.numeric <= blockEndNum) {
      if (parsedEnv.numeric > bestNumeric) bestNumeric = parsedEnv.numeric;
    }
  }

  // Cap at blockEnd (shouldn't happen given checks, but be safe)
  if (bestNumeric > blockEndNum) bestNumeric = blockEndNum;

  return formatLike(blockStartId, bestNumeric);
};

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export const activeLanes = (lanes: Map<string, LaneState>): LaneState[] =>
  [...lanes.values()].filter((l) => l.status === 'active');

/** Returns the active lane with the smallest `nextDueAt`. */
export const pickNextLane = (lanes: Map<string, LaneState>): LaneState | null => {
  const active = activeLanes(lanes);
  if (active.length === 0) return null;
  return active.reduce((a, b) => (a.nextDueAt <= b.nextDueAt ? a : b));
};

export const msUntilDue = (lane: LaneState, now: Date = new Date()): number =>
  Math.max(0, lane.nextDueAt.getTime() - now.getTime());

export const shouldRunDiscovery = (
  lastDiscoveryAt: Date | null,
  now: Date = new Date(),
): boolean => {
  if (!lastDiscoveryAt) return true;
  return now.getTime() - lastDiscoveryAt.getTime() >= LANE_DISCOVERY_INTERVAL_MS;
};

// ---------------------------------------------------------------------------
// Lane state transitions (mutate lane in place)
// ---------------------------------------------------------------------------

/** A successful hit on `foundTicketId` — advance cursor and reset decay. */
export const applyHit = (
  lane: LaneState,
  foundTicketId: string,
  now: Date = new Date(),
): { blockComplete: boolean } => {
  lane.lastFoundId = foundTicketId;
  lane.lastFoundAt = now;
  lane.missStreak = 0;
  lane.cadenceLevel = 0;

  const foundNumeric = parseTicketIdOrThrow(foundTicketId).numeric;
  const blockEndNum = parseTicketIdOrThrow(lane.blockEndId).numeric;

  if (foundNumeric >= blockEndNum) {
    // Consumed the last slot in this block.
    retireLane(lane, 'block_complete', now);
    return { blockComplete: true };
  }

  lane.nextCursorId = formatLike(lane.blockStartId, foundNumeric + 1);
  lane.nextDueAt = new Date(now.getTime() + jitter(cadenceForLevel(0)));
  return { blockComplete: false };
};

/**
 * Advance the cursor past `currentId` without treating this as a "real" hit.
 * Used for CLOSED / FAILED_CHALLENGE responses: the slot exists in the portal
 * but we can't extract a useful record. We still make progress in the lane.
 */
export const applyAdvanceWithoutHit = (
  lane: LaneState,
  currentId: string,
  now: Date = new Date(),
): { blockComplete: boolean } => {
  const currentNumeric = parseTicketIdOrThrow(currentId).numeric;
  const blockEndNum = parseTicketIdOrThrow(lane.blockEndId).numeric;

  if (currentNumeric >= blockEndNum) {
    retireLane(lane, 'block_complete', now);
    return { blockComplete: true };
  }

  lane.nextCursorId = formatLike(lane.blockStartId, currentNumeric + 1);
  lane.missStreak = 0; // we did learn something — don't decay
  lane.cadenceLevel = Math.max(0, lane.cadenceLevel - 1);
  lane.nextDueAt = new Date(now.getTime() + jitter(cadenceForLevel(lane.cadenceLevel)));
  return { blockComplete: false };
};

/** A confirmed miss (after neighbor probe) — decay cadence, maybe retire. */
export const applyMiss = (
  lane: LaneState,
  now: Date = new Date(),
): { retired: boolean; reason?: string } => {
  lane.missStreak += 1;
  lane.cadenceLevel = Math.min(lane.cadenceLevel + 1, LANE_CADENCE_LEVELS_MS.length - 1);

  // Tail lanes can't decay past the tail cap
  let cadenceMs = cadenceForLevel(lane.cadenceLevel);
  if (isAtTail(lane) && cadenceMs > LANE_TAIL_MAX_CADENCE_MS) {
    cadenceMs = LANE_TAIL_MAX_CADENCE_MS;
  }
  lane.nextDueAt = new Date(now.getTime() + jitter(cadenceMs));

  // Retirement policy
  const idleMs = lane.lastFoundAt ? now.getTime() - lane.lastFoundAt.getTime() : Infinity;

  if (isAtTail(lane) && idleMs >= LANE_TAIL_RETIRE_AFTER_MS) {
    retireLane(lane, 'tail_idle', now);
    return { retired: true, reason: 'tail_idle' };
  }
  if (idleMs >= LANE_MAX_IDLE_MS) {
    retireLane(lane, 'max_idle', now);
    return { retired: true, reason: 'max_idle' };
  }

  return { retired: false };
};

export const retireLane = (
  lane: LaneState,
  reason: string,
  now: Date = new Date(),
): void => {
  lane.status = 'retired';
  lane.retiredAt = now;
  lane.retiredReason = reason;
  // Push nextDueAt far in the future so the scheduler never picks it.
  lane.nextDueAt = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
};

// ---------------------------------------------------------------------------
// Discovery candidates
// ---------------------------------------------------------------------------

/** Highest known blockStart across all lanes (retired or not). */
export const frontierBlockStartId = (lanes: Map<string, LaneState>): string | null => {
  let best: { id: string; num: number } | null = null;
  for (const lane of lanes.values()) {
    const num = parseTicketIdOrThrow(lane.blockStartId).numeric;
    if (!best || num > best.num) best = { id: lane.blockStartId, num };
  }
  return best ? best.id : null;
};

/**
 * Block-start IDs we should probe for new lanes: N blocks ahead of the
 * frontier, plus the "successor" block of any recently block-complete lane.
 */
export const discoveryCandidates = (
  lanes: Map<string, LaneState>,
): string[] => {
  const known = new Set(lanes.keys());
  const out: string[] = [];

  const frontier = frontierBlockStartId(lanes);
  if (frontier) {
    const { numeric: frontierNum } = parseTicketIdOrThrow(frontier);
    for (let k = 1; k <= LANE_LOOKAHEAD_BLOCKS; k++) {
      const candidateNum = frontierNum + k * BLOCK_SIZE;
      const candidateId = formatLike(frontier, candidateNum);
      if (!known.has(candidateId)) out.push(candidateId);
    }
  }

  // Also add successors of recently completed / retired lanes (not in lookahead window)
  for (const lane of lanes.values()) {
    if (lane.retiredReason !== 'block_complete') continue;
    const { numeric: laneNum } = parseTicketIdOrThrow(lane.blockStartId);
    const successorNum = laneNum + BLOCK_SIZE;
    const successorId = formatLike(lane.blockStartId, successorNum);
    if (!known.has(successorId) && !out.includes(successorId)) {
      out.push(successorId);
    }
  }

  return out;
};

/** First few ticket IDs to probe inside a candidate block. */
export const probeIdsForBlock = (blockStartId: string): string[] => {
  const ids: string[] = [];
  const { numeric: startNum } = parseTicketIdOrThrow(blockStartId);
  const max = Math.min(LANE_DISCOVERY_PROBE_COUNT, BLOCK_SIZE);
  for (let i = 0; i < max; i++) {
    ids.push(formatLike(blockStartId, startNum + i));
  }
  return ids;
};

// Re-export for convenience in the scraper
export { incrementTicketId, blockStartIdOf, formatLike };
