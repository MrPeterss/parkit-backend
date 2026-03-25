import 'dotenv/config';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// Test 1: can we get an OAuth2 access token from the service account?
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT!;
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'));

const credential = admin.credential.cert(serviceAccount);
console.log('⏳ Requesting OAuth2 access token from Google...');
try {
  const token = await credential.getAccessToken();
  console.log('✅ Got access token:', token.access_token.slice(0, 20) + '...');
  console.log('   Expires:', new Date(token.expires_in * 1000).toISOString());
} catch (err) {
  console.error('❌ Failed to get access token:', err);
  process.exit(1);
}

// Test 2: emit the ticket
import { emitNewTicket } from './services/notificationService.js';

const fakeTicket = {
  ticketId: 'TEST-001',
  licensePlateNumber: 'ABC1234',
  licensePlateState: 'NY',
  streetLocation: 'LINDEN AVE',
  lat: 42.4440,
  lng: -76.5021,
  timestamp: new Date(),
};

console.log('\n📤 Emitting test ticket for LINDEN AVE...');
await emitNewTicket(fakeTicket);
console.log('✅ Done');
