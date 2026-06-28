import fs from 'fs';
import path from 'path';

async function test() {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8'));
  const projectId = config.projectId;
  const databaseId = config.firestoreDatabaseId;

  // We need a Firebase ID Token to test.
  // Wait, I can't easily get a Firebase ID Token without a client.
  console.log("REST API URL:", `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/user_tokens/test`);
}
test();
