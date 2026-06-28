import { dbAdmin } from './server/firebaseAdmin.js';
async function test() {
  try {
    const doc = await dbAdmin.collection('user_tokens').doc('test').get();
    console.log("Success in app:", doc.exists);
  } catch (e) {
    console.error("Error in app:", e);
  }
}
test();
