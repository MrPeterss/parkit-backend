# Real-Time Ticket Tracker Backend

A Node.js + Express + PostgreSQL/SQLite backend that scrapes parking tickets from a public portal, extracts GPS coordinates via OCR, and streams updates to clients via Server-Sent Events (SSE).

## Features

- **Automated Ticket Scraping**: Playwright-based headless browser worker that continuously checks for new tickets
- **OCR GPS Extraction**: Extracts latitude/longitude from ticket evidence photos using Tesseract.js
- **Real-Time Streaming**: Server-Sent Events (SSE) stream new tickets to connected clients
- **REST API**: Query recent tickets (last 24 hours)
- **Persistent State**: Tracks last checked ticket ID and scraper status in database

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: SQLite (via Prisma ORM)
- **Web Scraping**: Playwright (headless Chromium)
- **OCR**: Tesseract.js + Sharp (image processing)
- **Real-Time**: Server-Sent Events (SSE)
- **HTTP Client**: Axios

## Project Structure

```
src/
├── events/
│   └── ticketEvents.ts    # Event emitter for new tickets
├── middleware/
│   ├── errorHandler.ts    # Global error handling
│   └── logger.ts          # Request logging
├── routes/
│   └── ticketRoutes.ts    # GET /tickets/recent + /stream
├── services/
│   └── ocrService.ts      # OCR + GPS extraction from images
├── utils/
│   └── AppError.ts        # Custom error class
├── worker/
│   └── ticketScraper.ts   # Background ticket watcher
├── prisma.ts              # Prisma client singleton
└── server.ts              # Express server setup
```

## Installation

### 1. Install Dependencies

```bash
npm install
```

Required packages:

- `express`, `dotenv`, `helmet`, `cookie-parser`
- `prisma`, `@prisma/client`
- `playwright`, `tesseract.js`, `sharp`, `axios`

### 2. Environment Configuration

Create a `.env` file:

```env
# Server
PORT=8000
NODE_ENV=development

# Database
DATABASE_URL="file:./prisma/data/sqlite.db"

# Optional: OCR Debug
TESSERACT_DEBUG=false

# Optional: Prisma Logging
PRISMA_LOG_QUERIES=true
PRISMA_LOG_ERRORS=true
PRISMA_LOG_WARNINGS=true

# Optional: 2Captcha API Key for automatic CAPTCHA solving
# Get your API key from: https://2captcha.com/
TWOCAPTCHA_API_KEY=your_api_key_here
```

### 3. Database Setup

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev --name init

# (Optional) View database in Prisma Studio
npx prisma studio
```

### 4. Install Playwright Browsers

```bash
npx playwright install chromium
```

### 5. CAPTCHA Solving (Optional)

The scraper includes automatic CAPTCHA solving using 2Captcha service. To enable:

1. **Sign up for 2Captcha**: Visit [https://2captcha.com/](https://2captcha.com/) and create an account
2. **Get API Key**: Purchase credits and copy your API key from the dashboard
3. **Add to `.env`**: 
   ```env
   TWOCAPTCHA_API_KEY=your_api_key_here
   ```

**How it works:**
- When a CAPTCHA is detected, the scraper automatically sends it to 2Captcha
- 2Captcha workers solve the CAPTCHA (usually takes 10-30 seconds)
- The solution is automatically submitted
- If solving fails, the scraper falls back to reloading and retrying

**Cost:** ~$2-3 per 1000 CAPTCHAs solved

**Without 2Captcha:**
- The scraper will still work but will reload and retry when CAPTCHAs appear
- This may be slower and less reliable

## Running the Application

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## API Endpoints

### Health Check

```bash
GET /health
```

Response:

```json
{
  "status": "healthy",
  "timestamp": "2025-12-15T10:30:00.000Z",
  "uptime": 123.456,
  "environment": "development",
  "database": "connected"
}
```

### Get Recent Tickets

```bash
GET /tickets/recent
```

Returns all tickets found in the last 24 hours:

```json
[
  {
    "id": 1,
    "ticketId": "cab2984",
    "rawText": "Lat: 42.4440 Lng: -76.5019",
    "lat": 42.444,
    "lng": -76.5019,
    "timestamp": "2025-12-15T10:25:00.000Z"
  }
]
```

## Real-Time Streaming

### Stream New Tickets (SSE)

```bash
GET /tickets/stream
```

Opens a Server-Sent Events connection that streams new tickets as they are found:

**JavaScript Client Example:**

```javascript
const eventSource = new EventSource('http://localhost:8000/tickets/stream');

eventSource.onopen = () => {
  console.log('Connected to ticket stream');
};

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'connected') {
    console.log('Stream connection established');
  } else {
    // New ticket received
    console.log('New ticket:', data);
    // { id, ticketId, rawText, lat, lng, timestamp }
  }
};

eventSource.onerror = (error) => {
  console.error('Stream error:', error);
  eventSource.close();
};
```

**cURL Example:**

```bash
curl -N http://localhost:8000/tickets/stream
```

## Database Schema

### Ticket

| Field     | Type     | Description                          |
| --------- | -------- | ------------------------------------ |
| id        | Int      | Primary key (auto-increment)         |
| ticketId  | String   | Unique ticket ID (e.g., "cab2984")   |
| rawText   | String   | Raw OCR text from evidence photo     |
| lat       | Float    | Latitude extracted from photo        |
| lng       | Float    | Longitude extracted from photo       |
| timestamp | DateTime | When ticket was found (default: now) |

### ScraperState

| Field         | Type   | Description                     |
| ------------- | ------ | ------------------------------- |
| id            | Int    | Primary key (always 1)          |
| lastCheckedId | String | Last ticket ID that was checked |
| status        | String | Current scraper status          |

## How It Works

1. **Worker Startup**: On server start, `startTicketWatcher()` launches a headless Chromium browser
2. **Ticket Search**: Worker navigates to the ticket portal and searches for the current ticket ID
3. **Result Handling**:
   - **Found**: Extracts timestamp from card header → Evidence photo URL → OCR → Save to DB → Emit event → Increment ID
   - **Not Found**: Enters backoff loop (30s, 60s, 5m) until ticket appears
4. **Timestamp Extraction**: Parses the issue date/time from the ticket card header (format: "MM/DD/YYYY HH:MM AM/PM")
5. **OCR Processing**: Downloads image → Crops top 60px → Grayscale + Threshold → Tesseract OCR → Regex extract `Lat: X Lng: Y`
6. **Real-Time Broadcast**: EventEmitter notifies all SSE clients of new ticket

## Customization

### Adjust Scraper Delays

Edit `src/worker/ticketScraper.ts`:

```typescript
// After successful ticket processing
await sleep(2000); // 2 seconds between checks

// Backoff durations when ticket not found
const backoffDurations = [30_000, 60_000, 300_000]; // 30s, 60s, 5m
```

### Change OCR Crop Area

Edit `src/services/ocrService.ts`:

```typescript
.extract({
  left: 0,
  top: 0,
  width: metadata.width,
  height: Math.min(60, metadata.height), // Adjust height here
})
```

### Modify Ticket ID Format

Edit `incrementTicketId()` in `src/worker/ticketScraper.ts` to match your ticket ID pattern.

## Troubleshooting

### Playwright Browser Not Found

```bash
npx playwright install chromium
```

### OCR Not Extracting Coordinates

- Enable debug logging: `TESSERACT_DEBUG=true` in `.env`
- Check that evidence photo URL selector is correct in `findEvidencePhotoUrl()`
- Adjust crop height or threshold settings in `ocrService.ts`

### SSE Connection Issues

If you need to restrict CORS for the SSE endpoint, modify the headers in `src/routes/ticketRoutes.ts`:

```typescript
res.setHeader('Access-Control-Allow-Origin', 'https://yourdomain.com');
```

## License

MIT
