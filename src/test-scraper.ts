import 'dotenv/config';

import { startTicketWatcher } from './worker/ticketScraper.js';


startTicketWatcher().catch(console.error);

