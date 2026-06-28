import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
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
  console.error('Failed to read firebase config:', err);
}

if (getApps().length === 0) {
  initializeApp({ projectId });
}

async function test() {
  try {
    const db = getFirestore(getApp(), databaseId);
    const doc = await db.collection('user_tokens').doc('test').get();
    console.log("Success with databaseId:", doc.exists);
  } catch (e) {
    console.error("Error with databaseId:", e);
  }
}
test();
