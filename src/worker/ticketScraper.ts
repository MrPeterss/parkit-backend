import { chromium } from 'playwright-extra';
import type { Page } from 'playwright';
import { Solver } from '@2captcha/captcha-solver';

import { prisma } from '../prisma.js';
import { extractGpsFromImageUrl } from '../services/ocrService.js';
import { BACKOFF_LIST, TicketMessage, TicketSearchResult, type TicketSearchResponse } from '../tickets/types.js';
import type { Ticket } from '@prisma/client';

const solver = new Solver(process.env.TWOCAPTCHA_API_KEY ?? '');

const TICKET_PORTAL_URL =
  'https://www.tocite.net/cityofithaca/portal/ticket' as const;

const DEFAULT_START_TICKET_ID = '100000057470';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }
);

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

const getOrCreateScraperState = async () => {
  let state = await prisma.scraperState.findUnique({
    where: { id: 1 },
  });

  if (!state) {
    state = await prisma.scraperState.create({
      data: {
        id: 1,
        lastCheckedId:
          DEFAULT_START_TICKET_ID,
        status: 'initialized',
      },
    });
  }

  return state;
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
  await page.waitForTimeout(500);

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
  await page.waitForTimeout(500);
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

const solveCaptcha = async (page: Page): Promise<boolean> => {
  try {
    console.log('🔐 Attempting to solve CAPTCHA...');
    const googleKey = await page.$('div.g-recaptcha');
    const googleKeyText = await googleKey?.getAttribute('data-sitekey');
    if (!googleKeyText) {
      console.log('⚠️  Google key not found');
      return false;
    }

    console.log('🔐 Google key found:', googleKeyText);

    // submit with the google key and url
    const solution = await solver.recaptcha({
      googlekey: googleKeyText, 
      pageurl: page.url(),
    });
    
    if (!solution) {
      console.log('⚠️  CAPTCHA solving not available or failed');
      return false;
    }

    console.log('✅ CAPTCHA solved successfully!');

    console.log('SOLUTION:', solution.data);
    
    // put the solution into the hidden textarea
    await page.evaluate((solution) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea#g-recaptcha-response');
      if (textarea) {
        console.log('TEXT AREA EXISTS');
        textarea.innerHTML = solution;
      }
      (window as any).validateCaptcha(solution);
    }, solution.data);

    
    console.log('✅ CAPTCHA response injected into page');
    return true;
  } catch (error) {
    console.error('❌ Error solving CAPTCHA:', error);
    return false;
  }
};

export const searchForTicket = async (page: Page, ticketId: string): Promise<TicketSearchResponse> => {
  console.log('📝 Submitting search...');
  await submitTicketSearch(page, ticketId);

  let searchResponse = await getTicketSearchResponse(ticketId, page);

  // Handle CAPTCHA and FAILED_CHALLENGE - try to solve it automatically, otherwise retry
  let captchaAttempts = 0;
  const maxCaptchaAttempts = 5;
  
  while ((searchResponse.result === TicketSearchResult.CAPTCHA || searchResponse.result === TicketSearchResult.FAILED_CHALLENGE) && captchaAttempts < maxCaptchaAttempts) {
    captchaAttempts++;
    
    if (searchResponse.result === TicketSearchResult.FAILED_CHALLENGE) {
      console.log(`🚫 FAILED_CHALLENGE detected (attempt ${captchaAttempts}/${maxCaptchaAttempts}), reloading...`);
      // Reload immediately for failed challenges
      await page.reload({ 
        waitUntil: 'domcontentloaded',
        timeout: 5000 
      });
      await page.waitForTimeout(1000);
      
      await submitTicketSearch(page, ticketId);
      searchResponse = await getTicketSearchResponse(ticketId, page);
      console.log(`✅ Search result after reload: ${searchResponse.result}`);
      continue;
    }
    
    console.log(`🤖 CAPTCHA detected (attempt ${captchaAttempts}/${maxCaptchaAttempts})...`);
    
    // Try to solve CAPTCHA automatically if 2Captcha is configured
    if (process.env.TWOCAPTCHA_API_KEY) {
      const solved = await solveCaptcha(page);
      
      if (solved) {        
        // Try submitting the search again
        await submitTicketSearch(page, ticketId);
        searchResponse = await getTicketSearchResponse(ticketId, page);
        
        if (searchResponse.result !== TicketSearchResult.CAPTCHA && searchResponse.result !== TicketSearchResult.FAILED_CHALLENGE) {
          console.log(`✅ Search successful after solving CAPTCHA: ${searchResponse.result}`);
          break;
        }
      }
    }
    
    // If CAPTCHA solving failed or not configured, reload and retry
    console.log('🔄 Reloading page and retrying...');
    await page.reload({ 
      waitUntil: 'domcontentloaded',
      timeout: 5000 
    });
    await page.waitForTimeout(1000);
    
    await submitTicketSearch(page, ticketId);
    searchResponse = await getTicketSearchResponse(ticketId, page);
    console.log(`✅ Search result after retry: ${searchResponse.result}`);
  }

  if (captchaAttempts >= maxCaptchaAttempts && (searchResponse.result === TicketSearchResult.CAPTCHA || searchResponse.result === TicketSearchResult.FAILED_CHALLENGE)) {
    console.log('⚠️  Max CAPTCHA/Challenge attempts reached, moving on...');
  }

  return searchResponse;
}

export const startTicketWatcher = async (): Promise<void> => {
  const state = await getOrCreateScraperState();
  let currentTicketId = state.lastCheckedId;

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext();
  
  const page = await context.newPage();

  console.log('🌐 Navigating to ticket portal...');
  try {
    await page.goto(TICKET_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 5000 
    });
    console.log('✅ Page loaded');
    
    // Wait a bit for any dynamic content
    await page.waitForTimeout(3000);
  } catch (error) {
    console.error('❌ Failed to load page:', error);
    throw error;
  }

  while (true) {
    try {
      // reload page
      await page.reload({ 
        waitUntil: 'domcontentloaded',
        timeout: 5000 
      });

      console.log(`\n🔍 Checking ticket: ${currentTicketId}`);
      
      await updateScraperState({
        status: `checking ${currentTicketId}`,
      });
      
      let backoffNode = BACKOFF_LIST;
      let foundTicket: Ticket | null = null;

      while (true) {
        // find ticket (after reloading for captchas)
        const searchResponse = await searchForTicket(page, currentTicketId);

        console.log('SEARCH RESPONSE:', searchResponse);

        // We aren't waiting for this ticket anymore if its not no results
        if (searchResponse.result !== TicketSearchResult.NO_RESULTS) {
          foundTicket = searchResponse.ticket;
          break;
        }

        console.log(`⏳ Waiting for ${backoffNode.backoff}ms...`);
        // wait for the backoff node
        await sleep(backoffNode.backoff);
        if (backoffNode.next != null) {
          backoffNode = backoffNode.next;
        }
      }

      if (foundTicket == null) {
        console.log('⚠️  Ticket not found, skipping...');
        await updateScraperState({
          status: 'no_results',
        });
        await sleep(2000);
        currentTicketId = incrementTicketId(currentTicketId);
        continue;
      }

      let ticket = await prisma.ticket.findUnique({
        where: {
          ticketId: foundTicket.ticketId
        }
      });
      
      if (ticket) {
        console.log(`ℹ️  Ticket ${foundTicket.ticketId} already exists, skipping creation`);
      } else {
        console.log('💾 Saving to database...');
        ticket = await prisma.ticket.create({
          data: foundTicket,
        });
        console.log(`✅ Saved ticket: ${ticket.ticketId}`);
      }

      await updateScraperState({
        lastCheckedId: currentTicketId,
        status: 'ok',
      });

      // Only emit event if ticket timestamp is within the last 10 minutes
      const now = new Date();
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      
      if (ticket.timestamp >= tenMinutesAgo) {
        // ticketEvents.emitNewTicket(ticket);
        console.log('📡 Broadcasted to SSE clients');
      } else {
        console.log(`⏱️  Ticket timestamp is older than 10 minutes, skipping SSE broadcast`);
      }

      currentTicketId = incrementTicketId(currentTicketId);
      console.log(`➡️  Next ticket: ${currentTicketId}\n`);

      await sleep(2000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in ticket watcher loop:', err);
      await updateScraperState({
        status: 'error',
      });
      await sleep(5000);
    }
  }
};


