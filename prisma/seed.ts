import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const BLOCK_SIZE = 500;

const parseTicketId = (ticketId: string) => {
  const match = /^([A-Za-z]*)(\d+)$/.exec(ticketId);
  if (!match) throw new Error(`Unparseable ticket ID: ${ticketId}`);
  return {
    prefix: match[1],
    numeric: Number(match[2]),
    width: match[2].length,
  };
};

const formatTicketId = (prefix: string, numeric: number, width: number): string =>
  `${prefix}${numeric.toString().padStart(width, '0')}`;

const blockStartIdOf = (ticketId: string): string => {
  const { prefix, numeric, width } = parseTicketId(ticketId);
  const start = Math.floor((numeric - 1) / BLOCK_SIZE) * BLOCK_SIZE + 1;
  return formatTicketId(prefix, start, width);
};

const blockEndIdOf = (blockStartId: string): string => {
  const { prefix, numeric, width } = parseTicketId(blockStartId);
  return formatTicketId(prefix, numeric + BLOCK_SIZE - 1, width);
};

async function main() {
  console.log('Starting seed...');

  const seedTicketId = process.env.DEFAULT_START_TICKET_ID ?? '100000057470';

  const existingState = await prisma.scraperState.findUnique({
    where: { id: 1 },
  });

  if (!existingState) {
    await prisma.scraperState.create({
      data: {
        id: 1,
        lastCheckedId: seedTicketId,
        status: 'initialized',
      },
    });
    console.log('✓ Initialized scraper state');
  } else {
    console.log('✓ Scraper state already exists');
  }

  const laneCount = await prisma.scraperLane.count();
  if (laneCount === 0) {
    const blockStartId = blockStartIdOf(seedTicketId);
    const blockEndId = blockEndIdOf(blockStartId);

    await prisma.scraperLane.create({
      data: {
        blockStartId,
        blockEndId,
        nextCursorId: seedTicketId,
        status: 'active',
      },
    });
    console.log(`✓ Seeded initial lane ${blockStartId} (cursor=${seedTicketId})`);
  } else {
    console.log(`✓ ScraperLane already populated (${laneCount} lane(s))`);
  }

  console.log('Seed completed!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
