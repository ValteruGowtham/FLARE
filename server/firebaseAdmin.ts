import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';

let projectId = 'glass-geography-f4dh4';
let databaseId: string | undefined = undefined;

try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    projectId = config.projectId || projectId;
    databaseId = config.firestoreDatabaseId;
  }
} catch (err) {
  console.error('Failed to read firebase config in admin initialization:', err);
}

if (getApps().length === 0) {
  // Initializes using Application Default Credentials (ADC).
  // Locally: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
  //          OR run: gcloud auth application-default login
  // On GCP / Cloud Run: ADC is automatically provided via the runtime service account.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.NODE_ENV !== 'production') {
    console.warn(
      '[Firebase Admin] WARNING: GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
      '  Server-side features (auth verification, Firestore Admin, cron sweep) will fail locally.\n' +
      '  Fix: Set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON path,\n' +
      '       or run `gcloud auth application-default login`.'
    );
  }
  initializeApp({
    projectId
  });
}

export const dbAdmin = getFirestore(getApps()[0], databaseId);
export const authAdmin = getAuth();


