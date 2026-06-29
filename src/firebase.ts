import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import config from '../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: config.projectId,
  storageBucket: config.storageBucket,
  messagingSenderId: config.messagingSenderId,
  appId: config.appId,
};

const app = initializeApp(firebaseConfig);

// Initialize Firestore with the custom databaseId from the applet configuration
export const db = getFirestore(app, (config as any).firestoreDatabaseId || '(default)');

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
// Note: Do NOT add calendar/gmail scopes to the Firebase provider here.
// The Firebase-issued access token is tied to Firebase's OAuth client and cannot
// be used with this app's server-side Calendar/Gmail proxy (different GOOGLE_CLIENT_ID).
// Calendar & Gmail tokens are obtained separately via the /api/auth/google/url flow.
