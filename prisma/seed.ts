import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Seed admin users from ADMIN_EMAILS environment variable
async function main() {
  console.log('Starting seed...');

  const adminEmailsEnv = process.env.ADMIN_EMAILS || '';
  const adminEmails = adminEmailsEnv
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);

  if (adminEmails.length === 0) {
    console.log('No admin emails found in ADMIN_EMAILS environment variable.');
    console.log('Skipping admin user seeding.');
    return;
  }

  console.log(`Found ${adminEmails.length} admin email(s) to seed.`);

  for (const email of adminEmails) {
    try {
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        // Make sure the existing user is an admin
        if (existingUser.isAdmin !== true) {
          await prisma.user.update({
            where: { email },
            data: { isAdmin: true },
          });
          console.log(`✓ Updated user to admin: ${email} (ID: ${existingUser.id})`);
        } else {
          console.log(`✓ Admin user already exists: ${email} (ID: ${existingUser.id})`);
        }
        continue;
      }

      const user = await prisma.user.create({
        data: {
          email,
          isAdmin: true,
          // name, firebaseId, refreshToken, and teamId are null until the user logs in
        },
      });

      console.log(`✓ Created admin user: ${email} (ID: ${user.id})`);
    } catch (error) {
      console.error(`✗ Failed to create admin user ${email}:`, error);
    }
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
