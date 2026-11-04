import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'package.json'));

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

let _db: any = null;
let _auth: any = null;
let _initialized = false;

function ensureInitialized() {
  if (!_initialized) {
    const { initializeApp, getApps } = nodeRequire('firebase-admin/app');
    const { getFirestore } = nodeRequire('firebase-admin/firestore');
    const { getAuth } = nodeRequire('firebase-admin/auth');

    if (getApps().length === 0) {
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
    _db = getFirestore(getApps()[0], databaseId);
    _auth = getAuth();
    _initialized = true;
  }
}

export const dbAdmin = new Proxy({} as any, {
  get(_, prop) {
    ensureInitialized();
    const val = _db[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  }
});

export const authAdmin = new Proxy({} as any, {
  get(_, prop) {
    ensureInitialized();
    const val = _auth[prop];
    return typeof val === 'function' ? val.bind(_auth) : val;
  }
});


