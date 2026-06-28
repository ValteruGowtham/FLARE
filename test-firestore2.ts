import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

let projectId = 'glass-geography-f4dh4';
if (getApps().length === 0) {
  initializeApp({ projectId });
}

async function test() {
  try {
    const db = getFirestore(undefined, 'ai-studio');
    const doc = await db.collection('user_tokens').doc('test').get();
    console.log("Success with ai-studio:", doc.exists);
  } catch (e) {
    console.error("Error with ai-studio:", e);
  }
}
test();
