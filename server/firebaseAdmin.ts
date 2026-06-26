import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';

let projectId = 'glass-geography-f4dh4';
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    projectId = config.projectId || projectId;
  }
} catch (err) {
  console.error('Failed to read firebase config in admin initialization:', err);
}

if (getApps().length === 0) {
  initializeApp({
    projectId
  });
}

export const dbAdmin = getFirestore();
export const authAdmin = getAuth();

