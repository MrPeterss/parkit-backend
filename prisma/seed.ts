import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Seed function for ticket scraper database
async function main() {
  console.log('Starting seed...');

  // Initialize scraper state if it doesn't exist
  const existingState = await prisma.scraperState.findUnique({
    where: { id: 1 },
  });

  if (!existingState) {
    await prisma.scraperState.create({
      data: {
        id: 1,
        lastCheckedId: '100000057470',
        status: 'initialized',
      },
    });
    console.log('✓ Initialized scraper state');
  } else {
    console.log('✓ Scraper state already exists');
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
