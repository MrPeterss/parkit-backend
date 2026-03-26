import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { Solver } from '@2captcha/captcha-solver';

chromium.use(stealth());

import { prisma } from '../prisma.js';
import { extractGpsFromImageUrl } from '../services/ocrService.js';
import { emitNewTicket } from '../services/notificationService.js';
import { BACKOFF_LIST, TicketMessage, TicketSearchResult, type TicketSearchResponse } from '../tickets/types.js';
import type { Ticket } from '@prisma/client';

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

  // Calculate how many minutes until the next weekday 8:30 AM
  let daysUntilMonday = 0;
  if (weekday === 'Sat') daysUntilMonday = 2;
  else if (weekday === 'Sun') daysUntilMonday = 1;

  let minutesUntilStart: number;
  if (daysUntilMonday > 0) {
    // Weekend: wait until Monday 8:30 AM
    minutesUntilStart = daysUntilMonday * 24 * 60 - totalMinutes + startMinutes;
  } else {
    // Weekday but outside hours: wait until today or tomorrow 8:30 AM
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

const incrementTicketId = (ticketId: string): string => {
  // Try to match pattern with optional prefix (letters) and numeric part
  const match = /^([a-zA-Z]*)(\d+)$/.exec(ticketId);
  if (!match) {
    // Fallback: if format is unexpected, just append '1'
    console.warn(`⚠️  Unexpected ticket ID format: ${ticketId}`);
    return `${ticketId}1`;
  }

  const prefix = match[1];
  const numeric = match[2];
  const width = numeric.length;
  const nextNum = parseInt(numeric, 10) + 1;
  const nextNumStr = nextNum.toString().padStart(width, '0');
  
  return `${prefix}${nextNumStr}`;
};

const getNumericPart = (ticketId: string): number => {
  const match = /(\d+)$/.exec(ticketId);
  return match ? parseInt(match[1], 10) : 0;
};

const getStartTicketId = async (): Promise<string> => {
  const envDefault = process.env.DEFAULT_START_TICKET_ID;

  const highestTicket = await prisma.ticket.findFirst({
    orderBy: { ticketId: 'desc' },
    select: { ticketId: true },
  });

  const candidates: string[] = [];
  if (envDefault) candidates.push(envDefault);
  if (highestTicket) candidates.push(highestTicket.ticketId);

  if (candidates.length === 0) {
    throw new Error('No DEFAULT_START_TICKET_ID env var set and no tickets in the database.');
  }

  const best = candidates.reduce((a, b) =>
    getNumericPart(a) >= getNumericPart(b) ? a : b
  );

  console.log(`🎯 Starting from ticket ID: ${best} (env=${envDefault ?? 'unset'}, db=${highestTicket?.ticketId ?? 'none'})`);
  return best;
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
  // Wait for 1 second
  await sleep(1000);
  // Use the correct input ID
  const inputSelector = '#ticket-number-search';

  // click the back button, button with aria-label "Back", if it exists
  if (await page.isVisible('button[aria-label="Back"]')) {
    await page.click('button[aria-label="Back"]');
  }
  
  // Wait for input to be visible and enabled
  await page.waitForSelector(inputSelector, { 
    timeout: 5000,
    state: 'visible' 
  });
  
  // Click to focus the input first
  await page.click(inputSelector);
  
  // Clear any existing value
  await page.fill(inputSelector, '');
  
  // Type the ticket ID with a small delay between keystrokes
  await page.type(inputSelector, ticketId, { delay: 50 });
  
  // Wait a moment for any JavaScript handlers
  await sleep(500);

  // Find and click the search button
  const searchButtonSelector =
    'button[type="submit"], button:has-text("Search"), button:has-text("Lookup")';

  await page.click(searchButtonSelector);
  
  // Wait for loading spinner to disappear
  await page.waitForSelector('div.loading-spinner-text', { state: 'hidden' });
  
  // Wait for either search messages or ticket card to appear
  console.log('⏳ Waiting for search results...');
  try {
    await Promise.race([
      // Wait for captcha to appear
      page.waitForSelector('#ticket-search-captcha', { timeout: 10000 }).then(() => {
        console.log('🔍 CAPTCHA element appeared');
      }),
      // Wait for search messages to have content
      page.waitForSelector('div#ticket-search-messages > div.alert', { timeout: 10000 }).then(() => {
        console.log('🔍 Search messages alert appeared');
      }),
      // Wait for ticket card to appear
      page.waitForSelector(`div#ticket-results > div.result-container`, { timeout: 10000 }).then(() => {
        console.log('🔍 Ticket card appeared');
      }),
    ]);
    console.log('✅ Search results loaded');
  } catch (error) {
    console.log('⚠️  Timeout waiting for results, continuing anyway...');
  }
  
  // Small buffer for any final rendering
  await sleep(500);
};


const getTicketDetails = async (ticketId: string, page: Page): Promise<Ticket | null> => {
  // wait for card to appear
  const card = await page.$(`div.card.ticket-card[data-citationnumber='${ticketId}']`);
  if (!card) return null;

  // find div with "card-header" class and only button element inside that
  const cardHeader = await card.$('div.card-header button');
  console.log("card header is there?", cardHeader != null ? "yes" : "no");
  if (!cardHeader) return null;
  
  // third element is span with the timestamp inside
  const timestamp = await cardHeader.$('span:nth-child(3)')
  const timestampText = await timestamp?.textContent();
  // is in format "12/15/2025 10:38 AM"
  const timestampDate = new Date(timestampText ?? '');

  const ticketCardInfo = await card.$('div.ticket-card-info')

  // find liscence plate number
  const licensePlate = await ticketCardInfo?.$('span#LicenseNoState')
  const licensePlateText = (await licensePlate?.textContent())?.trim();

  // find license plate state
  const licensePlateState = await ticketCardInfo?.$('span#LicenseState')
  const licensePlateStateText = (await licensePlateState?.textContent())?.trim();

  // figure out the lat and lng from the license image (first child of div with class carousel-inner)
  const evidenceImage = await card.$('div.carousel-inner > div:first-child > img');
  const evidenceUrl = await evidenceImage?.getAttribute('src');
  const ocrResult = await extractGpsFromImageUrl(evidenceUrl ?? null);

  // Find backup location, from span with id ViolationLocation
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

    // Results appear automatically after validateCaptcha — wait for them
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

export const startTicketWatcher = async (): Promise<void> => {
  let currentTicketId = await getStartTicketId();
  let { browser, page } = await createPage();

  while (true) {
    try {
      await waitForActiveHours();

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 });

      console.log(`\n🔍 Checking ticket: ${currentTicketId}`);
      await updateScraperState({ status: `checking ${currentTicketId}` });

      let backoffNode = BACKOFF_LIST;
      let foundTicket: Ticket | null = null;

      while (true) {
        await waitForActiveHours();

        const searchResponse = await searchForTicket(page, currentTicketId);
        console.log('SEARCH RESPONSE:', searchResponse);

        if (searchResponse.result !== TicketSearchResult.NO_RESULTS) {
          foundTicket = searchResponse.ticket;
          break;
        }

        console.log(`⏳ Waiting for ${backoffNode.backoff}ms...`);
        await sleep(backoffNode.backoff);
        if (backoffNode.next != null) {
          backoffNode = backoffNode.next;
        }
      }

      if (foundTicket == null) {
        console.log('⚠️  Ticket not accessible, skipping...');
        await updateScraperState({ status: 'no_results' });
        await sleep(2000);
        currentTicketId = incrementTicketId(currentTicketId);
        continue;
      }

      let ticket = await prisma.ticket.findUnique({ where: { ticketId: foundTicket.ticketId } });

      if (ticket) {
        console.log(`ℹ️  Ticket ${foundTicket.ticketId} already exists, skipping creation`);
      } else {
        console.log('💾 Saving to database...');
        ticket = await prisma.ticket.create({ data: foundTicket });
        console.log(`✅ Saved ticket: ${ticket.ticketId}`);
      }

      await updateScraperState({ lastCheckedId: currentTicketId, status: 'ok' });

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (ticket.timestamp >= tenMinutesAgo) {
        void emitNewTicket(ticket);
      } else {
        console.log(`⏱️  Ticket is older than 10 minutes, skipping notification`);
      }

      currentTicketId = incrementTicketId(currentTicketId);
      console.log(`➡️  Next ticket: ${currentTicketId}\n`);
      await sleep(2000);

    } catch (err) {
      if (err instanceof CaptchaExhaustedError) {
        console.warn('🔄 CAPTCHA exhausted — waiting 1 minute then restarting browser...');
        await updateScraperState({ status: 'captcha_backoff' });
        await sleep(60000);

        console.log('🔒 Closing old browser...');
        await browser.close().catch(() => {});

        ({ browser, page } = await createPage());
        console.log(`↩️  Retrying ticket: ${currentTicketId}`);
        // Do NOT increment currentTicketId — retry the same ticket
      } else {
        console.error('Error in ticket watcher loop:', err);
        await updateScraperState({ status: 'error' });
        await sleep(5000);
      }
    }
  }
};


