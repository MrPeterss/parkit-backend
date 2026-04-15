import type { ServiceAccount } from 'firebase-admin/app';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function initFirebaseAdmin() {
  if (getApps().length > 0) {
    return;
  }

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    initializeApp({
      credential: cert(JSON.parse(json) as ServiceAccount),
    });
    return;
  }

  // Uses GOOGLE_APPLICATION_CREDENTIALS or GCP metadata (e.g. Cloud Run)
  initializeApp({
    credential: applicationDefault(),
  });
}

let initialized = false;

export function getFirebaseAuth() {
  if (!initialized) {
    initFirebaseAdmin();
    initialized = true;
  }
  return getAuth();
}
