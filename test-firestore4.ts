import { Firestore } from '@google-cloud/firestore';

async function test() {
  try {
    const db = new Firestore({
      projectId: 'glass-geography-f4dh4',
      databaseId: 'ai-studio-flare-0d63219b-d0b7-45a5-94ac-a68feae5201a'
    });
    const doc = await db.collection('user_tokens').doc('test').get();
    console.log("Success with Firestore:", doc.exists);
  } catch (e) {
    console.error("Error with Firestore:", e);
  }
}
test();
