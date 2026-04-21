import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { Solver } from '@2captcha/captcha-solver';

chromium.use(stealth());

import { prisma } from '../prisma.js';
import { extractGpsFromImageUrl } from '../services/ocrService.js';
import { emitNewTicket } from '../services/notificationService.js';
import { ensureStreetGeometryStored } from '../services/streetGeometryService.js';
import { TicketMessage, TicketSearchResult, type TicketSearchResponse } from '../tickets/types.js';
import type { Ticket } from '@prisma/client';
import {
  formatLike,
  parseTicketIdOrThrow,
} from './blockMath.js';
import {
  applyAdvanceWithoutHit,
  applyHit,
  applyMiss,
  bootstrapLanes,
  createLane,
  discoveryCandidates,
  frontierBlockStartId,
  getLastDiscoveryAt,
  isAtTail,
  loadLanes,
  msUntilDue,
  persistLane,
  pickNextLane,
  probeIdsForBlock,
  setLastDiscoveryAt,
  shouldRunDiscovery,
} from './laneManager.js';
import type { LaneState } from './laneManager.js';

const solver = new Solver(process.env.TWOCAPTCHA_API_KEY ?? '');

const SCRAPER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TICKET_PORTAL_URL =
  'https://www.tocite.net/cityofithaca/portal/ticket' as const;

// Sleeps for ms ± 5% to avoid predictable timing patterns
const sleep = (ms: number) => {
  const jitter = ms * 0.05;
  const actual = ms + (Math.random() * 2 - 1) * jitter;
  return new Promise<void>((resolve) => setTimeout(resolve, actual));
};

const SCRAPER_START_HOUR = 8;
const SCRAPER_START_MINUTE = 30;
const SCRAPER_END_HOUR = 17;
const SCRAPER_END_MINUTE = 30;
const SCRAPER_TIMEZONE = 'America/New_York';

// Returns ms until the next weekday 8:30 AM ET if currently outside active hours, otherwise 0.
const msUntilActiveHours = (): number => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCRAPER_TIMEZONE,
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday')!.value; // Mon, Tue, ... Sun
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const totalMinutes = hour * 60 + minute;

  const startMinutes = SCRAPER_START_HOUR * 60 + SCRAPER_START_MINUTE;
  const endMinutes = SCRAPER_END_HOUR * 60 + SCRAPER_END_MINUTE;

  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const isWithinHours = totalMinutes >= startMinutes && totalMinutes < endMinutes;

  if (!isWeekend && isWithinHours) return 0;

  let daysUntilMonday = 0;
  if (weekday === 'Sat') daysUntilMonday = 2;
  else if (weekday === 'Sun') daysUntilMonday = 1;

  let minutesUntilStart: number;
  if (daysUntilMonday > 0) {
    minutesUntilStart = daysUntilMonday * 24 * 60 - totalMinutes + startMinutes;
  } else {
    minutesUntilStart = totalMinutes < startMinutes
      ? startMinutes - totalMinutes
      : 24 * 60 - totalMinutes + startMinutes;
  }

  return minutesUntilStart * 60 * 1000;
};

const waitForActiveHours = async (): Promise<void> => {
  const ms = msUntilActiveHours();
  if (ms === 0) return;

  const resumeAt = new Date(Date.now() + ms).toLocaleTimeString('en-US', {
    timeZone: SCRAPER_TIMEZONE, hour: '2-digit', minute: '2-digit',
  });
  console.log(`😴 Outside active hours — sleeping until ${resumeAt} ET (${Math.round(ms / 60000)}m)`);
  await updateScraperState({ status: 'sleeping' });
  await sleep(ms);
  console.log('⏰ Resuming scraper...');
};

const updateScraperState = async (params: {
  lastCheckedId?: string;
  status?: string;
}) => {
  await prisma.scraperState.update({
    where: { id: 1 },
    data: {
      ...(params.lastCheckedId ? { lastCheckedId: params.lastCheckedId } : {}),
      ...(params.status ? { status: params.status } : {}),
    },
  });
};

const submitTicketSearch = async (page: Page, ticketId: string) => {
  await sleep(1000);
  const inputSelector = '#ticket-number-search';

  if (await page.isVisible('button[aria-label="Back"]')) {
    await page.click('button[aria-label="Back"]');
  }

  await page.waitForSelector(inputSelector, {
    timeout: 5000,
    state: 'visible'
  });

  await page.click(inputSelector);
  await page.fill(inputSelector, '');
  await page.type(inputSelector, ticketId, { delay: 50 });
  await sleep(500);

  const searchButtonSelector =
    'button[type="submit"], button:has-text("Search"), button:has-text("Lookup")';

  await page.click(searchButtonSelector);

  await page.waitForSelector('div.loading-spinner-text', { state: 'hidden' });

  console.log('⏳ Waiting for search results...');
  try {
    await Promise.race([
      page.waitForSelector('#ticket-search-captcha', { timeout: 10000 }).then(() => {
        console.log('🔍 CAPTCHA element appeared');
      }),
      page.waitForSelector('div#ticket-search-messages > div.alert', { timeout: 10000 }).then(() => {
        console.log('🔍 Search messages alert appeared');
      }),
      page.waitForSelector(`div#ticket-results > div.result-container`, { timeout: 10000 }).then(() => {
        console.log('🔍 Ticket card appeared');
      }),
    ]);
    console.log('✅ Search results loaded');
  } catch (error) {
    console.log('⚠️  Timeout waiting for results, continuing anyway...');
  }

  await sleep(500);
};


// Parses a timestamp string in Eastern time (e.g. "12/15/2025 10:38 AM") and
// returns a UTC Date. Uses Intl to detect the correct ET offset (EST -5 / EDT -4)
// so DST transitions are handled automatically.
const parseEasternTimestamp = (text: string): Date => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(text.trim());
  if (!match) return new Date(text);

  const [, mo, da, yr, hr, mi, ampm] = match;
  let h = parseInt(hr, 10);
  if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
  else if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;

  const probe = new Date(Date.UTC(+yr, +mo - 1, +da, h, +mi));
  const offsetStr =
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(probe)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';

  const offsetHours = parseInt(offsetStr.replace('GMT', ''), 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = offsetHours >= 0 ? '+' : '-';
  const iso = `${yr}-${pad(+mo)}-${pad(+da)}T${pad(h)}:${pad(+mi)}:00${sign}${pad(Math.abs(offsetHours))}:00`;
  return new Date(iso);
};

const getTicketDetails = async (ticketId: string, page: Page): Promise<Ticket | null> => {
  const card = await page.$(`div.card.ticket-card[data-citationnumber='${ticketId}']`);
  if (!card) return null;

  const cardHeader = await card.$('div.card-header button');
  console.log("card header is there?", cardHeader != null ? "yes" : "no");
  if (!cardHeader) return null;

  const timestamp = await cardHeader.$('span:nth-child(3)')
  const timestampText = await timestamp?.textContent();
  const timestampDate = parseEasternTimestamp(timestampText ?? '');

  const ticketCardInfo = await card.$('div.ticket-card-info')

  const licensePlate = await ticketCardInfo?.$('span#LicenseNoState')
  const licensePlateText = (await licensePlate?.textContent())?.trim();

  const licensePlateState = await ticketCardInfo?.$('span#LicenseState')
  const licensePlateStateText = (await licensePlateState?.textContent())?.trim();

  const evidenceImage = await card.$('div.carousel-inner > div:first-child > img');
  const evidenceUrl = await evidenceImage?.getAttribute('src');
  const ocrResult = await extractGpsFromImageUrl(evidenceUrl ?? null);

  const streetLocation = await card.$('span#ViolationLocation')
  const streetLocationText = await streetLocation?.textContent();

  const lat = ocrResult?.lat;
  const lng = ocrResult?.lng;

  return {
    ticketId,
    licensePlateNumber: licensePlateText ?? null,
    licensePlateState: licensePlateStateText ?? null,
    timestamp: timestampDate,
    lat: lat ?? null,
    lng: lng ?? null,
    streetLocation: streetLocationText ?? null,
  };
}

export const getTicketSearchResponse = async (ticketId: string, page: Page): Promise<TicketSearchResponse> => {
  const textContent = await page.textContent('body');

  if (!textContent) {
    console.log('🔍 No text content');
    return {
      result: TicketSearchResult.NO_RESULTS,
      ticket: null,
    };
  }

  if (await page.isVisible("#ticket-search-captcha")) {
    console.log('CAPTCHA');
    return {
      result: TicketSearchResult.CAPTCHA,
      ticket: null,
    };
  }

  if (textContent.includes(TicketMessage.FAILED_CHALLENGE)) {
    console.log('FAILED_CHALLENGE');
    return {
      result: TicketSearchResult.FAILED_CHALLENGE,
      ticket: null,
    };
  }

  if (textContent.includes(TicketMessage.REMITTANCE) || textContent.includes(TicketMessage.CLOSED)) {
    console.log('CLOSED');
    return {
      result: TicketSearchResult.CLOSED,
      ticket: null,
    };
  }

  if (textContent.includes(TicketMessage.NO_RESULTS)) {
    console.log('NO_RESULTS');
    return {
      result: TicketSearchResult.NO_RESULTS,
      ticket: null,
    };
  }

  const ticket = await getTicketDetails(ticketId, page);
  if (!ticket) return {
    result: TicketSearchResult.NO_RESULTS,
    ticket: null,
  };

  return {
    result: TicketSearchResult.ACCESSIBLE,
    ticket,
  };
};

// Solves the CAPTCHA and calls window.validateCaptcha(token).
// After validation, results appear automatically — no need to re-submit the search.
const solveCaptcha = async (page: Page): Promise<boolean> => {
  try {
    console.log('🔐 Solving CAPTCHA...');

    const recaptchaEl = await page.$('div.g-recaptcha');
    const googleKey = await recaptchaEl?.getAttribute('data-sitekey');
    const captchaAction = await recaptchaEl?.getAttribute('data-action');

    if (!googleKey || !captchaAction) {
      console.log('⚠️  CAPTCHA metadata not found');
      return false;
    }

    const solution = await solver.recaptcha({
      googlekey: googleKey,
      pageurl: page.url(),
      action: captchaAction,
      userAgent: SCRAPER_USER_AGENT,
      invisible: 0,
      version: 'v2',
      enterprise: 1,
    });

    if (!solution) {
      console.log('⚠️  No solution returned from solver');
      return false;
    }

    console.log('✅ CAPTCHA solved, submitting token...');

    await page.evaluate((token) => {
      if (typeof (window as any).validateCaptcha === 'function') {
        (window as any).validateCaptcha(token);
      }
    }, solution.data);

    try {
      await Promise.race([
        page.waitForSelector('div#ticket-search-messages > div.alert', { timeout: 10000 }),
        page.waitForSelector('div#ticket-results > div.result-container', { timeout: 10000 }),
      ]);
      console.log('✅ Results loaded after CAPTCHA solve');
    } catch {
      console.log('⚠️  Timed out waiting for results after CAPTCHA solve');
    }

    return true;
  } catch (error) {
    console.error('❌ Error solving CAPTCHA:', error);
    return false;
  }
};

class CaptchaExhaustedError extends Error {
  constructor() {
    super('CAPTCHA could not be solved after max attempts');
    this.name = 'CaptchaExhaustedError';
  }
}

export const searchForTicket = async (page: Page, ticketId: string): Promise<TicketSearchResponse> => {
  console.log(`🔍 Searching for ticket: ${ticketId}`);
  await submitTicketSearch(page, ticketId);
  let searchResponse = await getTicketSearchResponse(ticketId, page);

  const maxAttempts = 5;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (searchResponse.result === TicketSearchResult.CAPTCHA) {
      attempts++;
      console.log(`🤖 CAPTCHA detected (attempt ${attempts}/${maxAttempts}), solving...`);
      await solveCaptcha(page);
      searchResponse = await getTicketSearchResponse(ticketId, page);
    } else if (searchResponse.result === TicketSearchResult.FAILED_CHALLENGE) {
      attempts++;
      console.log(`🚫 Failed challenge (attempt ${attempts}/${maxAttempts}), reloading and retrying...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 });
      await submitTicketSearch(page, ticketId);
      searchResponse = await getTicketSearchResponse(ticketId, page);
    } else {
      break;
    }
  }

  if (attempts >= maxAttempts) {
    throw new CaptchaExhaustedError();
  }

  return searchResponse;
};

const createPage = async (): Promise<{ browser: Awaited<ReturnType<typeof chromium.launch>>, page: Page }> => {
  console.log('🚀 Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: SCRAPER_USER_AGENT,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await context.newPage();

  console.log('🌐 Navigating to ticket portal...');
  await page.goto(TICKET_PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 5000 });
  await sleep(3000);
  console.log('✅ Browser ready');

  return { browser, page };
};

// ===========================================================================
// Lane-aware scheduling
// ===========================================================================

/**
 * Persists a found ticket (if new), emits notifications, kicks off side-effects.
 * Returns the DB row (existing or created).
 */
const saveFoundTicket = async (foundTicket: Ticket): Promise<Ticket> => {
  const existing = await prisma.ticket.findUnique({ where: { ticketId: foundTicket.ticketId } });
  let ticket: Ticket;
  if (existing) {
    console.log(`ℹ️  Ticket ${foundTicket.ticketId} already exists, skipping creation`);
    ticket = existing;
  } else {
    console.log('💾 Saving to database...');
    ticket = await prisma.ticket.create({ data: foundTicket });
    console.log(`✅ Saved ticket: ${ticket.ticketId}`);
  }

  if (foundTicket.streetLocation) {
    void ensureStreetGeometryStored(foundTicket.streetLocation);
  }

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  if (ticket.timestamp >= tenMinutesAgo) {
    void emitNewTicket(ticket);
  } else {
    console.log(`⏱️  Ticket is older than 10 minutes, skipping notification`);
  }

  return ticket;
};

/**
 * Poll a single lane once. Performs the primary search, neighbor probes if
 * the primary missed, and updates the lane state accordingly.
 */
const pollLane = async (lane: LaneState, page: Page): Promise<void> => {
  const primaryId = lane.nextCursorId;
  console.log(
    `\n🔍 [block ${lane.blockStartId}] checking ${primaryId} ` +
    `(miss=${lane.missStreak}, cadenceLvl=${lane.cadenceLevel}, tail=${isAtTail(lane)})`,
  );
  await updateScraperState({
    status: `checking ${primaryId}`,
    lastCheckedId: primaryId,
  });

  let searchResponse = await searchForTicket(page, primaryId);
  let resolvedId = primaryId;

  // Neighbor probe within the block (not across blocks!) to absorb transient
  // portal misses. We probe +1 and +2 if the primary cursor returns NO_RESULTS.
  if (searchResponse.result === TicketSearchResult.NO_RESULTS) {
    const { numeric: startNum } = parseTicketIdOrThrow(lane.nextCursorId);
    const { numeric: blockEndNum } = parseTicketIdOrThrow(lane.blockEndId);

    for (let step = 1; step <= 2; step++) {
      const probeNumeric = startNum + step;
      if (probeNumeric > blockEndNum) break; // do not bleed across blocks
      const probeId = formatLike(lane.blockStartId, probeNumeric);
      console.log(`🔁 NO_RESULTS for ${primaryId} — probing neighbor ${probeId} (${step}/2)`);
      const alt = await searchForTicket(page, probeId);
      if (alt.result !== TicketSearchResult.NO_RESULTS) {
        searchResponse = alt;
        resolvedId = probeId;
        break;
      }
    }
  }

  const now = new Date();

  switch (searchResponse.result) {
    case TicketSearchResult.ACCESSIBLE: {
      const foundTicket = searchResponse.ticket;
      if (!foundTicket) {
        // Shouldn't happen, but treat as miss.
        applyMiss(lane, now);
        break;
      }
      await saveFoundTicket(foundTicket);
      const { blockComplete } = applyHit(lane, foundTicket.ticketId, now);
      if (blockComplete) {
        console.log(`🏁 Block ${lane.blockStartId} completed at ${foundTicket.ticketId}`);
      } else {
        console.log(`➡️  Next in block ${lane.blockStartId}: ${lane.nextCursorId}`);
      }
      break;
    }

    case TicketSearchResult.CLOSED: {
      // The slot exists but is closed — advance without persisting a ticket.
      console.log(`🔒 Ticket ${resolvedId} is CLOSED — advancing cursor`);
      applyAdvanceWithoutHit(lane, resolvedId, now);
      break;
    }

    case TicketSearchResult.NO_RESULTS: {
      const decay = applyMiss(lane, now);
      if (decay.retired) {
        console.log(`🪦 Retiring lane ${lane.blockStartId} (reason=${decay.reason})`);
      } else {
        console.log(
          `📉 Miss on ${primaryId} — cadenceLvl now ${lane.cadenceLevel}, ` +
          `next due in ${Math.round((lane.nextDueAt.getTime() - now.getTime()) / 1000)}s`,
        );
      }
      break;
    }

    default: {
      // CAPTCHA / FAILED_CHALLENGE are handled inside searchForTicket; any
      // other unexpected state: treat as a soft miss.
      applyMiss(lane, now);
      break;
    }
  }

  await persistLane(lane);
  await updateScraperState({ status: 'ok' });
};

/**
 * Sweep candidate blocks for new lanes. Probes the first few IDs of each
 * candidate; the first block to yield a non-empty result becomes a new lane.
 */
const runDiscovery = async (
  lanes: Map<string, LaneState>,
  page: Page,
): Promise<void> => {
  const candidates = discoveryCandidates(lanes);
  if (candidates.length === 0) {
    console.log('🧭 Discovery: no candidates.');
    await setLastDiscoveryAt(new Date());
    return;
  }

  console.log(
    `🧭 Discovery sweep: frontier=${frontierBlockStartId(lanes)}, ` +
    `candidates=[${candidates.join(', ')}]`,
  );
  await updateScraperState({ status: 'discovering' });

  for (const candidateBlockStartId of candidates) {
    const probeIds = probeIdsForBlock(candidateBlockStartId);

    let firstHitId: string | null = null;
    let firstHitTicket: Ticket | null = null;

    for (const probeId of probeIds) {
      console.log(`🧪 Probe ${probeId} (candidate block ${candidateBlockStartId})`);
      await updateScraperState({ status: `probing ${probeId}`, lastCheckedId: probeId });

      const resp = await searchForTicket(page, probeId);

      if (resp.result === TicketSearchResult.ACCESSIBLE && resp.ticket) {
        firstHitId = probeId;
        firstHitTicket = resp.ticket;
        break;
      }
      if (resp.result === TicketSearchResult.CLOSED) {
        // The block is live even if this particular ID is closed.
        firstHitId = probeId;
        break;
      }
      // NO_RESULTS / CAPTCHA-resolved-but-empty → keep probing within block
    }

    if (firstHitId) {
      // Promote candidate to a real lane.
      const hitNumeric = parseTicketIdOrThrow(firstHitId).numeric;
      const nextCursorId = formatLike(candidateBlockStartId, hitNumeric + 1);

      const lane = createLane(candidateBlockStartId, nextCursorId);
      if (firstHitTicket) {
        await saveFoundTicket(firstHitTicket);
        lane.lastFoundId = firstHitTicket.ticketId;
        lane.lastFoundAt = new Date();
      }
      await persistLane(lane);
      lanes.set(lane.blockStartId, lane);

      console.log(
        `✨ New lane discovered: ${candidateBlockStartId} (first hit ${firstHitId}, cursor=${nextCursorId})`,
      );
      // Stop after discovering one new lane per sweep so we don't burn too
      // many requests speculating — the next sweep will find the next one.
      break;
    }

    console.log(`💤 No activity in candidate block ${candidateBlockStartId}`);
  }

  await setLastDiscoveryAt(new Date());
};

export const startTicketWatcher = async (): Promise<void> => {
  await bootstrapLanes();
  const lanes = await loadLanes();
  console.log(`🎯 Loaded ${lanes.size} lane(s): ${[...lanes.keys()].join(', ')}`);

  let { browser, page } = await createPage();

  // Prevent a restart-flood: clamp any lane whose nextDueAt is far in the past
  // so we don't fire every lane simultaneously right after boot.
  const bootTime = Date.now();
  for (const lane of lanes.values()) {
    if (lane.status === 'active' && lane.nextDueAt.getTime() < bootTime) {
      lane.nextDueAt = new Date(bootTime);
    }
  }

  while (true) {
    try {
      await waitForActiveHours();

      // Periodic discovery sweep
      const lastDiscoveryAt = await getLastDiscoveryAt();
      if (shouldRunDiscovery(lastDiscoveryAt)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        await runDiscovery(lanes, page);
      }

      const lane = pickNextLane(lanes);
      if (!lane) {
        console.log('⚠️  No active lanes — running discovery and waiting...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        await runDiscovery(lanes, page);
        // If still nothing, sleep until the next discovery interval.
        if (pickNextLane(lanes) == null) {
          await sleep(Math.min(60_000, Math.max(10_000, 30_000)));
          continue;
        }
        continue;
      }

      const waitMs = msUntilDue(lane);
      if (waitMs > 0) {
        // Sleep in chunks so we can re-check active hours & discovery regularly.
        const chunk = Math.min(waitMs, 30_000);
        await sleep(chunk);
        continue;
      }

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      await pollLane(lane, page);

      // Small inter-poll buffer — politeness.
      await sleep(2000);
    } catch (err) {
      if (err instanceof CaptchaExhaustedError) {
        console.warn('🔄 CAPTCHA exhausted — waiting 1 minute then restarting browser...');
        await updateScraperState({ status: 'captcha_backoff' });
        await sleep(60_000);

        console.log('🔒 Closing old browser...');
        await browser.close().catch(() => {});

        ({ browser, page } = await createPage());
      } else {
        console.error('Error in ticket watcher loop:', err);
        await updateScraperState({ status: 'error' });
        await sleep(5000);
      }
    }
  }
};
