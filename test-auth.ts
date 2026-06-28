import { authAdmin } from './server/firebaseAdmin.js';
async function test() {
  try {
    const token = await authAdmin.createCustomToken('test');
    console.log("Success, token:", token.substring(0, 20) + "...");
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
