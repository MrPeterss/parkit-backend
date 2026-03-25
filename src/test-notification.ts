import 'dotenv/config';
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

console.log('📤 Emitting test ticket for LINDEN AVE...');
await emitNewTicket(fakeTicket);
console.log('✅ Done');
