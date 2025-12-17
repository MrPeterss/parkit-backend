import 'dotenv/config';

import { chromium } from 'playwright';

import { prisma } from './prisma.js';

const TICKET_PORTAL_URL = 'https://www.tocite.net/cityofithaca/portal/ticket';
const DEFAULT_START_TICKET_ID = '100000057480';

async function openBrowser() {
  console.log('🚀 Opening browser...\n');

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🌐 Navigating to ticket portal...');
  try {
    await page.goto(TICKET_PORTAL_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });
    console.log('✅ Page loaded');

    // Wait a bit for any dynamic content
    await page.waitForTimeout(3000);
  } catch (error) {
    console.error('❌ Failed to load page:', error);
    throw error;
  }

  // Get the starting ticket ID
  let state = await prisma.scraperState.findUnique({
    where: { id: 1 },
  });

  if (!state) {
    state = await prisma.scraperState.create({
      data: {
        id: 1,
        lastCheckedId: DEFAULT_START_TICKET_ID,
        status: 'initialized',
      },
    });
  }

  const currentTicketId = state.lastCheckedId;
  console.log(`\n🎫 Starting ticket ID: ${currentTicketId}\n`);

  // Perform the search
  console.log('🔍 Looking for ticket input field...');
  const inputSelector = '#ticket-number-search';

  await page.waitForSelector(inputSelector, {
    timeout: 5000,
    state: 'visible',
  });
  console.log('✅ Found input field');

  // Click to focus the input first
  console.log('🖱️  Clicking input field...');
  await page.click(inputSelector);

  // Clear any existing value
  await page.fill(inputSelector, '');

  // Type the ticket ID with a small delay between keystrokes
  console.log(`⌨️  Typing ticket ID: ${currentTicketId}...`);
  await page.type(inputSelector, currentTicketId, { delay: 50 });

  // Wait a moment for any JavaScript handlers
  await page.waitForTimeout(500);

  // Find and click the search button
  console.log('🔘 Looking for search button...');
  const searchButtonSelector =
    'button[type="submit"], button:has-text("Search"), button:has-text("Lookup")';

  console.log('🖱️  Clicking search button...');
  await page.click(searchButtonSelector);

  // Wait for navigation or content to load
  console.log('⏳ Waiting for results...');
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  } catch (error) {
    console.log('⚠️  Page load timeout, continuing anyway...');
  }

  // Give time for dynamic content to load
  await page.waitForTimeout(2000);

  console.log('\n✅ Search completed!\n');
  console.log('💡 Browser will stay open. Press Ctrl+C to exit (browser will stay open).\n');
  console.log('🔍 You can now inspect the page and test selectors in the browser console.\n');

  // Disconnect from database
  await prisma.$disconnect();

  // Keep the script running
  await new Promise(() => {
    // Never resolves - keeps script alive
  });
}

openBrowser().catch(console.error);

